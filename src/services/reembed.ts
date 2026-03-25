/**
 * BrainBank — Re-embedding Engine
 * 
 * Regenerates all vectors without re-indexing.
 * Reads existing text from SQLite, embeds with the current provider,
 * and replaces vector BLOBs. No file I/O, no git parsing, no re-chunking.
 * 
 * Usage:
 *   const result = await brain.reembed({ onProgress });
 *   // → { code: 1200, git: 500, docs: 80, kv: 45, notes: 12, total: 1837 }
 */

import type { Database } from '../db/database.ts';
import type { EmbeddingProvider, ProgressCallback } from '../types.ts';
import type { HNSWIndex } from '../providers/vector/hnsw-index.ts';

// ── Table Definitions ───────────────────────────────

interface ReembedTable {
    /** Human-readable name (for progress) */
    name: string;
    /** Table with text content */
    textTable: string;
    /** Table with vector BLOBs */
    vectorTable: string;
    /** PK column in text table */
    idColumn: string;
    /** FK column in vector table */
    fkColumn: string;
    /** Build the embedding text from a row (same logic as each indexer) */
    textBuilder: (row: any) => string;
}

const TABLES: ReembedTable[] = [
    {
        name: 'code',
        textTable: 'code_chunks',
        vectorTable: 'code_vectors',
        idColumn: 'id',
        fkColumn: 'chunk_id',
        textBuilder: (r) => [
            `File: ${r.file_path}`,
            r.name ? `${r.chunk_type}: ${r.name}` : r.chunk_type,
            r.content,
        ].join('\n'),
    },
    {
        name: 'git',
        textTable: 'git_commits',
        vectorTable: 'git_vectors',
        idColumn: 'id',
        fkColumn: 'commit_id',
        // Must match git-engine.ts:119-125 exactly
        textBuilder: (r) => [
            `Commit: ${r.message}`,
            `Author: ${r.author}`,
            `Date: ${r.date}`,
            r.files_json && r.files_json !== '[]'
                ? `Files: ${JSON.parse(r.files_json).join(', ')}`
                : '',
            r.diff ? `Changes:\n${r.diff.slice(0, 2000)}` : '',
        ].filter(Boolean).join('\n'),
    },
    {
        name: 'memory',
        textTable: 'memory_patterns',
        vectorTable: 'memory_vectors',
        idColumn: 'id',
        fkColumn: 'pattern_id',
        // Must match memory/pattern-store.ts:49 exactly
        textBuilder: (r) => `${r.task_type} ${r.task} ${r.approach}`,
    },
    {
        name: 'notes',
        textTable: 'note_memories',
        vectorTable: 'note_vectors',
        idColumn: 'id',
        fkColumn: 'note_id',
        // Must match notes/engine.ts:90 exactly
        textBuilder: (r) => {
            const decisions = (JSON.parse(r.decisions_json || '[]') as string[]).join('. ');
            const patterns  = (JSON.parse(r.patterns_json  || '[]') as string[]).join('. ');
            return `${r.title}\n${r.summary}\n${decisions}\n${patterns}`;
        },
    },
    {
        name: 'docs',
        textTable: 'doc_chunks',
        vectorTable: 'doc_vectors',
        idColumn: 'id',
        fkColumn: 'chunk_id',
        // Must match docs-engine.ts:160 exactly
        textBuilder: (r) => `title: ${r.title ?? ''} | text: ${r.content}`,
    },
    {
        name: 'kv',
        textTable: 'kv_data',
        vectorTable: 'kv_vectors',
        idColumn: 'id',
        fkColumn: 'data_id',
        textBuilder: (r) => r.content,
    },
];

// ── Result ──────────────────────────────────────────

export interface ReembedResult {
    code: number;
    git: number;
    memory: number;
    notes: number;
    docs: number;
    kv: number;
    total: number;
}

export interface ReembedOptions {
    /** Progress callback: (tableName, current, total) */
    onProgress?: ProgressCallback;
    /** Batch size for embedBatch. Default: 50 */
    batchSize?: number;
}

// ── Engine ──────────────────────────────────────────

/**
 * Re-embed all existing text with the current embedding provider.
 * Does NOT re-parse files, git, or documents — only replaces vectors.
 */
export async function reembedAll(
    db: Database,
    embedding: EmbeddingProvider,
    hnswMap: Map<string, { hnsw: HNSWIndex; vecs: Map<number, Float32Array> }>,
    options: ReembedOptions = {},
): Promise<ReembedResult> {
    const { batchSize = 50, onProgress } = options;
    const result: Record<string, number> = {};
    let total = 0;

    for (const table of TABLES) {
        const count = await reembedTable(db, embedding, table, batchSize, onProgress);
        result[table.name] = count;
        total += count;

        // Rebuild HNSW if available
        const entry = hnswMap.get(table.name);
        if (entry && count > 0) {
            await rebuildHnsw(db, table, entry.hnsw, entry.vecs);
        }
    }

    // Update embedding metadata
    const meta = {
        provider: embedding.constructor?.name ?? 'unknown',
        dims: String(embedding.dims),
        reembedded_at: new Date().toISOString(),
    };
    const upsert = db.prepare(
        'INSERT OR REPLACE INTO embedding_meta (key, value) VALUES (?, ?)'
    );
    for (const [k, v] of Object.entries(meta)) {
        upsert.run(k, v);
    }

    return {
        code: result.code ?? 0,
        git: result.git ?? 0,
        memory: result.memory ?? 0,
        notes: result.notes ?? 0,
        docs: result.docs ?? 0,
        kv: result.kv ?? 0,
        total,
    };
}

/** Re-embed a single table. Returns count of vectors regenerated. */
async function reembedTable(
    db: Database,
    embedding: EmbeddingProvider,
    table: ReembedTable,
    batchSize: number,
    onProgress?: ProgressCallback,
): Promise<number> {
    // Use pagination to avoid OOM on large tables
    const totalCount = (db.prepare(
        `SELECT COUNT(*) as c FROM ${table.textTable}`
    ).get() as any).c;

    if (totalCount === 0) return 0;

    // Generate ALL new vectors first, before touching the database.
    // This prevents data loss if embedBatch() fails partway through.
    const allNewVectors: { id: number; vec: Float32Array }[] = [];

    let processed = 0;
    for (let offset = 0; offset < totalCount; offset += batchSize) {
        const batch = db.prepare(
            `SELECT * FROM ${table.textTable} LIMIT ? OFFSET ?`
        ).all(batchSize, offset) as any[];
        const texts = batch.map((r: any) => table.textBuilder(r));
        const vectors = await embedding.embedBatch(texts);

        for (let j = 0; j < batch.length; j++) {
            allNewVectors.push({ id: batch[j][table.idColumn], vec: vectors[j] });
        }

        processed += batch.length;
        onProgress?.(table.name, processed, totalCount);
    }

    // All embeddings succeeded — now atomically swap old → new
    const insertVec = db.prepare(
        `INSERT INTO ${table.vectorTable} (${table.fkColumn}, embedding) VALUES (?, ?)`
    );

    db.transaction(() => {
        db.prepare(`DELETE FROM ${table.vectorTable}`).run();
        for (const { id, vec } of allNewVectors) {
            insertVec.run(id, Buffer.from(vec.buffer));
        }
    });

    return processed;
}

/** Rebuild HNSW index from vector table. */
async function rebuildHnsw(
    db: Database,
    table: ReembedTable,
    hnsw: HNSWIndex,
    vecs: Map<number, Float32Array>,
): Promise<void> {
    // Wipe stale vectors before repopulating
    vecs.clear();
    hnsw.reinit();

    const rows = db.prepare(
        `SELECT ${table.fkColumn} as id, embedding FROM ${table.vectorTable}`
    ).all() as any[];

    for (const row of rows) {
        const buf = Buffer.from(row.embedding);
        const vec = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
        hnsw.add(vec, row.id);
        vecs.set(row.id, vec);
    }
}

// ── Provider Detection ──────────────────────────────

/** Get stored embedding metadata. Returns null if not set. */
export function getEmbeddingMeta(db: Database): { provider: string; dims: number } | null {
    try {
        const provider = db.prepare(
            "SELECT value FROM embedding_meta WHERE key = 'provider'"
        ).get() as any;
        const dims = db.prepare(
            "SELECT value FROM embedding_meta WHERE key = 'dims'"
        ).get() as any;

        if (!provider || !dims) return null;
        return { provider: provider.value, dims: Number(dims.value) };
    } catch {
        return null;
    }
}

/** Store current provider info. */
export function setEmbeddingMeta(db: Database, embedding: EmbeddingProvider): void {
    const upsert = db.prepare(
        'INSERT OR REPLACE INTO embedding_meta (key, value) VALUES (?, ?)'
    );
    upsert.run('provider', embedding.constructor?.name ?? 'unknown');
    upsert.run('dims', String(embedding.dims));
    upsert.run('indexed_at', new Date().toISOString());
}

/** Check if the configured provider differs from what's stored. */
export function detectProviderMismatch(
    db: Database,
    embedding: EmbeddingProvider,
): { mismatch: boolean; stored: string; current: string } | null {
    const meta = getEmbeddingMeta(db);
    if (!meta) return null; // First time, no mismatch

    const currentName = embedding.constructor?.name ?? 'unknown';
    const mismatch = meta.dims !== embedding.dims || meta.provider !== currentName;

    return {
        mismatch,
        stored: `${meta.provider}/${meta.dims}`,
        current: `${currentName}/${embedding.dims}`,
    };
}

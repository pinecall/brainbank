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

import type { Database } from '@/db/database.ts';
import { vecToBuffer } from '@/lib/math.ts';
import type { EmbeddingProvider, ProgressCallback } from '@/types.ts';
import type { HNSWIndex } from '@/providers/vector/hnsw-index.ts';

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

/**
 * Re-embed a single table. Returns count of vectors regenerated.
 * 
 * Streams per-batch to avoid OOM on large tables — memory stays O(batchSize).
 * Tradeoff: if embedBatch fails mid-way, partial vectors exist. Reembed is
 * a destructive operation by design — re-run to completion if interrupted.
 */
async function reembedTable(
    db: Database,
    embedding: EmbeddingProvider,
    table: ReembedTable,
    batchSize: number,
    onProgress?: ProgressCallback,
): Promise<number> {
    const totalCount = (db.prepare(
        `SELECT COUNT(*) as c FROM ${table.textTable}`
    ).get() as any).c;

    if (totalCount === 0) return 0;

    // Phase 1: Build new vectors in a temp table (safe — old data untouched)
    const tempTable = `_reembed_${table.vectorTable}`;
    db.exec(`DROP TABLE IF EXISTS ${tempTable}`);
    db.exec(`CREATE TABLE ${tempTable} AS SELECT * FROM ${table.vectorTable} WHERE 0`);

    const insertTemp = db.prepare(
        `INSERT INTO ${tempTable} (${table.fkColumn}, embedding) VALUES (?, ?)`
    );

    let processed = 0;
    try {
        for (let offset = 0; offset < totalCount; offset += batchSize) {
            const batch = db.prepare(
                `SELECT * FROM ${table.textTable} LIMIT ? OFFSET ?`
            ).all(batchSize, offset) as any[];
            const texts = batch.map((r: any) => table.textBuilder(r));
            const vectors = await embedding.embedBatch(texts);

            db.transaction(() => {
                for (let j = 0; j < batch.length; j++) {
                    insertTemp.run(batch[j][table.idColumn], vecToBuffer(vectors[j]));
                }
            });

            processed += batch.length;
            onProgress?.(table.name, processed, totalCount);
        }

        // Phase 2: Atomic swap — all or nothing
        db.transaction(() => {
            db.exec(`DELETE FROM ${table.vectorTable}`);
            db.exec(`INSERT INTO ${table.vectorTable} SELECT * FROM ${tempTable}`);
        });
    } finally {
        // Always clean up temp table — even if embedBatch fails mid-batch
        db.exec(`DROP TABLE IF EXISTS ${tempTable}`);
    }

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

// ── Re-exports (backward compat) ────────────────────
export { setEmbeddingMeta, getEmbeddingMeta, detectProviderMismatch } from './embedding-meta.ts';

/**
 * BrainBank — Re-embedding Engine
 * 
 * Regenerates all vectors without re-indexing.
 * Reads existing text from SQLite, embeds with the current provider,
 * and replaces vector BLOBs. No file I/O, no git parsing, no re-chunking.
 * 
 * Usage:
 *   const result = await brain.reembed({ onProgress });
 *   // → { code: 1200, git: 500, docs: 80, kv: 45, total: 1837 }
 */

import type { DatabaseAdapter, CountRow, VectorRow } from '@/db/adapter.ts';
import type { Plugin, ReembedTable } from '@/plugin.ts';
import type { HNSWIndex } from '@/providers/vector/hnsw-index.ts';
import type { EmbeddingProvider, ProgressCallback } from '@/types.ts';

import { setEmbeddingMeta } from '@/db/metadata.ts';
import { vecToBuffer } from '@/lib/math.ts';
import { isReembeddable } from '@/plugin.ts';
import { saveAllHnsw } from '@/providers/vector/hnsw-loader.ts';


const CORE_TABLES: ReembedTable[] = [
    {
        name: 'kv',
        textTable: 'kv_data',
        vectorTable: 'kv_vectors',
        idColumn: 'id',
        fkColumn: 'data_id',
        textBuilder: (r) => String(r.content),
    },
];

/** Collect reembed tables from plugins + core. Deduplicates by vectorTable for multi-repo. */
function collectTables(plugins: Plugin[]): ReembedTable[] {
    const byVectorTable = new Map<string, ReembedTable>();
    for (const p of plugins) {
        if (isReembeddable(p)) {
            const config = p.reembedConfig();
            byVectorTable.set(config.vectorTable, config);
        }
    }
    for (const t of CORE_TABLES) {
        byVectorTable.set(t.vectorTable, t);
    }
    return [...byVectorTable.values()];
}


export interface ReembedResult {
    /** Per-table vector counts. Keys are table names (e.g. 'code', 'git', 'docs', 'kv'). */
    counts: Record<string, number>;
    total: number;
}

export interface ReembedOptions {
    /** Progress callback: (tableName, current, total) */
    onProgress?: ProgressCallback;
    /** Batch size for embedBatch. Default: 50 */
    batchSize?: number;
}


/**
 * Re-embed all existing text with the current embedding provider.
 * Does NOT re-parse files, git, or documents — only replaces vectors.
 */
export async function reembedAll(
    db: DatabaseAdapter,
    embedding: EmbeddingProvider,
    hnswMap: Map<string, { hnsw: HNSWIndex; vecs: Map<number, Float32Array> }>,
    plugins: Plugin[],
    options: ReembedOptions = {},
    persist?: {
        dbPath: string;
        kvHnsw: HNSWIndex;
        sharedHnsw: Map<string, { hnsw: HNSWIndex; vecCache: Map<number, Float32Array> }>;
    },
): Promise<ReembedResult> {
    const { batchSize = 50, onProgress } = options;
    const tables = collectTables(plugins);
    const counts: Record<string, number> = {};
    let total = 0;

    for (const table of tables) {
        // Skip tables that don't exist (plugin not installed)
        try {
            const textExists = (db.prepare(
                `SELECT COUNT(*) as c FROM sqlite_master WHERE type='table' AND name=?`
            ).get(table.textTable) as CountRow).c;
            const vecExists = (db.prepare(
                `SELECT COUNT(*) as c FROM sqlite_master WHERE type='table' AND name=?`
            ).get(table.vectorTable) as CountRow).c;
            if (!textExists || !vecExists) continue;
        } catch (e: unknown) {
            if (e instanceof Error && e.message.includes('no such table')) continue;
            throw e;
        }

        const count = await reembedTable(db, embedding, table, batchSize, onProgress);
        counts[table.name] = count;
        total += count;

        // Rebuild HNSW if available
        const entry = hnswMap.get(table.name);
        if (entry && count > 0) {
            await rebuildHnsw(db, table, entry.hnsw, entry.vecs);
        }
    }

    // Persist provider metadata + HNSW indexes to disk
    setEmbeddingMeta(db, embedding);
    if (persist) {
        saveAllHnsw(persist.dbPath, persist.kvHnsw, persist.sharedHnsw, new Map());
    }

    return {
        counts,
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
    db: DatabaseAdapter,
    embedding: EmbeddingProvider,
    table: ReembedTable,
    batchSize: number,
    onProgress?: ProgressCallback,
): Promise<number> {
    const totalCount = (db.prepare(
        `SELECT COUNT(*) as c FROM ${table.textTable}`
    ).get() as CountRow).c;

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
            ).all(batchSize, offset) as Record<string, unknown>[];
            const texts = batch.map(r => table.textBuilder(r));
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
    db: DatabaseAdapter,
    table: ReembedTable,
    hnsw: HNSWIndex,
    vecs: Map<number, Float32Array>,
): Promise<void> {
    // Wipe stale vectors before repopulating
    vecs.clear();
    hnsw.reinit();

    const rows = db.prepare(
        `SELECT ${table.fkColumn} as id, embedding FROM ${table.vectorTable}`
    ).all() as VectorRow[];

    for (const row of rows) {
        const emb = row.embedding;
        const vec = new Float32Array(emb.buffer.slice(emb.byteOffset, emb.byteOffset + emb.byteLength));
        hnsw.add(vec, row.id);
        vecs.set(row.id, vec);
    }
}

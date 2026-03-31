/**
 * BrainBank — HNSW Loader
 *
 * Utilities for persisting and loading HNSW indexes to/from disk.
 * Extracted from bootstrap/initializer.ts to keep vector-related I/O
 * in the providers layer where it belongs.
 */

import { dirname, join } from 'node:path';
import type { Database } from '@/db/database.ts';
import type { CountRow } from '@/db/rows.ts';
import type { HNSWIndex } from './hnsw-index.ts';

/** Derive the HNSW index file path from the DB path. */
export function hnswPath(dbPath: string, name: string): string {
    return join(dirname(dbPath), `hnsw-${name}.index`);
}

/** Count rows in a vector table (fast, no data transfer). */
export function countRows(db: Database, table: string): number {
    const row = db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as CountRow;
    return row?.c ?? 0;
}

/** Save all HNSW indexes to disk for fast startup next time. Returns false on failure. */
export function saveAllHnsw(
    dbPath: string,
    kvHnsw: HNSWIndex,
    sharedHnsw: Map<string, { hnsw: HNSWIndex; vecCache: Map<number, Float32Array> }>,
    privateHnsw: Map<string, HNSWIndex>,
): boolean {
    try {
        kvHnsw.save(hnswPath(dbPath, 'kv'));
        for (const [name, { hnsw }] of sharedHnsw) {
            hnsw.save(hnswPath(dbPath, name));
        }
        for (const [name, hnsw] of privateHnsw) {
            hnsw.save(hnswPath(dbPath, name));
        }
        return true;
    } catch {
        // Non-fatal: next startup rebuilds from SQLite (slower).
        return false;
    }
}

/** Load vectors from SQLite into HNSW + cache. */
export function loadVectors(
    db: Database,
    table: string,
    idCol: string,
    hnsw: HNSWIndex,
    cache: Map<number, Float32Array>,
): void {
    const iter = db.prepare(`SELECT ${idCol}, embedding FROM ${table}`).iterate() as IterableIterator<{ embedding: Buffer; [key: string]: unknown }>;
    for (const row of iter) {
        const vec = new Float32Array(
            row.embedding.buffer.slice(
                row.embedding.byteOffset,
                row.embedding.byteOffset + row.embedding.byteLength,
            ),
        );
        hnsw.add(vec, row[idCol] as number);
        cache.set(row[idCol] as number, vec);
    }
}

/** Populate only the vecCache from SQLite (HNSW already loaded from file). */
export function loadVecCache(
    db: Database,
    table: string,
    idCol: string,
    cache: Map<number, Float32Array>,
): void {
    const iter = db.prepare(`SELECT ${idCol}, embedding FROM ${table}`).iterate() as IterableIterator<{ embedding: Buffer; [key: string]: unknown }>;
    for (const row of iter) {
        const vec = new Float32Array(
            row.embedding.buffer.slice(
                row.embedding.byteOffset,
                row.embedding.byteOffset + row.embedding.byteLength,
            ),
        );
        cache.set(row[idCol] as number, vec);
    }
}

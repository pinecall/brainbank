/**
 * BrainBank — HNSW Loader
 *
 * Utilities for persisting and loading HNSW indexes to/from disk.
 * Used by BrainBank._runInitialize() and PluginContext.loadVectors().
 *
 * Includes cross-process write locking and hot-reload support
 * for multi-process coordination.
 */

import type { DatabaseAdapter, CountRow } from '@/db/adapter.ts';
import type { HNSWIndex } from './hnsw-index.ts';

import { dirname, join } from 'node:path';
import { withLock } from '@/lib/write-lock.ts';

/** Derive the HNSW index file path from the DB path. */
export function hnswPath(dbPath: string, name: string): string {
    return join(dirname(dbPath), `hnsw-${name}.index`);
}

/** Derive the lock directory from the DB path. */
export function lockDir(dbPath: string): string {
    return dirname(dbPath);
}

/** Count rows in a vector table (fast, no data transfer). */
export function countRows(db: DatabaseAdapter, table: string): number {
    const row = db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as CountRow;
    return row?.c ?? 0;
}

/**
 * Save all HNSW indexes to disk with cross-process file locking.
 * Prevents concurrent writes from corrupting `.index` files.
 */
export async function saveAllHnsw(
    dbPath: string,
    kvHnsw: HNSWIndex,
    sharedHnsw: Map<string, { hnsw: HNSWIndex; vecCache: Map<number, Float32Array> }>,
    privateHnsw: Map<string, HNSWIndex>,
): Promise<boolean> {
    try {
        await withLock(lockDir(dbPath), 'hnsw', () => {
            kvHnsw.save(hnswPath(dbPath, 'kv'));
            for (const [name, { hnsw }] of sharedHnsw) {
                hnsw.save(hnswPath(dbPath, name));
            }
            for (const [name, hnsw] of privateHnsw) {
                hnsw.save(hnswPath(dbPath, name));
            }
        });
        return true;
    } catch {
        // Non-fatal: next startup rebuilds from SQLite (slower).
        return false;
    }
}

/** Load vectors from SQLite into HNSW + cache. */
export function loadVectors(
    db: DatabaseAdapter,
    table: string,
    idCol: string,
    hnsw: HNSWIndex,
    cache: Map<number, Float32Array>,
): void {
    const iter = db.prepare(`SELECT ${idCol}, embedding FROM ${table}`).iterate() as IterableIterator<{ embedding: Uint8Array; [key: string]: unknown }>;
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
    db: DatabaseAdapter,
    table: string,
    idCol: string,
    cache: Map<number, Float32Array>,
): void {
    const iter = db.prepare(`SELECT ${idCol}, embedding FROM ${table}`).iterate() as IterableIterator<{ embedding: Uint8Array; [key: string]: unknown }>;
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

/** Deps for reloading a single HNSW index from disk. */
interface ReloadDeps {
    dbPath: string;
    db: DatabaseAdapter;
    name: string;
    hnsw: HNSWIndex;
    vecCache: Map<number, Float32Array>;
    vectorTable: string;
    idCol: string;
}

/**
 * Reload a single HNSW index from disk after detecting a stale version.
 * Reinitializes the in-memory HNSW, loads the saved index file, and
 * refreshes the vector cache from SQLite.
 */
export function reloadHnsw(deps: ReloadDeps): void {
    const { dbPath, db, name, hnsw, vecCache, vectorTable, idCol } = deps;
    const indexPath = hnswPath(dbPath, name);
    const rowCount = countRows(db, vectorTable);

    hnsw.reinit();
    vecCache.clear();

    if (hnsw.tryLoad(indexPath, rowCount)) {
        loadVecCache(db, vectorTable, idCol, vecCache);
    } else {
        loadVectors(db, vectorTable, idCol, hnsw, vecCache);
    }
}

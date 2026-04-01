/**
 * BrainBank — Index State
 *
 * Cross-process version tracking for HNSW indices.
 * Each index type has a monotonic version counter in SQLite.
 * Processes compare their in-memory version with the DB version
 * to detect staleness and trigger hot-reload.
 */

import type { DatabaseAdapter } from './adapter.ts';

/** Row shape returned from index_state queries. */
interface IndexStateRow {
    name: string;
    version: number;
    writer_pid: number;
    updated_at: number;
}

/**
 * Increment the version for a given index name.
 * Sets writer_pid to current process PID.
 * Uses UPSERT so the row is created on first call.
 */
export function bumpVersion(db: DatabaseAdapter, name: string): number {
    const row = db.prepare(`
        INSERT INTO index_state (name, version, writer_pid, updated_at)
        VALUES (?, 1, ?, unixepoch())
        ON CONFLICT(name) DO UPDATE SET
            version    = version + 1,
            writer_pid = excluded.writer_pid,
            updated_at = excluded.updated_at
        RETURNING version
    `).get(name, process.pid) as { version: number };
    return row.version;
}

/**
 * Get all index versions as a Map.
 * Used by `ensureFresh()` to compare against in-memory versions.
 */
export function getVersions(db: DatabaseAdapter): Map<string, number> {
    const rows = db.prepare('SELECT name, version FROM index_state').all() as IndexStateRow[];
    const map = new Map<string, number>();
    for (const row of rows) {
        map.set(row.name, row.version);
    }
    return map;
}

/** Get the version of a single index. Returns 0 if not found. */
export function getVersion(db: DatabaseAdapter, name: string): number {
    const row = db.prepare('SELECT version FROM index_state WHERE name = ?').get(name) as { version: number } | undefined;
    return row?.version ?? 0;
}

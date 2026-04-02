/**
 * BrainBank — Database Metadata
 *
 * Helpers for reading/writing metadata stored in core SQLite tables:
 *
 * - **Index State** — cross-process HNSW version tracking.
 *   Processes compare in-memory versions with DB to detect staleness
 *   and trigger hot-reload via `ensureFresh()`.
 *
 * - **Embedding Meta** — tracks which embedding provider is stored in
 *   the database. Detects dimension mismatches at startup and updates
 *   metadata after `reembed()`.
 */

import type { EmbeddingProvider } from '@/types.ts';
import type { DatabaseAdapter, EmbeddingMetaRow } from './adapter.ts';

import { providerKey } from '@/lib/provider-key.ts';


// ── Index State ─────────────────────────────────────────────────────

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


// ── Embedding Meta ──────────────────────────────────────────────────

/** Stored embedding metadata shape. */
export interface EmbeddingMeta {
    provider: string;
    dims: number;
    /** Stable key for auto-resolving provider on startup (e.g. 'openai', 'local'). */
    providerKey: string;
}

/** Get stored embedding metadata. Returns null if not set. */
export function getEmbeddingMeta(db: DatabaseAdapter): EmbeddingMeta | null {
    try {
        const provider = db.prepare(
            "SELECT value FROM embedding_meta WHERE key = 'provider'"
        ).get() as EmbeddingMetaRow | undefined;
        const dims = db.prepare(
            "SELECT value FROM embedding_meta WHERE key = 'dims'"
        ).get() as EmbeddingMetaRow | undefined;
        const key = db.prepare(
            "SELECT value FROM embedding_meta WHERE key = 'provider_key'"
        ).get() as EmbeddingMetaRow | undefined;

        if (!provider || !dims) return null;
        return {
            provider: provider.value,
            dims: Number(dims.value),
            providerKey: key?.value ?? 'local',
        };
    } catch {
        return null;
    }
}

/** Store current provider info. */
export function setEmbeddingMeta(db: DatabaseAdapter, embedding: EmbeddingProvider): void {
    const upsert = db.prepare(
        'INSERT OR REPLACE INTO embedding_meta (key, value) VALUES (?, ?)'
    );
    upsert.run('provider', embedding.constructor?.name ?? 'unknown');
    upsert.run('dims', String(embedding.dims));
    upsert.run('provider_key', providerKey(embedding));
    upsert.run('indexed_at', new Date().toISOString());
}

/** Check if the configured provider differs from what's stored. */
export function detectProviderMismatch(
    db: DatabaseAdapter,
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

/**
 * BrainBank — Embedding Metadata
 *
 * Tracks which embedding provider is stored in the database.
 * Used at startup to detect dimension mismatches and during reembed
 * to update the metadata after re-embedding.
 */

import type { Database } from '@/db/database.ts';
import type { EmbeddingProvider } from '@/types.ts';
import { providerKey } from '@/providers/embeddings/resolve.ts';

/** Stored embedding metadata shape. */
export interface EmbeddingMeta {
    provider: string;
    dims: number;
    /** Stable key for auto-resolving provider on startup (e.g. 'openai', 'local'). */
    providerKey: string;
}

/** Get stored embedding metadata. Returns null if not set. */
export function getEmbeddingMeta(db: Database): EmbeddingMeta | null {
    try {
        const provider = db.prepare(
            "SELECT value FROM embedding_meta WHERE key = 'provider'"
        ).get() as any;
        const dims = db.prepare(
            "SELECT value FROM embedding_meta WHERE key = 'dims'"
        ).get() as any;
        const key = db.prepare(
            "SELECT value FROM embedding_meta WHERE key = 'provider_key'"
        ).get() as any;

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
export function setEmbeddingMeta(db: Database, embedding: EmbeddingProvider): void {
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

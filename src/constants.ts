/**
 * BrainBank — Constants
 *
 * Core-only constants. Plugin names are NOT defined here — they belong
 * to their respective packages. Only keys owned by the core live here.
 */

/** HNSW index key for KV collections (core-owned). */
export const HNSW = {
    KV: 'kv',
} as const;

export type HnswKey = typeof HNSW[keyof typeof HNSW];

/**
 * BrainBank — Constants
 *
 * Core-only constants. Plugin names are NOT defined here — they belong
 * to their respective packages. Only keys owned by the core live here.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

/** Package version from package.json. */
export const VERSION: string = pkg.version;

/** HNSW index key for KV collections (core-owned). */
export const HNSW = {
    KV: 'kv',
} as const;

export type HnswKey = typeof HNSW[keyof typeof HNSW];

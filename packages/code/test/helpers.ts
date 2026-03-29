/**
 * @brainbank/code — Test Helpers
 *
 * Common imports, mocks, and utilities for code package tests.
 * Imports from 'brainbank' peer dep for integration tests.
 */

import { BrainBank } from '../../../src/brainbank.ts';
import { Database } from '../../../src/db/database.ts';
import { code } from '../src/index.js';
import { CodeChunker } from '../src/code-chunker.js';
import {
    getLanguage, isSupported, isIgnoredDir, isIgnoredFile,
    SUPPORTED_EXTENSIONS, IGNORE_DIRS,
} from '../../../src/indexers/languages.ts';
import type { EmbeddingProvider } from '../../../src/types.ts';

// ── Hash Embedding Provider ─────────────────────────

/**
 * Creates a deterministic hash-based embedding provider.
 * Produces unique vectors per input text using FNV-1a hashing.
 */
export function hashEmbedding(dims = 384): EmbeddingProvider {
    function embed(text: string): Float32Array {
        const vec = new Float32Array(dims);
        let h = 2166136261;
        for (let i = 0; i < text.length; i++) {
            h ^= text.charCodeAt(i);
            h = Math.imul(h, 16777619) >>> 0;
        }
        for (let i = 0; i < dims; i++) {
            h ^= (h >>> 13);
            h = Math.imul(h, 0x5bd1e995) >>> 0;
            vec[i] = (h / 0xFFFFFFFF) * 2 - 1;
        }
        let norm = 0;
        for (let i = 0; i < dims; i++) norm += vec[i] * vec[i];
        norm = Math.sqrt(norm);
        for (let i = 0; i < dims; i++) vec[i] /= norm;
        return vec;
    }
    return {
        dims,
        embed: async (t: string) => embed(t),
        embedBatch: async (ts: string[]) => ts.map(t => embed(t)),
        close: async () => {},
    };
}

/** Creates a unique temp DB path. */
export function tmpDb(label: string): string {
    return `/tmp/brainbank-${label}-${Date.now()}.db`;
}

export {
    BrainBank,
    Database,
    code,
    CodeChunker,
    getLanguage,
    isSupported,
    isIgnoredDir,
    isIgnoredFile,
    SUPPORTED_EXTENSIONS,
    IGNORE_DIRS,
};

export type { EmbeddingProvider };

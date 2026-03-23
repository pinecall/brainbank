/**
 * BrainBank — Shared Test Helpers
 * 
 * Common imports, mocks, and utilities used across test files.
 * Import once at the top of each test file instead of per-spec.
 */

import { BrainBank } from '../src/core/brainbank.ts';
import { Database } from '../src/core/database.ts';
import { HNSWIndex } from '../src/vector/hnsw.ts';
import { BM25Search } from '../src/query/bm25.ts';
import { NoteStore } from '../src/learning/note-store.ts';
import { OpenAIEmbedding } from '../src/embeddings/openai.ts';
import { Collection } from '../src/core/collection.ts';
import { CodeChunker } from '../src/indexers/chunker.ts';
import { resolveConfig, DEFAULTS } from '../src/core/config.ts';
import { SCHEMA_VERSION } from '../src/core/schema.ts';
import { reciprocalRankFusion } from '../src/query/rrf.ts';
import { searchMMR } from '../src/vector/mmr.ts';
import {
    cosineSimilarity, cosineSimilarityFull,
    normalize, euclideanDistance,
} from '../src/embeddings/math.ts';
import {
    getLanguage, isSupported, isIgnoredDir, isIgnoredFile,
    SUPPORTED_EXTENSIONS, IGNORE_DIRS,
} from '../src/indexers/languages.ts';

// Plugins
import { code } from '../src/plugins/code.ts';
import { git } from '../src/plugins/git.ts';
import { docs } from '../src/plugins/docs.ts';
import { learning } from '../src/plugins/memory.ts';

import type { EmbeddingProvider, Reranker } from '../src/types.ts';

// ── Mock Embedding Provider ─────────────────────────

/** Creates a deterministic mock embedding provider (384-dim, all 0.1). */
export function mockEmbedding(dims = 384): EmbeddingProvider {
    return {
        dims,
        async embed(_: string) { return new Float32Array(dims).fill(0.1); },
        async embedBatch(txts: string[]) { return txts.map(() => new Float32Array(dims).fill(0.1)); },
        async close() {},
    };
}

// ── Hash Embedding Provider ─────────────────────────

/**
 * Creates a deterministic hash-based embedding provider.
 * Produces unique vectors per input text using FNV-1a hashing.
 * Used in integration tests to exercise real search paths
 * without downloading ML models.
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

// ── Re-exports ──────────────────────────────────────

export {
    BrainBank,
    Database,
    HNSWIndex,
    BM25Search,
    NoteStore,
    OpenAIEmbedding,
    Collection,
    CodeChunker,
    resolveConfig,
    DEFAULTS,
    SCHEMA_VERSION,
    reciprocalRankFusion,
    searchMMR,
    cosineSimilarity,
    cosineSimilarityFull,
    normalize,
    euclideanDistance,
    getLanguage,
    isSupported,
    isIgnoredDir,
    isIgnoredFile,
    SUPPORTED_EXTENSIONS,
    IGNORE_DIRS,
    // Plugins
    code,
    git,
    docs,
    learning,
};

export type { EmbeddingProvider, Reranker };


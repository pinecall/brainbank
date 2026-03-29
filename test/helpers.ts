/**
 * BrainBank — Shared Test Helpers
 * 
 * Common imports, mocks, and utilities used across test files.
 * Import once at the top of each test file instead of per-spec.
 */

import { BrainBank } from '../src/brainbank.ts';
import { Database } from '../src/db/database.ts';
import { HNSWIndex } from '../src/providers/vector/hnsw-index.ts';
import { KeywordSearch } from '../src/search/keyword/keyword-search.ts';

import { OpenAIEmbedding } from '../src/providers/embeddings/openai-embedding.ts';
import { PerplexityEmbedding, decodeBase64Int8 } from '../src/providers/embeddings/perplexity-embedding.ts';
import { PerplexityContextEmbedding } from '../src/providers/embeddings/perplexity-context-embedding.ts';
import { Collection } from '../src/domain/collection.ts';
import { resolveConfig, DEFAULTS } from '../src/config/defaults.ts';
import { SCHEMA_VERSION } from '../src/db/schema.ts';
import { reciprocalRankFusion } from '../src/lib/rrf.ts';
import { searchMMR } from '../src/search/vector/mmr.ts';
import {
    cosineSimilarity, cosineSimilarityFull,
    normalize, euclideanDistance,
} from '../src/lib/math.ts';
import {
    getLanguage, isSupported, isIgnoredDir, isIgnoredFile,
    SUPPORTED_EXTENSIONS, IGNORE_DIRS,
} from '../src/lib/languages.ts';

// Plugins — loaded from @brainbank/* packages
import { code } from '@brainbank/code';
import { git } from '@brainbank/git';
import { docs } from '@brainbank/docs';
import { memory } from '../src/domain/memory/memory-plugin.ts';

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
    KeywordSearch,

    OpenAIEmbedding,
    PerplexityEmbedding,
    PerplexityContextEmbedding,
    decodeBase64Int8,
    Collection,
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
    memory,

};

export type { EmbeddingProvider, Reranker };


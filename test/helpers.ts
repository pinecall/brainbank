/**
 * BrainBank — Shared Test Helpers
 * 
 * Common imports, mocks, and utilities used across test files.
 * Import once at the top of each test file instead of per-spec.
 */

import { BrainBank } from '../src/core/brainbank.ts';
import { Database } from '../src/storage/database.ts';
import { HNSWIndex } from '../src/vector/hnsw.ts';
import { BM25Search } from '../src/query/bm25.ts';
import { NoteStore } from '../src/memory/note-store.ts';
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
};

export type { EmbeddingProvider, Reranker };

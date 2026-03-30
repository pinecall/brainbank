/**
 * BrainBank — Public API
 * 
 * Semantic knowledge bank for AI agents.
 * 
 *   import { BrainBank } from 'brainbank';
 *   import { code } from '@brainbank/code';
 *   import { docs } from '@brainbank/docs';
 *   
 *   const brain = new BrainBank()
 *     .use(code({ repoPath: '.' }))
 *     .use(docs());
 *   
 *   // Dynamic collections — universal data primitive
 *   const errors = brain.collection('debug_errors');
 *   await errors.add('Fixed null check', { file: 'api.ts' });
 */

// ── Public API ──────────────────────────────────────

export { BrainBank } from './brainbank.ts';

// Plugin types
export type { Plugin, PluginContext, IndexablePlugin, SearchablePlugin, WatchablePlugin, HnswPlugin, CoEditPlugin, ReembeddablePlugin, ReembedTable } from './plugin.ts';
export { isIndexable, isSearchable, isWatchable, isDocsPlugin, isHnswPlugin, isCoEditPlugin, isReembeddable } from './plugin.ts';
export type { DocsPlugin } from './plugin.ts';

// Constants
export { PLUGIN, HNSW } from './constants.ts';
export type { PluginType, HnswKey } from './constants.ts';

// Collections
export { Collection } from './services/collection.ts';
export type { CollectionItem, CollectionSearchOptions, CollectionAddOptions } from './services/collection.ts';

// Types
export type {
    BrainBankConfig, ResolvedConfig,
    EmbeddingProvider,
    Reranker,
    VectorIndex, SearchHit,
    CodeChunk,
    GitCommitRecord,
    LearningPattern, DistilledStrategy,
    SearchResult, SearchResultType,
    CodeResult, CommitResult, PatternResult, DocumentResult, CollectionResult,
    CodeResultMetadata, CommitResultMetadata, PatternResultMetadata, DocumentResultMetadata,
    ContextOptions,
    IndexStats, IndexResult,
    ProgressCallback, StageProgressCallback,
    CoEditSuggestion,
    DocumentCollection, DocChunk,
} from './types.ts';
export {
    isCodeResult, isCommitResult, isDocumentResult,
    isPatternResult, isCollectionResult,
    matchResult,
} from './types.ts';

// Embeddings
export { LocalEmbedding } from './providers/embeddings/local-embedding.ts';
export { OpenAIEmbedding } from './providers/embeddings/openai-embedding.ts';
export type { OpenAIEmbeddingOptions } from './providers/embeddings/openai-embedding.ts';
export { PerplexityEmbedding } from './providers/embeddings/perplexity-embedding.ts';
export type { PerplexityEmbeddingOptions } from './providers/embeddings/perplexity-embedding.ts';
export { PerplexityContextEmbedding } from './providers/embeddings/perplexity-context-embedding.ts';
export type { PerplexityContextEmbeddingOptions } from './providers/embeddings/perplexity-context-embedding.ts';
export type { ReembedResult, ReembedOptions } from './engine/reembed.ts';
export type { WatchOptions, Watcher } from './services/watch.ts';

// Reranker
export { Qwen3Reranker } from './providers/rerankers/qwen3-reranker.ts';
export type { Qwen3RerankerOptions } from './providers/rerankers/qwen3-reranker.ts';

// Embedding resolver
export { resolveEmbedding, providerKey } from './providers/embeddings/resolve.ts';
export type { EmbeddingKey } from './providers/embeddings/resolve.ts';

// Config
export { resolveConfig, DEFAULTS } from './config.ts';

// ── Internals (for plugin authors & power users) ────

// Vector indices
export { HNSWIndex } from './providers/vector/hnsw-index.ts';
export { searchMMR } from './search/vector/mmr.ts';

// Language support (used by @brainbank/code)
export { SUPPORTED_EXTENSIONS, IGNORE_DIRS, isSupported, getLanguage, isIgnoredDir, isIgnoredFile } from './lib/languages.ts';

// Math utilities (needed by plugins)
export { vecToBuffer, cosineSimilarity, normalize } from './lib/math.ts';

// KV service (collection infrastructure)
export { KVService } from './services/kv-service.ts';

// Search internals
export { ContextBuilder } from './search/context-builder.ts';
export { CompositeVectorSearch } from './search/vector/composite-vector-search.ts';
export { CodeVectorSearch } from './search/vector/code-vector-search.ts';
export { GitVectorSearch } from './search/vector/git-vector-search.ts';
export { PatternVectorSearch } from './search/vector/pattern-vector-search.ts';
export { KeywordSearch } from './search/keyword/keyword-search.ts';
export { reciprocalRankFusion } from './lib/rrf.ts';
export { normalizeBM25 } from './lib/fts.ts';
export { rerank } from './lib/rerank.ts';

// Search types
export type { SearchStrategy, SearchOptions, CodeGraphProvider, CodeChunkSummary } from './search/types.ts';
export { SqlCodeGraphProvider } from './search/context/sql-code-graph.ts';

// Database (for plugin access)
export type { Database } from './db/database.ts';

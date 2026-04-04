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


export { BrainBank } from './brainbank.ts';

// Plugin types + capability interfaces
export type {
    Plugin, PluginContext,
    IndexablePlugin, SearchablePlugin, WatchablePlugin,
    CoEditPlugin,
    ReembeddablePlugin, ReembedTable,
    DocsPlugin,
    VectorSearchPlugin, ContextFormatterPlugin,
    MigratablePlugin, BM25SearchPlugin,
} from './plugin.ts';
export {
    isIndexable, isSearchable, isWatchable,
    isDocsPlugin, isCoEditPlugin, isReembeddable,
    isVectorSearchPlugin, isContextFormatterPlugin,
    isMigratable, isBM25SearchPlugin,
} from './plugin.ts';

// Constants (core-only)
export { HNSW } from './constants.ts';
export type { HnswKey } from './constants.ts';

// Collections
export { Collection } from './services/collection.ts';
export type { CollectionItem, CollectionSearchOptions, CollectionAddOptions } from './services/collection.ts';

// Types
export type {
    BrainBankConfig, ResolvedConfig,
    EmbeddingProvider,
    Reranker,
    Pruner, PrunerItem,
    VectorIndex, SearchHit,
    CodeChunk,
    GitCommitRecord,
    SearchResult, SearchResultType,
    CodeResult, CommitResult, DocumentResult, CollectionResult,
    CodeResultMetadata, CommitResultMetadata, DocumentResultMetadata,
    ContextOptions,
    IndexResult,
    ProgressCallback, StageProgressCallback,
    CoEditSuggestion,
    DocumentCollection, DocChunk,
    WatchEvent, WatchEventHandler, WatchHandle, WatchConfig,
} from './types.ts';
export {
    isCodeResult, isCommitResult, isDocumentResult,
    isCollectionResult,
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
export { EmbeddingWorkerProxy } from './providers/embeddings/embedding-worker.ts';
export type { ReembedResult, ReembedOptions } from './engine/reembed.ts';
export type { WatchOptions } from './services/watch.ts';
export { Watcher } from './services/watch.ts';
export { WebhookServer } from './services/webhook-server.ts';
export type { WebhookHandler } from './services/webhook-server.ts';
export { HttpServer } from './services/http-server.ts';
export type { HttpServerOptions } from './services/http-server.ts';
export { isServerRunning, getServerUrl, readPid, writePid, removePid, DEFAULT_PORT } from './services/daemon.ts';

// Reranker
export { Qwen3Reranker } from './providers/rerankers/qwen3-reranker.ts';
export type { Qwen3RerankerOptions } from './providers/rerankers/qwen3-reranker.ts';

// Pruner
export { HaikuPruner } from './providers/pruners/haiku-pruner.ts';
export type { HaikuPrunerOptions } from './providers/pruners/haiku-pruner.ts';
export { pruneResults } from './lib/prune.ts';

// Embedding resolver
export { resolveEmbedding, providerKey } from './providers/embeddings/resolve.ts';
export type { EmbeddingKey } from './providers/embeddings/resolve.ts';

// Config
export { resolveConfig, DEFAULTS } from './config.ts';

// Migrations
export type { Migration } from './db/migrations.ts';
export { runPluginMigrations } from './db/migrations.ts';

// Incremental indexing tracker
export type { IncrementalTracker } from './db/tracker.ts';
export { createTracker } from './db/tracker.ts';

// Vector indices
export { HNSWIndex } from './providers/vector/hnsw-index.ts';
export { searchMMR } from './search/vector/mmr.ts';

// Language support (used by @brainbank/code)
export { SUPPORTED_EXTENSIONS, IGNORE_DIRS, isSupported, getLanguage, isIgnoredDir, isIgnoredFile } from './lib/languages.ts';

// Math utilities (needed by plugins)
export { vecToBuffer, cosineSimilarity, normalize } from './lib/math.ts';

// KV service (collection infrastructure)
export { KVService } from './services/kv-service.ts';

// Search internals (plugins may use these)
export { ContextBuilder } from './search/context-builder.ts';
export { CompositeVectorSearch } from './search/vector/composite-vector-search.ts';
export { CompositeBM25Search } from './search/keyword/composite-bm25-search.ts';
export { reciprocalRankFusion } from './lib/rrf.ts';
export { sanitizeFTS, normalizeBM25, escapeLike } from './lib/fts.ts';
export { rerank } from './lib/rerank.ts';

// Search types
export type { SearchStrategy, SearchOptions, DomainVectorSearch } from './search/types.ts';

// Multi-process coordination
export { bumpVersion, getVersions, getVersion } from './db/metadata.ts';
export { acquireLock, releaseLock, withLock } from './lib/write-lock.ts';

// Database adapter (for plugin access and custom adapters)
export type { DatabaseAdapter, PreparedStatement, ExecuteResult, AdapterCapabilities } from './db/adapter.ts';
export type { KvDataRow, KvVectorRow, EmbeddingMetaRow, VectorRow, CountRow } from './db/adapter.ts';
export { SQLiteAdapter } from './db/sqlite-adapter.ts';

// Factory (for programmatic BrainBank creation)
export { createBrain, resetFactoryCache, contextFromCLI } from './cli/factory/index.ts';
export type { BrainContext } from './cli/factory/brain-context.ts';
export type { ProjectConfig } from './cli/factory/config-loader.ts';


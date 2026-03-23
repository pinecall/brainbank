/**
 * BrainBank — Public API
 * 
 * Semantic knowledge bank for AI agents.
 * 
 *   import { BrainBank } from 'brainbank';
 *   import { code } from 'brainbank/code';
 *   import { docs } from 'brainbank/docs';
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

export { BrainBank } from './core/brainbank.ts';

// Plugin factories
export { code } from './plugins/code.ts';
export { git } from './plugins/git.ts';
export { docs } from './plugins/docs.ts';

// Plugin types
export type { Indexer, IndexerContext, IndexablePlugin, SearchablePlugin, WatchablePlugin, CollectionPlugin } from './plugins/types.ts';

// Collections
export { Collection } from './core/collection.ts';
export type { CollectionItem, CollectionSearchOptions, CollectionAddOptions } from './core/collection.ts';

// Types
export type {
    BrainBankConfig, ResolvedConfig,
    EmbeddingProvider,
    Reranker,
    VectorIndex, SearchHit,
    CodeChunk,
    GitCommitRecord,
    LearningPattern, MemoryPattern, DistilledStrategy,
    SearchResult, SearchResultType,
    CodeResult, CommitResult, PatternResult, DocumentResult, CollectionResult,
    CodeResultMetadata, CommitResultMetadata, PatternResultMetadata, DocumentResultMetadata,
    ContextOptions,
    IndexStats, IndexResult,
    ProgressCallback, StageProgressCallback,
    CoEditSuggestion,
    DocumentCollection, DocChunk,
} from './types.ts';

// Embeddings
export { LocalEmbedding } from './embeddings/local.ts';
export { OpenAIEmbedding } from './embeddings/openai.ts';
export type { OpenAIEmbeddingOptions } from './embeddings/openai.ts';
export type { ReembedResult, ReembedOptions } from './core/reembed.ts';
export type { WatchOptions, Watcher } from './core/watch.ts';
export { cosineSimilarity, normalize } from './embeddings/math.ts';

// Config
export { resolveConfig, DEFAULTS } from './core/config.ts';

// ── Internals (for custom plugins & power users) ────

// Vector indices
export { HNSWIndex } from './vector/hnsw.ts';
export { searchMMR } from './vector/mmr.ts';

// Indexer implementations
export { CodeChunker } from './indexers/chunker.ts';
export { CodeIndexer } from './indexers/code-indexer.ts';
export { GitIndexer } from './indexers/git-indexer.ts';
export { DocsIndexer } from './indexers/doc-indexer.ts';
export { SUPPORTED_EXTENSIONS, IGNORE_DIRS, isSupported, getLanguage } from './indexers/languages.ts';

// Agent learning stores
export { PatternStore } from './learning/pattern-store.ts';
export { Consolidator } from './learning/consolidator.ts';
export { NoteStore } from './learning/note-store.ts';
export type { NoteDigest, StoredNote, RecallOptions } from './learning/note-store.ts';

// Search internals
export { ContextBuilder } from './core/context-builder.ts';
export { MultiIndexSearch } from './query/search.ts';
export { CoEditAnalyzer } from './indexers/co-edits.ts';
export { BM25Search } from './query/bm25.ts';
export { reciprocalRankFusion } from './query/rrf.ts';

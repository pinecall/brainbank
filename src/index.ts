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

export { BrainBank } from './core/brainbank.ts';

// Indexer factories
export { code } from './plugins/code.ts';
export { git } from './plugins/git.ts';
export { docs } from './plugins/docs.ts';

// Indexer types
export type { Indexer, IndexerContext } from './plugins/types.ts';
// Backward compat
export type { BrainBankModule, ModuleContext } from './plugins/types.ts';

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
    MemoryPattern, DistilledStrategy,
    SearchResult, SearchResultType,
    ContextOptions,
    IndexStats, IndexResult,
    ProgressCallback,
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

// Vector
export { HNSWIndex } from './vector/hnsw.ts';
export { searchMMR } from './vector/mmr.ts';

// Indexers (internal implementations)
export { CodeChunker } from './indexers/chunker.ts';
export { CodeIndexer } from './indexers/code-indexer.ts';
export { GitIndexer } from './indexers/git-indexer.ts';
export { DocIndexer } from './indexers/doc-indexer.ts';
export { SUPPORTED_EXTENSIONS, IGNORE_DIRS, isSupported, getLanguage } from './indexers/languages.ts';

// Memory (still available for custom indexers)
export { PatternStore } from './memory/pattern-store.ts';
export { Consolidator } from './memory/consolidator.ts';
export { NoteStore } from './memory/note-store.ts';
export type { NoteDigest, StoredNote, RecallOptions } from './memory/note-store.ts';

// Query
export { ContextBuilder } from './query/context-builder.ts';
export { UnifiedSearch } from './query/search.ts';
export { CoEditAnalyzer } from './query/co-edits.ts';
export { BM25Search } from './query/bm25.ts';
export { reciprocalRankFusion } from './query/rrf.ts';

// Config
export { resolveConfig, DEFAULTS } from './core/config.ts';

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

export { BrainBank } from './app/brain.ts';

// Plugin factories
export { code } from './indexers/code/plugin.ts';
export { git } from './indexers/git/plugin.ts';
export { docs } from './indexers/docs/plugin.ts';

// Plugin types
export type { Indexer, IndexerContext, IndexablePlugin, SearchablePlugin, WatchablePlugin, CollectionPlugin } from './indexers/base.ts';

// Collections
export { Collection } from './app/collection.ts';
export type { CollectionItem, CollectionSearchOptions, CollectionAddOptions } from './app/collection.ts';

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

// Embeddings
export { LocalEmbedding } from './providers/embeddings/local.ts';
export { OpenAIEmbedding } from './providers/embeddings/openai.ts';
export type { OpenAIEmbeddingOptions } from './providers/embeddings/openai.ts';
export type { ReembedResult, ReembedOptions } from './services/reembed.ts';
export type { WatchOptions, Watcher } from './services/watch.ts';
export { cosineSimilarity, normalize } from './lib/math.ts';

// Config
export { resolveConfig, DEFAULTS } from './config/defaults.ts';

// ── Internals (for custom plugins & power users) ────

// Vector indices
export { HNSWIndex } from './providers/vector/hnsw.ts';
export { searchMMR } from './search/mmr.ts';

// Indexer implementations
export { CodeChunker } from './indexers/code/chunker.ts';
export { CodeIndexer } from './indexers/code/engine.ts';
export { GitIndexer } from './indexers/git/engine.ts';
export { DocsIndexer } from './indexers/docs/engine.ts';
export { SUPPORTED_EXTENSIONS, IGNORE_DIRS, isSupported, getLanguage } from './indexers/languages.ts';

// Agent learning stores
export { PatternStore } from './indexers/learning/engine.ts';
export { Consolidator } from './indexers/learning/consolidator.ts';
export { NoteStore } from './indexers/notes/engine.ts';
export type { NoteDigest, StoredNote, RecallOptions } from './indexers/notes/engine.ts';

// Search internals
export { ContextBuilder } from './app/context.ts';
export { MultiIndexSearch } from './search/engine.ts';
export { CoEditAnalyzer } from './indexers/git/co-edits.ts';
export { BM25Search } from './search/bm25.ts';
export { reciprocalRankFusion } from './search/rrf.ts';

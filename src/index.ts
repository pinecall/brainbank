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

export { BrainBank } from './brainbank.ts';

// Plugin factories
export { code } from './indexers/code/code-plugin.ts';
export { git } from './indexers/git/git-plugin.ts';
export { docs } from './indexers/docs/docs-plugin.ts';
export { memory } from './indexers/memory/memory-plugin.ts';
export { notes } from './indexers/notes/notes-plugin.ts';

// Plugin types
export type { Indexer, IndexerContext, IndexablePlugin, SearchablePlugin, WatchablePlugin, CollectionPlugin } from './indexers/base.ts';

// Collections
export { Collection } from './domain/collection.ts';
export type { CollectionItem, CollectionSearchOptions, CollectionAddOptions } from './domain/collection.ts';

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
export type { ReembedResult, ReembedOptions } from './services/reembed.ts';
export type { WatchOptions, Watcher } from './services/watch.ts';
export { cosineSimilarity, normalize } from './lib/math.ts';

// Config
export { resolveConfig, DEFAULTS } from './config/defaults.ts';

// ── Internals (for custom plugins & power users) ────

// Vector indices
export { HNSWIndex } from './providers/vector/hnsw-index.ts';
export { searchMMR } from './search/vector/mmr.ts';

// Indexer implementations
export { CodeChunker } from './indexers/code/code-chunker.ts';
export { CodeIndexer } from './indexers/code/code-indexer.ts';
export { GitIndexer } from './indexers/git/git-indexer.ts';
export { DocsIndexer } from './indexers/docs/docs-indexer.ts';
export { SUPPORTED_EXTENSIONS, IGNORE_DIRS, isSupported, getLanguage } from './indexers/languages.ts';

// Agent memory stores
export { PatternStore } from './indexers/memory/pattern-store.ts';
export { Consolidator } from './indexers/memory/consolidator.ts';
export { NoteStore } from './indexers/notes/note-store.ts';
export type { NoteDigest, StoredNote, RecallOptions } from './indexers/notes/note-store.ts';

// Search internals
export { ContextBuilder } from './search/context-builder.ts';
export { VectorSearch } from './search/vector/vector-search.ts';
export { CoEditAnalyzer } from './indexers/git/co-edit-analyzer.ts';
export { KeywordSearch } from './search/keyword/keyword-search.ts';
export { reciprocalRankFusion } from './lib/rrf.ts';

// Search types
export type { SearchStrategy, SearchOptions } from './search/types.ts';

// Backwards compatibility aliases
export { VectorSearch as MultiIndexSearch } from './search/vector/vector-search.ts';
export { KeywordSearch as BM25Search } from './search/keyword/keyword-search.ts';

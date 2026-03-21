/**
 * BrainBank — Public API
 * 
 * Semantic knowledge bank for AI agents.
 * 
 *   import { BrainBank } from 'brainbank';
 *   import { code } from 'brainbank/code';
 *   import { docs } from 'brainbank/docs';
 *   import { memory } from 'brainbank/memory';
 *   import { conversations } from 'brainbank/conversations';
 *   
 *   const brain = new BrainBank()
 *     .use(code({ repoPath: '.' }))
 *     .use(docs())
 *     .use(memory())
 *     .use(conversations());
 */

export { BrainBank } from './core/brainbank.ts';

// Module factories
export { code } from './modules/code.ts';
export { git } from './modules/git.ts';
export { docs } from './modules/docs.ts';
export { conversations } from './modules/conversations.ts';
export { memory } from './modules/memory.ts';

// Module types
export type { BrainBankModule, ModuleContext } from './modules/types.ts';

// Types
export type {
    BrainBankConfig, ResolvedConfig,
    EmbeddingProvider,
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
export { cosineSimilarity, normalize } from './embeddings/math.ts';

// Vector
export { HNSWIndex } from './vector/hnsw.ts';
export { searchMMR } from './vector/mmr.ts';

// Indexers
export { CodeChunker } from './indexers/chunker.ts';
export { CodeIndexer } from './indexers/code-indexer.ts';
export { GitIndexer } from './indexers/git-indexer.ts';
export { DocIndexer } from './indexers/doc-indexer.ts';
export { SUPPORTED_EXTENSIONS, IGNORE_DIRS, isSupported, getLanguage } from './indexers/languages.ts';

// Memory
export { PatternStore } from './memory/pattern-store.ts';
export { Consolidator } from './memory/consolidator.ts';

// Query
export { ContextBuilder } from './query/context-builder.ts';
export { UnifiedSearch } from './query/search.ts';
export { CoEditAnalyzer } from './query/co-edits.ts';
export { BM25Search } from './query/bm25.ts';
export { reciprocalRankFusion } from './query/rrf.ts';

// Conversation Memory
export { ConversationStore } from './memory/conversation-store.ts';
export type { ConversationDigest, StoredMemory, RecallOptions } from './memory/conversation-store.ts';

// Config
export { resolveConfig, DEFAULTS } from './core/config.ts';

/**
 * BrainBank — Type Definitions
 * 
 * All interfaces and types for the semantic knowledge bank.
 */


import type { CollectionItem, CollectionSearchOptions, CollectionAddOptions } from './services/collection.ts';

// Re-export collection types so consumers don't need to import from services/
export type { CollectionItem, CollectionSearchOptions, CollectionAddOptions };


/** Public contract for a KV collection. Plugins depend on this interface, not the concrete class. */
export interface ICollection {
    /** Collection name. */
    readonly name: string;
    /** Add an item. Returns its ID. */
    add(content: string, options?: CollectionAddOptions | Record<string, unknown>): Promise<number>;
    /** Update an item's content (re-embeds). Returns the new ID. */
    update(id: number, content: string, options?: CollectionAddOptions): Promise<number>;
    /** Add multiple items. Returns their IDs. */
    addMany(items: { content: string; metadata?: Record<string, unknown>; tags?: string[]; ttl?: string }[]): Promise<number[]>;
    /** Search this collection. */
    search(query: string, options?: CollectionSearchOptions): Promise<CollectionItem[]>;
    /** List items (newest first). */
    list(options?: { limit?: number; offset?: number; tags?: string[] }): CollectionItem[];
    /** Count items in this collection. */
    count(): number;
    /** Keep only the N most recent items. */
    trim(options: { keep: number }): Promise<{ removed: number }>;
    /** Remove items older than a duration string. */
    prune(options: { olderThan: string }): Promise<{ removed: number }>;
    /** Remove a specific item by ID. */
    remove(id: number): void;
    /** Clear all items in this collection. */
    clear(): void;
}


export interface BrainBankConfig {
    /** Root path of the repository to index. Default: '.' */
    repoPath?: string;
    /** SQLite database path. Default: '.brainbank/data/brainbank.db' */
    dbPath?: string;

    /** Max git commits to index. Default: 500 */
    gitDepth?: number;
    /** Max file size in bytes to index. Default: 512_000 (500KB) */
    maxFileSize?: number;
    /** Max diff bytes per commit. Default: 8192 */
    maxDiffBytes?: number;
    /** HNSW M parameter (connections per node). Default: 16 */
    hnswM?: number;
    /** HNSW efConstruction (build-time candidates). Default: 200 */
    hnswEfConstruction?: number;
    /** HNSW efSearch (query-time candidates). Default: 50 */
    hnswEfSearch?: number;
    /** Embedding dimensions. Default: 384 */
    embeddingDims?: number;
    /** Max HNSW elements. Default: 2_000_000 */
    maxElements?: number;
    /** Custom embedding provider (default: local WASM model) */
    embeddingProvider?: EmbeddingProvider;
    /** Optional reranker for improved search quality */
    reranker?: Reranker;
    /** Optional LLM noise filter — drops irrelevant results before formatting */
    pruner?: Pruner;
    /** Port for optional webhook server (enables push-based watch plugins). */
    webhookPort?: number;
}

export interface ResolvedConfig {
    repoPath: string;
    dbPath: string;
    gitDepth: number;
    maxFileSize: number;
    maxDiffBytes: number;
    hnswM: number;
    hnswEfConstruction: number;
    hnswEfSearch: number;
    embeddingDims: number;
    maxElements: number;
    embeddingProvider?: EmbeddingProvider;
    reranker?: Reranker;
    pruner?: Pruner;
    webhookPort?: number;
}


export interface EmbeddingProvider {
    /** Vector dimensions produced by this provider. */
    readonly dims: number;
    /** Embed a single text string. */
    embed(text: string): Promise<Float32Array>;
    /** Embed multiple texts (batch). */
    embedBatch(texts: string[]): Promise<Float32Array[]>;
    /** Release resources. */
    close(): Promise<void>;
}


export interface Reranker {
    /**
     * Score each document's relevance to the query.
     * @param query - The search query
     * @param documents - Document contents to rank
     * @returns Relevance scores (0.0 - 1.0) in same order as documents
     */
    rank(query: string, documents: string[]): Promise<number[]>;
    /** Release resources (e.g. unload model). */
    close?(): Promise<void>;
}


/** Item passed to the pruner for noise classification. */
export interface PrunerItem {
    /** Positional index (used to map back to SearchResult[]) */
    id: number;
    /** File path — primary signal for relevance */
    filePath: string;
    /** Trimmed content preview */
    preview: string;
    /** Chunk metadata (type, name, language, lines, etc.) */
    metadata: Record<string, unknown>;
}

export interface Pruner {
    /**
     * Filter noise from search results.
     * @param query - The search query
     * @param items - Items to evaluate (filePath + metadata + trimmed preview)
     * @returns Array of item IDs to KEEP (everything else is dropped)
     */
    prune(query: string, items: PrunerItem[]): Promise<number[]>;
    /** Release resources. */
    close?(): Promise<void>;
}


export interface SearchHit {
    id: number;
    score: number;
}

export interface VectorIndex {
    /** Initialize the index. Must be called before add/search. */
    init(): Promise<this>;
    /** Add a vector with an integer ID. Idempotent: duplicate IDs are skipped. */
    add(vector: Float32Array, id: number): void;
    /** Mark a vector as deleted so it no longer appears in searches. */
    remove(id: number): void;
    /** Search for k nearest neighbors. */
    search(query: Float32Array, k: number): SearchHit[];
    /** Clear all vectors and reset to empty state. */
    reinit(): void;
    /** Number of vectors in the index. */
    readonly size: number;
}


export interface CodeChunk {
    /** Auto-incremented DB id (set after insert) */
    id?: number;
    /** Relative file path from repo root */
    filePath: string;
    /** Chunk type: 'file' | 'function' | 'class' | 'block' */
    chunkType: string;
    /** Function/class name (if detected) */
    name?: string;
    /** Start line (1-indexed) */
    startLine: number;
    /** End line (1-indexed, inclusive) */
    endLine: number;
    /** Raw content of the chunk */
    content: string;
    /** Language identifier */
    language: string;
}


export interface GitCommitRecord {
    id?: number;
    hash: string;
    shortHash: string;
    message: string;
    author: string;
    date: string;
    timestamp: number;
    filesChanged: string[];
    diff?: string;
    additions: number;
    deletions: number;
    isMerge: boolean;
}





export type SearchResultType = 'code' | 'commit' | 'document' | 'collection';

// Typed metadata per result type

export interface CodeResultMetadata {
    /** Database chunk ID (used by call graph annotations). */
    id?: number;
    /** File path (may duplicate CodeResult.filePath for metadata-only access). */
    filePath?: string;
    /** Adjacent chunk IDs from the same file (used by context expansion). */
    chunkIds?: number[];
    chunkType: string;
    name?: string;
    startLine: number;
    endLine: number;
    language: string;
    searchType?: string;
    rrfScore?: number;
}

export interface CommitResultMetadata {
    hash: string;
    shortHash: string;
    author: string;
    date: string;
    files: string[];
    additions?: number;
    deletions?: number;
    diff?: string;
    searchType?: string;
    rrfScore?: number;
}



export interface DocumentResultMetadata {
    collection?: string;
    title?: string;
    seq?: number;
    path?: string;
    searchType?: string;
    /** Internal chunk ID used by hybrid search to map fused results. */
    chunkId?: number;
    rrfScore?: number;
}

// Discriminated union

export interface CodeResult {
    type: 'code';
    score: number;
    filePath: string;
    content: string;
    context?: string;
    metadata: CodeResultMetadata;
}

export interface CommitResult {
    type: 'commit';
    score: number;
    filePath?: string;
    content: string;
    context?: string;
    metadata: CommitResultMetadata;
}



export interface DocumentResult {
    type: 'document';
    score: number;
    filePath: string;
    content: string;
    context?: string;
    metadata: DocumentResultMetadata;
}

export interface CollectionResultMetadata {
    id?: number;
    collection?: string;
    rrfScore?: number;
    [key: string]: unknown;
}

export interface CollectionResult {
    type: 'collection';
    score: number;
    filePath?: string;
    content: string;
    context?: string;
    metadata: CollectionResultMetadata;
}

export type SearchResult = CodeResult | CommitResult | DocumentResult | CollectionResult;


/** Narrow a SearchResult to CodeResult. */
export function isCodeResult(r: SearchResult): r is CodeResult {
    return r.type === 'code';
}
/** Narrow a SearchResult to CommitResult. */
export function isCommitResult(r: SearchResult): r is CommitResult {
    return r.type === 'commit';
}
/** Narrow a SearchResult to DocumentResult. */
export function isDocumentResult(r: SearchResult): r is DocumentResult {
    return r.type === 'document';
}

/** Narrow a SearchResult to CollectionResult. */
export function isCollectionResult(r: SearchResult): r is CollectionResult {
    return r.type === 'collection';
}


type MatchHandlers<T> = {
    code?:       (r: CodeResult)       => T;
    commit?:     (r: CommitResult)     => T;
    document?:   (r: DocumentResult)   => T;
    collection?: (r: CollectionResult) => T;
    _?:          (r: SearchResult)     => T;
};

/**
 * Pattern-match on SearchResult type. Calls the matching handler
 * or the `_` fallback. Returns undefined if no handler matches.
 */
export function matchResult<T>(
    result: SearchResult,
    handlers: MatchHandlers<T>,
): T | undefined {
    switch (result.type) {
        case 'code':       return (handlers.code       ?? handlers._)?.(result);
        case 'commit':     return (handlers.commit     ?? handlers._)?.(result);
        case 'document':   return (handlers.document   ?? handlers._)?.(result);
        case 'collection': return (handlers.collection ?? handlers._)?.(result);
    }
}


export interface ContextOptions {
    /** Per-source result limits. Built-in: 'code', 'git'. Default: { code: 6, git: 5 } */
    sources?: Record<string, number>;
    /** Files the agent is about to modify (improves co-edit suggestions) */
    affectedFiles?: string[];
    /** Minimum similarity score threshold. Default: 0.25 */
    minScore?: number;
    /** Use MMR for diversity. Default: true */
    useMMR?: boolean;
    /** MMR lambda (0 = diversity, 1 = relevance). Default: 0.7 */
    mmrLambda?: number;
    /** Filter results to files under this path prefix (e.g. 'src/services/'). */
    pathPrefix?: string;
    /** File paths to exclude from results (e.g. files already returned in a previous query). */
    excludeFiles?: Set<string>;
    /** Optional per-request pruner override (e.g. HaikuPruner for LLM noise filtering). */
    pruner?: Pruner;
}


export interface DocumentCollection {
    /** Collection name (e.g. 'notes', 'docs') */
    name: string;
    /** Directory path to index */
    path: string;
    /** Glob pattern for files (default: all markdown) */
    pattern?: string;
    /** Glob patterns to ignore */
    ignore?: string[];
    /** Context description for this collection */
    context?: string;
}

export interface DocChunk {
    id?: number;
    /** Collection name */
    collection: string;
    /** Relative file path within the collection */
    filePath: string;
    /** Document title (first heading or filename) */
    title: string;
    /** Chunk content */
    content: string;
    /** Chunk sequence within the document (0, 1, 2...) */
    seq: number;
    /** Character position in original document */
    pos: number;
    /** Content hash for incremental updates */
    contentHash: string;
}


/** Plugin-provided stats. Key is the plugin name. */
export interface IndexStats {
    [pluginName: string]: Record<string, number | string> | undefined;
}


/** File-level progress (used by indexers). */
export type ProgressCallback = (file: string, current: number, total: number) => void;

/** Stage-level progress (used by BrainBank.index() orchestrator). */
export type StageProgressCallback = (stage: string, message: string) => void;

export interface IndexResult {
    indexed: number;
    skipped: number;
    chunks?: number;
}


export interface CoEditSuggestion {
    file: string;
    count: number;
}


/** Generalized watch event — works for files, APIs, webhooks. */
export interface WatchEvent {
    /** Event type. 'sync' is for batch/poll sources that don't distinguish CRUD. */
    type: 'create' | 'update' | 'delete' | 'sync';
    /** Unique ID of the changed item (file path, PR#123, PROJ-456, etc.). */
    sourceId: string;
    /** Source descriptor (e.g. 'file', 'github:pr', 'jira:card'). */
    sourceName: string;
    /** Optional raw payload to avoid re-fetching. */
    payload?: unknown;
}

/** Callback that plugins invoke when they detect a change. */
export type WatchEventHandler = (event: WatchEvent) => void;

/** Lifecycle handle returned by WatchablePlugin.watch(). */
export interface WatchHandle {
    /** Stop watching and release resources. */
    stop(): Promise<void>;
    /** Whether the watcher is still active. */
    readonly active: boolean;
}

/** Optional hints from plugin to core — debounce, batching, priority. */
export interface WatchConfig {
    /** Debounce interval in ms. 0 = process immediately. Default: inherited from WatchOptions. */
    debounceMs?: number;
    /** Max events to batch before triggering re-index. Default: unlimited. */
    batchSize?: number;
    /** Processing priority. Default: 'realtime'. */
    priority?: 'realtime' | 'background';
}

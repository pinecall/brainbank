/**
 * BrainBank — Type Definitions
 * 
 * All interfaces and types for the semantic knowledge bank.
 */



// ── Configuration ───────────────────────────────────

export interface BrainBankConfig {
    /** Root path of the repository to index. Default: '.' */
    repoPath?: string;
    /** SQLite database path. Default: '.brainbank/brainbank.db' */
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
}

// ── Embedding Provider ──────────────────────────────

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

// ── Reranker ────────────────────────────────────────

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

// ── Vector Index ────────────────────────────────────

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

// ── Code Chunking ───────────────────────────────────

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

// ── Git ─────────────────────────────────────────────

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

// ── Agent Learning ─────────────────────────────────────────

export interface LearningPattern {
    id?: number;
    /** Category (e.g. 'api', 'refactor', 'debug') */
    taskType: string;
    /** What was the task */
    task: string;
    /** How it was approached */
    approach: string;
    /** What happened */
    outcome?: string;
    /** 0.0 – 1.0 */
    successRate: number;
    /** Lessons learned */
    critique?: string;
    /** Tokens consumed (optional tracking) */
    tokensUsed?: number;
    /** Latency in ms (optional tracking) */
    latencyMs?: number;
}

export interface DistilledStrategy {
    taskType: string;
    strategy: string;
    confidence: number;
    updatedAt: number;
}

// ── Search Results ──────────────────────────────────

export type SearchResultType = 'code' | 'commit' | 'pattern' | 'document' | 'collection';

// Typed metadata per result type

export interface CodeResultMetadata {
    chunkType: string;
    name?: string;
    startLine: number;
    endLine: number;
    language: string;
    searchType?: string;
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
}

export interface PatternResultMetadata {
    taskType: string;
    task: string;
    outcome?: string;
    successRate: number;
    critique?: string;
    searchType?: string;
}

export interface DocumentResultMetadata {
    collection?: string;
    title?: string;
    seq?: number;
    path?: string;
    searchType?: string;
    /** Internal chunk ID used by hybrid search to map fused results. */
    chunkId?: number;
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

export interface PatternResult {
    type: 'pattern';
    score: number;
    filePath?: string;
    content: string;
    context?: string;
    metadata: PatternResultMetadata;
}

export interface DocumentResult {
    type: 'document';
    score: number;
    filePath: string;
    content: string;
    context?: string;
    metadata: DocumentResultMetadata;
}

export interface CollectionResult {
    type: 'collection';
    score: number;
    filePath?: string;
    content: string;
    context?: string;
    metadata: Record<string, any>;
}

export type SearchResult = CodeResult | CommitResult | PatternResult | DocumentResult | CollectionResult;

// ── Type Guards ──────────────────────────────────────

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
/** Narrow a SearchResult to PatternResult. */
export function isPatternResult(r: SearchResult): r is PatternResult {
    return r.type === 'pattern';
}
/** Narrow a SearchResult to CollectionResult. */
export function isCollectionResult(r: SearchResult): r is CollectionResult {
    return r.type === 'collection';
}

// ── Match Helper ─────────────────────────────────────

type MatchHandlers<T> = {
    code?:       (r: CodeResult)       => T;
    commit?:     (r: CommitResult)     => T;
    pattern?:    (r: PatternResult)    => T;
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
        case 'pattern':    return (handlers.pattern    ?? handlers._)?.(result);
        case 'document':   return (handlers.document   ?? handlers._)?.(result);
        case 'collection': return (handlers.collection ?? handlers._)?.(result);
    }
}

// ── Context Builder ─────────────────────────────────

export interface ContextOptions {
    /** Max code chunks to include. Default: 6 */
    codeResults?: number;
    /** Max git commits to include. Default: 5 */
    gitResults?: number;
    /** Max memory patterns to include. Default: 4 */
    patternResults?: number;
    /** Files the agent is about to modify (improves co-edit suggestions) */
    affectedFiles?: string[];
    /** Minimum similarity score threshold. Default: 0.25 */
    minScore?: number;
    /** Use MMR for diversity. Default: true */
    useMMR?: boolean;
    /** MMR lambda (0 = diversity, 1 = relevance). Default: 0.7 */
    mmrLambda?: number;
}

// ── Document Collections ────────────────────────────

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

// ── Stats ───────────────────────────────────────────

export interface IndexStats {
    code?: {
        files: number;
        chunks: number;
        hnswSize: number;
    };
    git?: {
        commits: number;
        filesTracked: number;
        coEdits: number;
        hnswSize: number;
    };
    memory?: {
        patterns: number;
        avgSuccess: number;
        hnswSize: number;
    };
    documents?: {
        collections: number;
        documents: number;
        chunks: number;
        hnswSize: number;
    };
}

// ── Index Progress ──────────────────────────────────

/** File-level progress (used by indexers). */
export type ProgressCallback = (file: string, current: number, total: number) => void;

/** Stage-level progress (used by BrainBank.index() orchestrator). */
export type StageProgressCallback = (stage: string, message: string) => void;

export interface IndexResult {
    indexed: number;
    skipped: number;
    chunks?: number;
}

// ── Co-Edits ────────────────────────────────────────

export interface CoEditSuggestion {
    file: string;
    count: number;
}

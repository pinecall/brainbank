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
    /** Add a vector with an integer ID. */
    add(vector: Float32Array, id: number): void;
    /** Search for k nearest neighbors. */
    search(query: Float32Array, k: number): SearchHit[];
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

// ── Agent Memory ────────────────────────────────────

export interface MemoryPattern {
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

export type SearchResultType = 'code' | 'commit' | 'pattern' | 'document';

export interface SearchResult {
    type: SearchResultType;
    score: number;
    /** File path (for code results) or document path */
    filePath?: string;
    /** Content / text */
    content: string;
    /** Context description (for document results) */
    context?: string;
    /** Extra metadata depending on type */
    metadata: Record<string, any>;
}

// ── Context Builder ─────────────────────────────────

export interface ContextOptions {
    /** Max code chunks to include. Default: 6 */
    codeResults?: number;
    /** Max git commits to include. Default: 5 */
    gitResults?: number;
    /** Max memory patterns to include. Default: 4 */
    memoryResults?: number;
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
    /** Glob pattern for files. Default: '**/*.md' */
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
    notes?: {
        total: number;
        short: number;
        long: number;
    };
}

// ── Index Progress ──────────────────────────────────

export type ProgressCallback = (file: string, current: number, total: number) => void;

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

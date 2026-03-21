/**
 * BrainBank — Main Orchestrator
 * 
 * The single entry point for semantic knowledge operations.
 * Ties together: indexing, search, memory, and context building.
 * 
 *   const brain = new BrainBank({ repoPath: '.' });
 *   await brain.index();
 *   const context = await brain.getContext('add auth');
 *   await brain.learn({ taskType: 'api', task: '...', approach: '...', successRate: 0.9 });
 *   brain.close();
 */

import { EventEmitter } from 'node:events';
import { resolveConfig } from './config.ts';
import { Database } from '../storage/database.ts';
import { HNSWIndex } from '../vector/hnsw.ts';
import { LocalEmbedding } from '../embeddings/local.ts';
import { CodeIndexer } from '../indexers/code-indexer.ts';
import { GitIndexer } from '../indexers/git-indexer.ts';
import { PatternStore } from '../memory/pattern-store.ts';
import { Consolidator } from '../memory/consolidator.ts';
import { StrategyDistiller } from '../memory/strategy-distiller.ts';
import { ConversationStore } from '../memory/conversation-store.ts';
import type { ConversationDigest, StoredMemory, RecallOptions } from '../memory/conversation-store.ts';
import { UnifiedSearch } from '../query/search.ts';
import { BM25Search } from '../query/bm25.ts';
import { reciprocalRankFusion } from '../query/rrf.ts';
import { ContextBuilder } from '../query/context-builder.ts';
import { CoEditAnalyzer } from '../query/co-edits.ts';
import type {
    BrainBankConfig, ResolvedConfig, EmbeddingProvider,
    IndexResult, IndexStats, MemoryPattern, SearchResult,
    ContextOptions, CoEditSuggestion, ProgressCallback,
    DistilledStrategy,
} from '../types.ts';

export class BrainBank extends EventEmitter {
    private _config: ResolvedConfig;
    private _db!: Database;
    private _embedding!: EmbeddingProvider;

    // HNSW indices (one per domain)
    private _codeHnsw!: HNSWIndex;
    private _gitHnsw!: HNSWIndex;
    private _memHnsw!: HNSWIndex;
    private _convHnsw!: HNSWIndex;

    // Vector caches (id → Float32Array)
    private _codeVecs = new Map<number, Float32Array>();
    private _gitVecs  = new Map<number, Float32Array>();
    private _memVecs  = new Map<number, Float32Array>();
    private _convVecs = new Map<number, Float32Array>();

    // Sub-systems
    private _codeIndexer!: CodeIndexer;
    private _gitIndexer!: GitIndexer;
    private _patternStore!: PatternStore;
    private _consolidator!: Consolidator;
    private _distiller!: StrategyDistiller;
    private _search!: UnifiedSearch;
    private _bm25!: BM25Search;
    private _contextBuilder!: ContextBuilder;
    private _coEdits!: CoEditAnalyzer;
    private _conversations!: ConversationStore;

    private _initialized = false;

    constructor(config: BrainBankConfig = {}) {
        super();
        this._config = resolveConfig(config);
    }

    // ── Initialization ──────────────────────────────

    /**
     * Initialize database, HNSW indices, and load existing vectors.
     * Automatically called by index/search methods if not yet initialized.
     */
    async initialize(): Promise<void> {
        if (this._initialized) return;

        // Database
        this._db = new Database(this._config.dbPath);

        // Embedding provider
        this._embedding = this._config.embeddingProvider ?? new LocalEmbedding();

        // HNSW indices
        const dims = this._config.embeddingDims;
        const M = this._config.hnswM;
        const efC = this._config.hnswEfConstruction;
        const efS = this._config.hnswEfSearch;
        const max = this._config.maxElements;

        this._codeHnsw = await new HNSWIndex(dims, max, M, efC, efS).init();
        this._gitHnsw  = await new HNSWIndex(dims, 500_000, M, efC, efS).init();
        this._memHnsw  = await new HNSWIndex(dims, 100_000, M, efC, efS).init();
        this._convHnsw = await new HNSWIndex(dims, 100_000, M, efC, efS).init();

        // Load existing vectors from DB into HNSW
        this._loadVectors('code_vectors', 'chunk_id', this._codeHnsw, this._codeVecs);
        this._loadVectors('git_vectors', 'commit_id', this._gitHnsw, this._gitVecs);
        this._loadVectors('memory_vectors', 'pattern_id', this._memHnsw, this._memVecs);
        this._loadVectors('conversation_vectors', 'memory_id', this._convHnsw, this._convVecs);

        // Wire up sub-systems
        this._codeIndexer = new CodeIndexer(this._config.repoPath, {
            db: this._db,
            hnsw: this._codeHnsw,
            vectorCache: this._codeVecs,
            embedding: this._embedding,
        }, this._config.maxFileSize);

        this._gitIndexer = new GitIndexer(this._config.repoPath, {
            db: this._db,
            hnsw: this._gitHnsw,
            vectorCache: this._gitVecs,
            embedding: this._embedding,
        }, this._config.maxDiffBytes);

        this._patternStore = new PatternStore({
            db: this._db,
            hnsw: this._memHnsw,
            vectorCache: this._memVecs,
            embedding: this._embedding,
        });

        this._consolidator = new Consolidator(this._db, this._memVecs);
        this._distiller = new StrategyDistiller(this._db);
        this._coEdits = new CoEditAnalyzer(this._db);

        this._search = new UnifiedSearch({
            db: this._db,
            codeHnsw: this._codeHnsw,
            gitHnsw: this._gitHnsw,
            memHnsw: this._memHnsw,
            codeVecs: this._codeVecs,
            gitVecs: this._gitVecs,
            memVecs: this._memVecs,
            embedding: this._embedding,
        });

        this._bm25 = new BM25Search(this._db);

        this._conversations = new ConversationStore(this._db, this._embedding, this._convHnsw, this._convVecs);

        this._contextBuilder = new ContextBuilder(this._search, this._coEdits);

        this._initialized = true;
        this.emit('initialized');
    }

    // ── Indexing ─────────────────────────────────────

    /**
     * Index code and git history in one call.
     * Incremental — only processes changes since last run.
     */
    async index(options: {
        gitDepth?: number;
        forceReindex?: boolean;
        onProgress?: (stage: string, msg: string) => void;
    } = {}): Promise<{ code: IndexResult; git: IndexResult }> {
        await this.initialize();

        options.onProgress?.('code', 'Starting...');
        const code = await this._codeIndexer.index({
            forceReindex: options.forceReindex,
            onProgress: (f, i, t) => options.onProgress?.('code', `[${i}/${t}] ${f}`),
        });

        options.onProgress?.('git', 'Starting...');
        const git = await this._gitIndexer.index({
            depth: options.gitDepth ?? this._config.gitDepth,
            onProgress: (f, i, t) => options.onProgress?.('git', `[${i}/${t}] ${f}`),
        });

        this.emit('indexed', { code, git });
        return { code, git };
    }

    /** Index only code files. */
    async indexCode(options: {
        forceReindex?: boolean;
        onProgress?: ProgressCallback;
    } = {}): Promise<IndexResult> {
        await this.initialize();
        return this._codeIndexer.index(options);
    }

    /** Index only git history. */
    async indexGit(options: {
        depth?: number;
        onProgress?: ProgressCallback;
    } = {}): Promise<IndexResult> {
        await this.initialize();
        return this._gitIndexer.index(options);
    }

    // ── Context ─────────────────────────────────────

    /**
     * Get formatted context for a task.
     * Returns markdown ready for system prompt injection.
     */
    async getContext(task: string, options: ContextOptions = {}): Promise<string> {
        await this.initialize();
        return this._contextBuilder.build(task, options);
    }

    // ── Search ──────────────────────────────────────

    /** Semantic search across all indices. */
    async search(query: string, options?: {
        codeK?: number; gitK?: number; memoryK?: number;
        minScore?: number; useMMR?: boolean;
    }): Promise<SearchResult[]> {
        await this.initialize();
        return this._search.search(query, options);
    }

    /** Semantic search over code only. */
    async searchCode(query: string, k: number = 8): Promise<SearchResult[]> {
        await this.initialize();
        return this._search.search(query, { codeK: k, gitK: 0, memoryK: 0 });
    }

    /** Semantic search over commits only. */
    async searchCommits(query: string, k: number = 8): Promise<SearchResult[]> {
        await this.initialize();
        return this._search.search(query, { codeK: 0, gitK: k, memoryK: 0 });
    }

    // ── Hybrid Search ───────────────────────────────

    /**
     * Hybrid search: vector (semantic) + BM25 (keyword) fused with Reciprocal Rank Fusion.
     * Best quality — catches both exact keyword matches and conceptual similarities.
     */
    async hybridSearch(query: string, options?: {
        codeK?: number; gitK?: number; memoryK?: number;
        minScore?: number; useMMR?: boolean;
    }): Promise<SearchResult[]> {
        await this.initialize();

        // Run both searches in parallel
        const [vectorResults, bm25Results] = await Promise.all([
            this._search.search(query, options),
            Promise.resolve(this._bm25.search(query, options)),
        ]);

        // Fuse with RRF
        return reciprocalRankFusion([vectorResults, bm25Results]);
    }

    /** BM25 keyword search only (no embeddings needed). */
    searchBM25(query: string, options?: {
        codeK?: number; gitK?: number; memoryK?: number;
    }): SearchResult[] {
        return this._bm25.search(query, options);
    }

    /** Rebuild FTS5 indices (after bulk import or if out of sync). */
    rebuildFTS(): void {
        this._bm25.rebuild();
    }

    // ── Memory / Learning ───────────────────────────

    /** Store a learned pattern from a completed task. */
    async learn(pattern: MemoryPattern): Promise<number> {
        await this.initialize();
        const id = await this._patternStore.learn(pattern);

        // Auto-consolidate every 50 patterns
        if (this._patternStore.count % 50 === 0) {
            this._consolidator.consolidate();
        }

        this.emit('learned', { id, pattern });
        return id;
    }

    /** Search for similar learned patterns. */
    async searchPatterns(query: string, k: number = 4): Promise<(MemoryPattern & { score: number })[]> {
        await this.initialize();
        return this._patternStore.search(query, k);
    }

    /** Consolidate memory: prune old failures + deduplicate. */
    consolidate(): { pruned: number; deduped: number } {
        return this._consolidator.consolidate();
    }

    /** Distill top patterns into a strategy for a task type. */
    distill(taskType: string): DistilledStrategy | null {
        return this._distiller.distill(taskType);
    }

    // ── Conversation Memory ─────────────────────────

    /** Store a conversation digest for long-term memory. */
    async remember(digest: ConversationDigest): Promise<number> {
        await this.initialize();
        const id = await this._conversations.remember(digest);
        this.emit('remembered', { id, digest });
        return id;
    }

    /** Recall relevant conversation memories (hybrid search by default). */
    async recall(query: string, options?: RecallOptions): Promise<StoredMemory[]> {
        await this.initialize();
        return this._conversations.recall(query, options);
    }

    /** List recent conversation memories. */
    listMemories(limit?: number, tier?: 'short' | 'long'): StoredMemory[] {
        return this._conversations.list(limit, tier);
    }

    /** Consolidate old conversation memories (short → long tier). */
    consolidateMemories(keepRecent?: number): { promoted: number } {
        return this._conversations.consolidate(keepRecent);
    }

    // ── Query ───────────────────────────────────────

    /** Get git history for a specific file. */
    async fileHistory(filePath: string, limit: number = 20): Promise<any[]> {
        await this.initialize();
        return this._db.prepare(`
            SELECT c.short_hash, c.message, c.author, c.date, c.additions, c.deletions
            FROM git_commits c
            INNER JOIN commit_files cf ON c.id = cf.commit_id
            WHERE cf.file_path LIKE ? AND c.is_merge = 0
            ORDER BY c.timestamp DESC LIMIT ?
        `).all(`%${filePath}%`, limit) as any[];
    }

    /** Get co-edit suggestions for a file. */
    coEdits(filePath: string, limit: number = 5): CoEditSuggestion[] {
        return this._coEdits.suggest(filePath, limit);
    }

    // ── Stats ───────────────────────────────────────

    /** Get statistics for all indices. */
    stats(): IndexStats {
        return {
            code: {
                files: (this._db.prepare('SELECT COUNT(DISTINCT file_path) as c FROM code_chunks').get() as any).c,
                chunks: (this._db.prepare('SELECT COUNT(*) as c FROM code_chunks').get() as any).c,
                hnswSize: this._codeHnsw.size,
            },
            git: {
                commits: (this._db.prepare('SELECT COUNT(*) as c FROM git_commits').get() as any).c,
                filesTracked: (this._db.prepare('SELECT COUNT(DISTINCT file_path) as c FROM commit_files').get() as any).c,
                coEdits: (this._db.prepare('SELECT COUNT(*) as c FROM co_edits').get() as any).c,
                hnswSize: this._gitHnsw.size,
            },
            memory: {
                patterns: (this._db.prepare('SELECT COUNT(*) as c FROM memory_patterns').get() as any).c,
                avgSuccess: (this._db.prepare('SELECT AVG(success_rate) as a FROM memory_patterns').get() as any).a ?? 0,
                hnswSize: this._memHnsw.size,
            },
            conversations: this._conversations.count(),
        };
    }

    // ── Lifecycle ────────────────────────────────────

    /** Close database and release resources. */
    close(): void {
        if (this._db) this._db.close();
        this._initialized = false;
    }

    /** Whether the brainbank has been initialized. */
    get isInitialized(): boolean {
        return this._initialized;
    }

    /** The resolved configuration. */
    get config(): Readonly<ResolvedConfig> {
        return this._config;
    }

    // ── Internals ───────────────────────────────────

    /**
     * Load existing vectors from SQLite into HNSW index.
     * Called during initialization to restore state.
     */
    private _loadVectors(
        table: string,
        idCol: string,
        hnsw: HNSWIndex,
        cache: Map<number, Float32Array>,
    ): void {
        const rows = this._db.prepare(`SELECT ${idCol}, embedding FROM ${table}`).all() as any[];
        for (const row of rows) {
            const vec = new Float32Array(row.embedding.buffer.slice(
                row.embedding.byteOffset,
                row.embedding.byteOffset + row.embedding.byteLength,
            ));
            hnsw.add(vec, row[idCol]);
            cache.set(row[idCol], vec);
        }
    }
}

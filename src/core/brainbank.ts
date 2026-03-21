/**
 * BrainBank — Main Orchestrator
 * 
 * The single entry point for semantic knowledge operations.
 * Ties together: indexing, search, memory, and context building.
 * 
 * Features are modular — enable only what you need:
 * 
 *   // Full (coding agent)
 *   const brain = new BrainBank({ repoPath: '.' });
 * 
 *   // Documents + conversations only (non-coding agent)
 *   const brain = new BrainBank({
 *     dbPath: './knowledge.db',
 *     features: { code: false, git: false, documents: true, conversations: true, patterns: false },
 *   });
 * 
 *   // Conversation memory only
 *   const brain = new BrainBank({
 *     dbPath: './memory.db',
 *     features: { code: false, git: false, documents: false, conversations: true, patterns: false },
 *   });
 */

import { EventEmitter } from 'node:events';
import { resolveConfig } from './config.ts';
import { Database } from '../storage/database.ts';
import { HNSWIndex } from '../vector/hnsw.ts';
import { LocalEmbedding } from '../embeddings/local.ts';
import { CodeIndexer } from '../indexers/code-indexer.ts';
import { GitIndexer } from '../indexers/git-indexer.ts';
import { DocIndexer } from '../indexers/doc-indexer.ts';
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
    BrainBankConfig, ResolvedConfig, EmbeddingProvider, ResolvedFeatureFlags,
    IndexResult, IndexStats, MemoryPattern, SearchResult, DocumentCollection,
    ContextOptions, CoEditSuggestion, ProgressCallback,
    DistilledStrategy,
} from '../types.ts';

export class BrainBank extends EventEmitter {
    private _config: ResolvedConfig;
    private _db!: Database;
    private _embedding!: EmbeddingProvider;

    // HNSW indices (one per domain, created on demand)
    private _codeHnsw?: HNSWIndex;
    private _gitHnsw?: HNSWIndex;
    private _memHnsw?: HNSWIndex;
    private _convHnsw?: HNSWIndex;
    private _docHnsw?: HNSWIndex;

    // Vector caches (id → Float32Array)
    private _codeVecs = new Map<number, Float32Array>();
    private _gitVecs  = new Map<number, Float32Array>();
    private _memVecs  = new Map<number, Float32Array>();
    private _convVecs = new Map<number, Float32Array>();
    private _docVecs  = new Map<number, Float32Array>();

    // Sub-systems (created on demand)
    private _codeIndexer?: CodeIndexer;
    private _gitIndexer?: GitIndexer;
    private _docIndexer?: DocIndexer;
    private _patternStore?: PatternStore;
    private _consolidator?: Consolidator;
    private _distiller?: StrategyDistiller;
    private _search?: UnifiedSearch;
    private _bm25?: BM25Search;
    private _contextBuilder?: ContextBuilder;
    private _coEdits?: CoEditAnalyzer;
    private _conversations?: ConversationStore;

    private _initialized = false;

    constructor(config: BrainBankConfig = {}) {
        super();
        this._config = resolveConfig(config);
    }

    // ── Feature Helpers ─────────────────────────────

    /** Get the resolved feature flags. */
    get features(): Readonly<ResolvedFeatureFlags> {
        return this._config.features;
    }

    /** Throw if a feature is disabled. */
    private _require(feature: keyof ResolvedFeatureFlags, method: string): void {
        if (!this._config.features[feature]) {
            throw new Error(
                `BrainBank: '${method}' requires the '${feature}' feature to be enabled. ` +
                `Set features.${feature}: true in your config.`
            );
        }
    }

    // ── Initialization ──────────────────────────────

    /**
     * Initialize database, HNSW indices, and load existing vectors.
     * Only initializes sub-systems for enabled features.
     * Automatically called by index/search methods if not yet initialized.
     */
    async initialize(): Promise<void> {
        if (this._initialized) return;

        const { features } = this._config;
        const dims = this._config.embeddingDims;
        const M = this._config.hnswM;
        const efC = this._config.hnswEfConstruction;
        const efS = this._config.hnswEfSearch;
        const max = this._config.maxElements;

        // Database (always needed)
        this._db = new Database(this._config.dbPath);

        // Embedding provider (needed if any vector feature is enabled)
        const needsEmbeddings = features.code || features.git || features.patterns || features.conversations || features.documents;
        if (needsEmbeddings) {
            this._embedding = this._config.embeddingProvider ?? new LocalEmbedding();
        }

        // ── Code ──
        if (features.code) {
            this._codeHnsw = await new HNSWIndex(dims, max, M, efC, efS).init();
            this._loadVectors('code_vectors', 'chunk_id', this._codeHnsw, this._codeVecs);

            this._codeIndexer = new CodeIndexer(this._config.repoPath, {
                db: this._db,
                hnsw: this._codeHnsw,
                vectorCache: this._codeVecs,
                embedding: this._embedding,
            }, this._config.maxFileSize);
        }

        // ── Git ──
        if (features.git) {
            this._gitHnsw = await new HNSWIndex(dims, 500_000, M, efC, efS).init();
            this._loadVectors('git_vectors', 'commit_id', this._gitHnsw, this._gitVecs);

            this._gitIndexer = new GitIndexer(this._config.repoPath, {
                db: this._db,
                hnsw: this._gitHnsw,
                vectorCache: this._gitVecs,
                embedding: this._embedding,
            }, this._config.maxDiffBytes);
        }

        // ── Patterns (Agent Memory) ──
        if (features.patterns) {
            this._memHnsw = await new HNSWIndex(dims, 100_000, M, efC, efS).init();
            this._loadVectors('memory_vectors', 'pattern_id', this._memHnsw, this._memVecs);

            this._patternStore = new PatternStore({
                db: this._db,
                hnsw: this._memHnsw,
                vectorCache: this._memVecs,
                embedding: this._embedding,
            });

            this._consolidator = new Consolidator(this._db, this._memVecs);
            this._distiller = new StrategyDistiller(this._db);
        }

        // ── Conversations ──
        if (features.conversations) {
            this._convHnsw = await new HNSWIndex(dims, 100_000, M, efC, efS).init();
            this._loadVectors('conversation_vectors', 'memory_id', this._convHnsw, this._convVecs);

            this._conversations = new ConversationStore(this._db, this._embedding, this._convHnsw, this._convVecs);
        }

        // ── Documents ──
        if (features.documents) {
            this._docHnsw = await new HNSWIndex(dims, max, M, efC, efS).init();
            this._loadVectors('doc_vectors', 'chunk_id', this._docHnsw, this._docVecs);

            this._docIndexer = new DocIndexer(this._db, this._embedding, this._docHnsw, this._docVecs);
        }

        // ── Search (cross-feature) ──
        if (features.code || features.git || features.patterns) {
            this._search = new UnifiedSearch({
                db: this._db,
                codeHnsw: this._codeHnsw!,
                gitHnsw: this._gitHnsw!,
                memHnsw: this._memHnsw!,
                codeVecs: this._codeVecs,
                gitVecs: this._gitVecs,
                memVecs: this._memVecs,
                embedding: this._embedding,
            });

            this._bm25 = new BM25Search(this._db);
        }

        // ── Co-edits (needs git) ──
        if (features.git) {
            this._coEdits = new CoEditAnalyzer(this._db);
        }

        // ── Context Builder ──
        if (this._search) {
            this._contextBuilder = new ContextBuilder(this._search, this._coEdits!);
        }

        this._initialized = true;
        this.emit('initialized', { features });
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
    } = {}): Promise<{ code?: IndexResult; git?: IndexResult }> {
        await this.initialize();

        const result: { code?: IndexResult; git?: IndexResult } = {};

        if (this._config.features.code) {
            options.onProgress?.('code', 'Starting...');
            result.code = await this._codeIndexer!.index({
                forceReindex: options.forceReindex,
                onProgress: (f, i, t) => options.onProgress?.('code', `[${i}/${t}] ${f}`),
            });
        }

        if (this._config.features.git) {
            options.onProgress?.('git', 'Starting...');
            result.git = await this._gitIndexer!.index({
                depth: options.gitDepth ?? this._config.gitDepth,
                onProgress: (f, i, t) => options.onProgress?.('git', `[${i}/${t}] ${f}`),
            });
        }

        this.emit('indexed', result);
        return result;
    }

    /** Index only code files. */
    async indexCode(options: {
        forceReindex?: boolean;
        onProgress?: ProgressCallback;
    } = {}): Promise<IndexResult> {
        this._require('code', 'indexCode');
        await this.initialize();
        return this._codeIndexer!.index(options);
    }

    /** Index only git history. */
    async indexGit(options: {
        depth?: number;
        onProgress?: ProgressCallback;
    } = {}): Promise<IndexResult> {
        this._require('git', 'indexGit');
        await this.initialize();
        return this._gitIndexer!.index(options);
    }

    // ── Document Collections ────────────────────────

    /**
     * Register a document collection.
     * Collections group files by directory for targeted indexing and search.
     */
    async addCollection(collection: DocumentCollection): Promise<void> {
        this._require('documents', 'addCollection');
        await this.initialize();

        this._db.prepare(`
            INSERT OR REPLACE INTO collections (name, path, pattern, ignore_json, context)
            VALUES (?, ?, ?, ?, ?)
        `).run(
            collection.name,
            collection.path,
            collection.pattern ?? '**/*.md',
            JSON.stringify(collection.ignore ?? []),
            collection.context ?? null,
        );
    }

    /**
     * Remove a collection and all its indexed data.
     */
    async removeCollection(name: string): Promise<void> {
        this._require('documents', 'removeCollection');
        await this.initialize();
        this._docIndexer!.removeCollection(name);
    }

    /** List all registered collections. */
    listCollections(): DocumentCollection[] {
        return (this._db.prepare('SELECT * FROM collections').all() as any[]).map(row => ({
            name: row.name,
            path: row.path,
            pattern: row.pattern,
            ignore: JSON.parse(row.ignore_json),
            context: row.context,
        }));
    }

    /**
     * Index all registered collections (or specific ones).
     * Incremental — only re-indexes changed files.
     */
    async indexDocs(options: {
        collections?: string[];
        onProgress?: (collection: string, file: string, current: number, total: number) => void;
    } = {}): Promise<{ [collection: string]: { indexed: number; skipped: number; chunks: number } }> {
        this._require('documents', 'indexDocs');
        await this.initialize();

        const allCollections = this.listCollections();
        const toIndex = options.collections
            ? allCollections.filter(c => options.collections!.includes(c.name))
            : allCollections;

        const results: Record<string, { indexed: number; skipped: number; chunks: number }> = {};

        for (const coll of toIndex) {
            results[coll.name] = await this._docIndexer!.indexCollection(
                coll.name,
                coll.path,
                coll.pattern,
                {
                    ignore: coll.ignore,
                    onProgress: (file, cur, total) => options.onProgress?.(coll.name, file, cur, total),
                },
            );
        }

        this.emit('docsIndexed', results);
        return results;
    }

    /** Search documents only. */
    async searchDocs(query: string, options?: {
        collection?: string;
        k?: number;
        minScore?: number;
    }): Promise<SearchResult[]> {
        this._require('documents', 'searchDocs');
        await this.initialize();

        const k = options?.k ?? 8;
        const queryVec = await this._embedding.embed(query);
        const hits = this._docHnsw!.search(queryVec, k);

        const results: SearchResult[] = [];
        for (const hit of hits) {
            if (options?.minScore && hit.score < options.minScore) continue;

            const chunk = this._db.prepare(
                'SELECT * FROM doc_chunks WHERE id = ?'
            ).get(hit.id) as any;

            if (!chunk) continue;
            if (options?.collection && chunk.collection !== options.collection) continue;

            // Get context from collection or path_contexts
            const ctx = this._getDocContext(chunk.collection, chunk.file_path);

            results.push({
                type: 'document',
                score: hit.score,
                filePath: chunk.file_path,
                content: chunk.content,
                context: ctx,
                metadata: {
                    collection: chunk.collection,
                    title: chunk.title,
                    seq: chunk.seq,
                },
            });
        }

        return results;
    }

    // ── Context Metadata ────────────────────────────

    /** Add context description for a collection path. */
    addContext(collection: string, path: string, context: string): void {
        this._db.prepare(`
            INSERT OR REPLACE INTO path_contexts (collection, path, context)
            VALUES (?, ?, ?)
        `).run(collection, path, context);
    }

    /** Remove context for a collection path. */
    removeContext(collection: string, path: string): void {
        this._db.prepare(
            'DELETE FROM path_contexts WHERE collection = ? AND path = ?'
        ).run(collection, path);
    }

    /** List all context entries. */
    listContexts(): { collection: string; path: string; context: string }[] {
        return this._db.prepare('SELECT * FROM path_contexts').all() as any[];
    }

    /** Resolve context for a document (checks path_contexts tree + collection context). */
    private _getDocContext(collection: string, filePath: string): string | undefined {
        // Check specific path contexts (most specific first)
        const parts = filePath.split('/');
        for (let i = parts.length; i >= 0; i--) {
            const checkPath = i === 0 ? '/' : '/' + parts.slice(0, i).join('/');
            const ctx = this._db.prepare(
                'SELECT context FROM path_contexts WHERE collection = ? AND path = ?'
            ).get(collection, checkPath) as any;
            if (ctx) return ctx.context;
        }

        // Fall back to collection-level context
        const coll = this._db.prepare(
            'SELECT context FROM collections WHERE name = ?'
        ).get(collection) as any;
        return coll?.context ?? undefined;
    }

    // ── Context ─────────────────────────────────────

    /**
     * Get formatted context for a task.
     * Returns markdown ready for system prompt injection.
     */
    async getContext(task: string, options: ContextOptions = {}): Promise<string> {
        await this.initialize();

        const sections: string[] = [];

        // Code/git/patterns context (if available)
        if (this._contextBuilder) {
            const coreContext = await this._contextBuilder.build(task, options);
            if (coreContext) sections.push(coreContext);
        }

        // Document context (if enabled)
        if (this._config.features.documents) {
            const docResults = await this.searchDocs(task, { k: options.codeResults ?? 4 });
            if (docResults.length > 0) {
                const docSection = docResults.map(r => {
                    const header = r.context ? `**[${r.metadata.collection}]** ${r.metadata.title} — _${r.context}_` : `**[${r.metadata.collection}]** ${r.metadata.title}`;
                    return `${header}\n\n${r.content}`;
                }).join('\n\n---\n\n');
                sections.push(`## Relevant Documents\n\n${docSection}`);
            }
        }

        // Conversation context (if enabled)
        if (this._config.features.conversations) {
            const memories = await this.recall(task, { k: 3 });
            if (memories.length > 0) {
                const convSection = memories.map(m =>
                    `**${m.title}** (${new Date(m.created_at * 1000).toLocaleDateString()})\n${m.summary}`
                ).join('\n\n');
                sections.push(`## Relevant Conversations\n\n${convSection}`);
            }
        }

        return sections.join('\n\n');
    }

    // ── Search ──────────────────────────────────────

    /** Semantic search across all enabled indices. */
    async search(query: string, options?: {
        codeK?: number; gitK?: number; memoryK?: number;
        minScore?: number; useMMR?: boolean;
    }): Promise<SearchResult[]> {
        await this.initialize();
        if (!this._search) {
            // No code/git/patterns search — fall back to doc search if enabled
            if (this._config.features.documents) {
                return this.searchDocs(query, { k: 8 });
            }
            return [];
        }
        return this._search.search(query, options);
    }

    /** Semantic search over code only. */
    async searchCode(query: string, k: number = 8): Promise<SearchResult[]> {
        this._require('code', 'searchCode');
        await this.initialize();
        return this._search!.search(query, { codeK: k, gitK: 0, memoryK: 0 });
    }

    /** Semantic search over commits only. */
    async searchCommits(query: string, k: number = 8): Promise<SearchResult[]> {
        this._require('git', 'searchCommits');
        await this.initialize();
        return this._search!.search(query, { codeK: 0, gitK: k, memoryK: 0 });
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

        const resultLists: SearchResult[][] = [];

        // Code/git/patterns search
        if (this._search) {
            const [vectorResults, bm25Results] = await Promise.all([
                this._search.search(query, options),
                Promise.resolve(this._bm25!.search(query, options)),
            ]);
            resultLists.push(vectorResults, bm25Results);
        }

        // Documents search
        if (this._config.features.documents) {
            const docResults = await this.searchDocs(query, { k: 8 });
            if (docResults.length > 0) resultLists.push(docResults);
        }

        if (resultLists.length === 0) return [];
        return reciprocalRankFusion(resultLists);
    }

    /** BM25 keyword search only (no embeddings needed). */
    searchBM25(query: string, options?: {
        codeK?: number; gitK?: number; memoryK?: number;
    }): SearchResult[] {
        if (!this._bm25) return [];
        return this._bm25.search(query, options);
    }

    /** Rebuild FTS5 indices (after bulk import or if out of sync). */
    rebuildFTS(): void {
        this._bm25?.rebuild();
    }

    // ── Memory / Learning ───────────────────────────

    /** Store a learned pattern from a completed task. */
    async learn(pattern: MemoryPattern): Promise<number> {
        this._require('patterns', 'learn');
        await this.initialize();
        const id = await this._patternStore!.learn(pattern);

        // Auto-consolidate every 50 patterns
        if (this._patternStore!.count % 50 === 0) {
            this._consolidator!.consolidate();
        }

        this.emit('learned', { id, pattern });
        return id;
    }

    /** Search for similar learned patterns. */
    async searchPatterns(query: string, k: number = 4): Promise<(MemoryPattern & { score: number })[]> {
        this._require('patterns', 'searchPatterns');
        await this.initialize();
        return this._patternStore!.search(query, k);
    }

    /** Consolidate memory: prune old failures + deduplicate. */
    consolidate(): { pruned: number; deduped: number } {
        this._require('patterns', 'consolidate');
        return this._consolidator!.consolidate();
    }

    /** Distill top patterns into a strategy for a task type. */
    distill(taskType: string): DistilledStrategy | null {
        this._require('patterns', 'distill');
        return this._distiller!.distill(taskType);
    }

    // ── Conversation Memory ─────────────────────────

    /** Store a conversation digest for long-term memory. */
    async remember(digest: ConversationDigest): Promise<number> {
        this._require('conversations', 'remember');
        await this.initialize();
        const id = await this._conversations!.remember(digest);
        this.emit('remembered', { id, digest });
        return id;
    }

    /** Recall relevant conversation memories (hybrid search by default). */
    async recall(query: string, options?: RecallOptions): Promise<StoredMemory[]> {
        this._require('conversations', 'recall');
        await this.initialize();
        return this._conversations!.recall(query, options);
    }

    /** List recent conversation memories. */
    listMemories(limit?: number, tier?: 'short' | 'long'): StoredMemory[] {
        this._require('conversations', 'listMemories');
        return this._conversations!.list(limit, tier);
    }

    /** Consolidate old conversation memories (short → long tier). */
    consolidateMemories(keepRecent?: number): { promoted: number } {
        this._require('conversations', 'consolidateMemories');
        return this._conversations!.consolidate(keepRecent);
    }

    // ── Query ───────────────────────────────────────

    /** Get git history for a specific file. */
    async fileHistory(filePath: string, limit: number = 20): Promise<any[]> {
        this._require('git', 'fileHistory');
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
        this._require('git', 'coEdits');
        return this._coEdits!.suggest(filePath, limit);
    }

    // ── Stats ───────────────────────────────────────

    /** Get statistics for all enabled features. */
    stats(): IndexStats {
        const result: IndexStats = {};

        if (this._config.features.code) {
            result.code = {
                files: (this._db.prepare('SELECT COUNT(DISTINCT file_path) as c FROM code_chunks').get() as any).c,
                chunks: (this._db.prepare('SELECT COUNT(*) as c FROM code_chunks').get() as any).c,
                hnswSize: this._codeHnsw?.size ?? 0,
            };
        }

        if (this._config.features.git) {
            result.git = {
                commits: (this._db.prepare('SELECT COUNT(*) as c FROM git_commits').get() as any).c,
                filesTracked: (this._db.prepare('SELECT COUNT(DISTINCT file_path) as c FROM commit_files').get() as any).c,
                coEdits: (this._db.prepare('SELECT COUNT(*) as c FROM co_edits').get() as any).c,
                hnswSize: this._gitHnsw?.size ?? 0,
            };
        }

        if (this._config.features.patterns) {
            result.memory = {
                patterns: (this._db.prepare('SELECT COUNT(*) as c FROM memory_patterns').get() as any).c,
                avgSuccess: (this._db.prepare('SELECT AVG(success_rate) as a FROM memory_patterns').get() as any).a ?? 0,
                hnswSize: this._memHnsw?.size ?? 0,
            };
        }

        if (this._config.features.documents) {
            result.documents = {
                collections: (this._db.prepare('SELECT COUNT(*) as c FROM collections').get() as any).c,
                documents: (this._db.prepare('SELECT COUNT(DISTINCT file_path) as c FROM doc_chunks').get() as any).c,
                chunks: (this._db.prepare('SELECT COUNT(*) as c FROM doc_chunks').get() as any).c,
                hnswSize: this._docHnsw?.size ?? 0,
            };
        }

        if (this._config.features.conversations) {
            result.conversations = this._conversations!.count();
        }

        return result;
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

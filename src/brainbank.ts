/**
 * BrainBank — Main Orchestrator
 *
 * Thin facade that composes four services:
 *   IndexerRegistry  — registration + lookup
 *   Initializer      — two-phase startup (earlyInit / lateInit)
 *   SearchAPI        — all search + context logic
 *   IndexAPI         — code / git / docs indexing orchestration
 *
 * All heavy logic lives in those modules; BrainBank owns state,
 * guards (requireInit / initialize()), and public API shape.
 */

import { EventEmitter } from 'node:events';
import { resolveConfig } from './config/defaults.ts';
import { Database } from './db/database.ts';
import { HNSWIndex } from './providers/vector/hnsw-index.ts';
import { Collection } from './core/collection.ts';
import { IndexerRegistry } from './core/registry.ts';
import { earlyInit, lateInit } from './core/initializer.ts';
import { SearchAPI } from './core/search-api.ts';
import { IndexAPI } from './core/index-api.ts';
import { reembedAll } from './services/reembed.ts';
import { createWatcher, type WatchOptions, type Watcher } from './services/watch.ts';
import type { ReembedResult, ReembedOptions } from './services/reembed.ts';
import type { Indexer } from './indexers/base.ts';
import type {
    BrainBankConfig, ResolvedConfig, EmbeddingProvider,
    IndexResult, IndexStats, SearchResult,
    ContextOptions, CoEditSuggestion, ProgressCallback, StageProgressCallback,
    DocumentCollection,
} from './types.ts';

export class BrainBank extends EventEmitter {
    // ── State ───────────────────────────────────────
    private _config: ResolvedConfig;
    private _db!: Database;
    private _embedding!: EmbeddingProvider;
    private _registry   = new IndexerRegistry();
    private _searchAPI?: SearchAPI;
    private _indexAPI?:  IndexAPI;
    private _initialized  = false;
    private _initPromise: Promise<void> | null = null;
    private _watcher?: Watcher;

    // Collections (KV store)
    private _collections = new Map<string, Collection>();
    private _kvHnsw?: HNSWIndex;
    private _kvVecs   = new Map<number, Float32Array>();

    // Shared HNSW pool — code:frontend + code:backend share one index
    private _sharedHnsw = new Map<string, { hnsw: HNSWIndex; vecCache: Map<number, Float32Array> }>();

    constructor(config: BrainBankConfig = {}) {
        super();
        this._config = resolveConfig(config);
    }

    // ── Indexer registration ─────────────────────────

    /**
     * Register an indexer. Chainable.
     *
     *   brain.use(code({ repoPath: '.' })).use(docs());
     */
    use(indexer: Indexer): this {
        if (this._initialized)
            throw new Error(`BrainBank: Cannot add indexer '${indexer.name}' after initialization. Call .use() before any operations.`);
        this._registry.register(indexer);
        return this;
    }

    /** Get the list of registered indexer names. */
    get indexers(): string[]                   { return this._registry.names; }

    /** Check if an indexer is loaded. Also matches type prefix (e.g. 'code' matches 'code:frontend'). */
    has(name: string): boolean                 { return this._registry.has(name); }

    /** Get an indexer instance. Throws if not loaded. */
    indexer<T extends Indexer = Indexer>(n: string): T { return this._registry.get<T>(n); }

    // ── Initialization ───────────────────────────────

    /**
     * Initialize database, HNSW indices, and load existing vectors.
     * Only initializes registered modules.
     * Automatically called by index/search methods if not yet initialized.
     */
    async initialize(): Promise<void> {
        if (this._initialized) return;
        if (this._initPromise) return this._initPromise;

        this._initPromise = this._runInitialize()
            .catch(err => {
                // Reset shared state so a retry starts clean
                for (const { hnsw } of this._sharedHnsw.values()) try { hnsw.reinit(); } catch {}
                this._kvVecs.clear();
                if (this._kvHnsw) try { this._kvHnsw.reinit(); } catch {}
                try { this._db?.close(); } catch {}
                this._db        = undefined as any;
                this._kvHnsw    = undefined as any;
                this._searchAPI = undefined;
                this._indexAPI  = undefined;
                throw err;
            })
            .finally(() => { this._initPromise = null; });

        return this._initPromise;
    }

    private async _runInitialize(): Promise<void> {
        if (this._initialized) return;

        // Phase 1: set this._kvHnsw BEFORE phase 2 so collection() works
        // when indexers call ctx.collection() during their initialize()
        const early = await earlyInit(this._config, (e, d) => this.emit(e, d));
        this._db        = early.db;
        this._embedding = early.embedding;
        this._kvHnsw    = early.kvHnsw;

        // Phase 2: load vectors, run indexers, build search services
        const late = await lateInit(
            early,
            this._config,
            this._registry,
            this._sharedHnsw,
            this._kvVecs,
            (name) => this.collection(name),
        );

        this._searchAPI = new SearchAPI({
            ...late,
            registry:   this._registry,
            config:     this._config,
            searchDocs: (q, o) => this.searchDocs(q, o),
            collection: (n)    => this.collection(n),
        });

        this._indexAPI = new IndexAPI({
            registry: this._registry,
            gitDepth: this._config.gitDepth,
            emit:     (e, d) => this.emit(e, d),
        });

        this._initialized = true;
        this.emit('initialized', { indexers: this.indexers });
    }

    // ── Collections (KV) ────────────────────────────

    /**
     * Get or create a dynamic collection.
     * Collections are the universal data primitive — store anything, search semantically.
     *
     *   const errors = brain.collection('debug_errors');
     *   await errors.add('Fixed null check', { file: 'api.ts' });
     *   const hits = await errors.search('null pointer');
     */
    collection(name: string): Collection {
        if (this._collections.has(name)) return this._collections.get(name)!;
        if (!this._kvHnsw)
            throw new Error('BrainBank: Collections not ready. Call await brain.initialize() first.');
        const coll = new Collection(name, this._db, this._embedding, this._kvHnsw, this._kvVecs, this._config.reranker);
        this._collections.set(name, coll);
        return coll;
    }

    /** List all collection names that have data. */
    listCollectionNames(): string[] {
        this._requireInit('listCollectionNames');
        return (this._db.prepare('SELECT DISTINCT collection FROM kv_data ORDER BY collection').all() as any[])
            .map(r => r.collection);
    }

    // ── Indexing (delegated to IndexAPI) ─────────────

    async index(options: {
        modules?: ('code' | 'git' | 'docs')[];
        gitDepth?: number; forceReindex?: boolean; onProgress?: StageProgressCallback;
    } = {}): Promise<{ code?: IndexResult; git?: IndexResult; docs?: Record<string, { indexed: number; skipped: number; chunks: number }> }> {
        await this.initialize();
        return this._indexAPI!.index(options);
    }

    /** Index only code files (all repos in multi-repo mode). */
    async indexCode(options: { forceReindex?: boolean; onProgress?: ProgressCallback } = {}): Promise<IndexResult> {
        await this.initialize();
        return this._indexAPI!.indexCode(options);
    }

    /** Index only git history (all repos in multi-repo mode). */
    async indexGit(options: { depth?: number; onProgress?: ProgressCallback } = {}): Promise<IndexResult> {
        await this.initialize();
        return this._indexAPI!.indexGit(options);
    }

    // ── Document collections ─────────────────────────

    /** Register a document collection. */
    async addCollection(collection: DocumentCollection): Promise<void> {
        await this.initialize();
        this.indexer('docs').addCollection!(collection);
    }

    /** Remove a collection and all its indexed data. */
    async removeCollection(name: string): Promise<void> {
        await this.initialize();
        this.indexer('docs').removeCollection!(name);
    }

    /** List all registered collections. */
    listCollections(): DocumentCollection[] {
        this._requireInit('listCollections');
        return this.indexer('docs').listCollections!();
    }

    /** Index all (or specific) document collections. */
    async indexDocs(options: {
        collections?: string[];
        onProgress?: (collection: string, file: string, current: number, total: number) => void;
    } = {}): Promise<Record<string, { indexed: number; skipped: number; chunks: number }>> {
        await this.initialize();
        const results = await this.indexer('docs').indexCollections!(options);
        this.emit('docsIndexed', results);
        return results;
    }

    /** Search documents only. */
    async searchDocs(query: string, options?: { collection?: string; k?: number; minScore?: number }): Promise<SearchResult[]> {
        await this.initialize();
        return this.indexer('docs').search!(query, options);
    }

    // ── Context metadata ─────────────────────────────

    /** Add context description for a collection path. */
    addContext(collection: string, path: string, context: string): void {
        this.indexer('docs').addContext!(collection, path, context);
    }

    /** Remove context for a collection path. */
    removeContext(collection: string, path: string): void {
        this.indexer('docs').removeContext!(collection, path);
    }

    /** List all context entries. */
    listContexts(): { collection: string; path: string; context: string }[] {
        return this.indexer('docs').listContexts!();
    }

    // ── Search (delegated to SearchAPI) ─────────────

    /**
     * Get formatted context for a task.
     * Returns markdown ready for system prompt injection.
     */
    async getContext(task: string, options: ContextOptions = {}): Promise<string> {
        await this.initialize();
        return this._searchAPI!.getContext(task, options);
    }

    /** Semantic search across all loaded modules. */
    async search(query: string, options?: {
        codeK?: number; gitK?: number; patternK?: number;
        minScore?: number; useMMR?: boolean;
    }): Promise<SearchResult[]> {
        await this.initialize();
        return this._searchAPI!.search(query, options);
    }

    /** Semantic search over code only. */
    async searchCode(query: string, k = 8): Promise<SearchResult[]> {
        await this.initialize();
        return this._searchAPI!.searchCode(query, k);
    }

    /** Semantic search over commits only. */
    async searchCommits(query: string, k = 8): Promise<SearchResult[]> {
        await this.initialize();
        return this._searchAPI!.searchCommits(query, k);
    }

    /**
     * Hybrid search: vector + BM25 fused with Reciprocal Rank Fusion.
     * Best quality — catches both exact keyword matches and conceptual similarities.
     */
    async hybridSearch(query: string, options?: {
        codeK?: number; gitK?: number; patternK?: number;
        minScore?: number; useMMR?: boolean;
        collections?: Record<string, number>;
    }): Promise<SearchResult[]> {
        await this.initialize();
        return this._searchAPI!.hybridSearch(query, options);
    }

    /** BM25 keyword search only (no embeddings needed). */
    async searchBM25(query: string, options?: { codeK?: number; gitK?: number; patternK?: number }): Promise<SearchResult[]> {
        this._requireInit('searchBM25');
        return this._searchAPI!.searchBM25(query, options);
    }

    /** Rebuild FTS5 indices. */
    rebuildFTS(): void {
        this._requireInit('rebuildFTS');
        this._searchAPI!.rebuildFTS();
    }

    // ── Queries ──────────────────────────────────────

    /** Get git history for a specific file. */
    async fileHistory(filePath: string, limit = 20): Promise<any[]> {
        await this.initialize();
        return (this.indexer('git') as any).fileHistory(filePath, limit);
    }

    /** Get co-edit suggestions for a file. */
    coEdits(filePath: string, limit = 5): CoEditSuggestion[] {
        this._requireInit('coEdits');
        return (this.indexer('git') as any).suggestCoEdits(filePath, limit);
    }

    // ── Stats ────────────────────────────────────────

    /** Get statistics for all loaded modules. */
    stats(): IndexStats {
        this._requireInit('stats');
        const result: IndexStats = {};

        if (this.has('code')) {
            const sh = this._sharedHnsw.get('code');
            result.code = {
                files:    (this._db.prepare('SELECT COUNT(DISTINCT file_path) as c FROM code_chunks').get() as any).c,
                chunks:   (this._db.prepare('SELECT COUNT(*) as c FROM code_chunks').get() as any).c,
                hnswSize: sh?.hnsw.size ?? 0,
            };
        }

        if (this.has('git')) {
            const sh = this._sharedHnsw.get('git');
            result.git = {
                commits:      (this._db.prepare('SELECT COUNT(*) as c FROM git_commits').get() as any).c,
                filesTracked: (this._db.prepare('SELECT COUNT(DISTINCT file_path) as c FROM commit_files').get() as any).c,
                coEdits:      (this._db.prepare('SELECT COUNT(*) as c FROM co_edits').get() as any).c,
                hnswSize:     sh?.hnsw.size ?? 0,
            };
        }

        if (this.has('docs')) {
            result.documents = (this.indexer('docs') as any).stats();
        }

        return result;
    }

    // ── Watch ────────────────────────────────────────

    /**
     * Start watching for file changes and auto-re-index.
     * Works with built-in and custom indexers.
     */
    watch(options: WatchOptions = {}): Watcher {
        this._requireInit('watch');
        this._watcher?.close();
        this._watcher = createWatcher(
            async () => { await this.index(); },
            this._registry.raw,
            this._config.repoPath,
            options,
        );
        return this._watcher;
    }

    // ── Re-embed ─────────────────────────────────────

    /**
     * Re-embed all existing text with the current embedding provider.
     * Use this when switching providers (e.g. Local → OpenAI).
     */
    async reembed(options: ReembedOptions = {}): Promise<ReembedResult> {
        this._requireInit('reembed');

        const hnswMap = new Map<string, { hnsw: HNSWIndex; vecs: Map<number, Float32Array> }>();

        if (this._kvHnsw) hnswMap.set('kv', { hnsw: this._kvHnsw, vecs: this._kvVecs });

        for (const [type, shared] of this._sharedHnsw) {
            hnswMap.set(type, { hnsw: shared.hnsw, vecs: shared.vecCache });
        }

        for (const type of ['memory', 'notes', 'docs'] as const) {
            const mod = this._registry.firstByType(type) as any;
            if (mod?.hnsw) hnswMap.set(type, { hnsw: mod.hnsw, vecs: mod.vecCache });
        }

        const result = await reembedAll(this._db, this._embedding, hnswMap, options);
        this.emit('reembedded', result);
        return result;
    }

    // ── Lifecycle ────────────────────────────────────

    /** Close database and release resources. */
    close(): void {
        this._watcher?.close();
        for (const indexer of this._registry.all) indexer.close?.();
        this._db?.close();
        this._initialized = false;
        this._collections.clear();
        this._sharedHnsw.clear();
        this._kvVecs.clear();
        this._kvHnsw    = undefined as any;
        this._searchAPI = undefined;
        this._indexAPI  = undefined;
        this._registry.clear();
    }

    /** Whether the brainbank has been initialized. */
    get isInitialized(): boolean            { return this._initialized; }

    /** The resolved configuration. */
    get config(): Readonly<ResolvedConfig>  { return this._config; }

    // ── Internal guard ───────────────────────────────

    private _requireInit(method: string): void {
        if (!this._initialized)
            throw new Error(`BrainBank: Not initialized. Call await brain.initialize() before ${method}().`);
    }
}

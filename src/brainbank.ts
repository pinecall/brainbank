/**
 * BrainBank — Main Orchestrator
 *
 * Thin facade that composes four services:
 *   PluginRegistry   — registration + lookup
 *   Initializer      — two-phase startup (earlyInit / lateInit)
 *   SearchAPI        — all search + context logic
 *   IndexAPI         — code / git / docs indexing orchestration
 *
 * All heavy logic lives in those modules; BrainBank owns state,
 * guards (requireInit / initialize()), and public API shape.
 */

import { EventEmitter } from 'node:events';
import { resolveConfig } from './config.ts';
import { Database } from './db/database.ts';
import { HNSWIndex } from './providers/vector/hnsw-index.ts';
import { KVService } from './services/kv-service.ts';
import type { Collection } from './services/collection.ts';
import { PluginRegistry } from './bootstrap/registry.ts';
import { Initializer } from './bootstrap/initializer.ts';
import { SearchAPI } from './engine/search-api.ts';
import { IndexAPI } from './engine/index-api.ts';
import { reembedAll } from './services/reembed.ts';
import { createWatcher, type WatchOptions, type Watcher } from './services/watch.ts';
import type { ReembedResult, ReembedOptions } from './services/reembed.ts';
import type { Plugin } from './plugin.ts';
import { isSearchable, isHnswPlugin } from './plugin.ts';
import { PLUGIN, HNSW } from './constants.ts';
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
    private _registry = new PluginRegistry();
    private _searchAPI?: SearchAPI;
    private _indexAPI?: IndexAPI;
    private _kvService?: KVService;
    private _initialized = false;
    private _initPromise: Promise<void> | null = null;
    private _watcher?: Watcher;

    // Shared HNSW pool — code:frontend + code:backend share one index
    private _sharedHnsw = new Map<string, { hnsw: HNSWIndex; vecCache: Map<number, Float32Array> }>();

    constructor(config: BrainBankConfig = {}) {
        super();
        this._config = resolveConfig(config);
    }

    // ── Plugin registration ──────────────────────────

    /**
     * Register a plugin. Chainable.
     *
     *   brain.use(code({ repoPath: '.' })).use(docs());
     */
    use(plugin: Plugin): this {
        if (this._initialized)
            throw new Error(`BrainBank: Cannot add plugin '${plugin.name}' after initialization. Call .use() before any operations.`);
        this._registry.register(plugin);
        return this;
    }

    /** Get the list of registered plugin names. */
    get plugins(): string[] { return this._registry.names; }

    /** Check if a plugin is loaded. Also matches type prefix (e.g. 'code' matches 'code:frontend'). */
    has(name: string): boolean { return this._registry.has(name); }

    /** Get a plugin instance by name. Returns undefined if not loaded. */
    plugin<T extends Plugin = Plugin>(n: string): T | undefined {
        return this._registry.has(n) ? this._registry.get<T>(n) : undefined;
    }

    // ── Typed Plugin Accessors ───────────────────────

    /** Typed access to the docs plugin. Returns undefined if not loaded. */
    get docs(): Plugin | undefined {
        return this._registry.firstByType(PLUGIN.DOCS);
    }

    /** Typed access to the git plugin. Returns undefined if not loaded. */
    get git(): Plugin | undefined {
        return this._registry.firstByType(PLUGIN.GIT);
    }

    // ── Initialization ───────────────────────────────

    /**
     * Initialize database, HNSW indices, and load existing vectors.
     * Only initializes registered modules.
     * Automatically called by index/search methods if not yet initialized.
     */
    async initialize(options: { force?: boolean } = {}): Promise<void> {
        if (this._initialized) return;
        if (this._initPromise) return this._initPromise;

        this._initPromise = this._runInitialize(options)
            .catch(err => {
                // Reset shared state so a retry starts clean
                for (const { hnsw } of this._sharedHnsw.values()) try { hnsw.reinit(); } catch { }
                this._kvService?.clear();
                if (this._kvService) try { this._kvService.hnsw.reinit(); } catch { }
                try { this._db?.close(); } catch { }
                this._db = undefined!;
                this._kvService = undefined;
                this._searchAPI = undefined;
                this._indexAPI = undefined;
                throw err;
            })
            .finally(() => { this._initPromise = null; });

        return this._initPromise;
    }

    private async _runInitialize(options: { force?: boolean } = {}): Promise<void> {
        if (this._initialized) return;

        const initializer = new Initializer(this._config, (e, d) => this.emit(e, d));

        // Phase 1: create KVService BEFORE phase 2 so collection() works
        // when plugins call ctx.collection() during their initialize()
        const early = await initializer.early(options);
        this._db = early.db;
        this._embedding = early.embedding;
        this._kvService = new KVService(early.db, early.embedding, early.kvHnsw, new Map(), this._config.reranker);

        // Phase 2: load vectors, run plugins, build search services
        const late = await initializer.late(
            early,
            this._registry,
            this._sharedHnsw,
            this._kvService.vecs,
            (name) => this.collection(name),
        );

        this._searchAPI = new SearchAPI({
            ...late,
            registry: this._registry,
            config: this._config,
            getDocsPlugin: () => {
                const d = this._registry.get(PLUGIN.DOCS);
                return d && isSearchable(d) ? d : undefined;
            },
            collection: (n) => this.collection(n),
        });

        this._indexAPI = new IndexAPI({
            registry: this._registry,
            gitDepth: this._config.gitDepth,
            emit: (e, d) => this.emit(e, d),
        });


        this._initialized = true;
        this.emit('initialized', { plugins: this.plugins });
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
        if (!this._kvService)
            throw new Error('BrainBank: Collections not ready. Call await brain.initialize() first.');
        return this._kvService.collection(name);
    }

    /** List all collection names that have data. */
    listCollectionNames(): string[] {
        this._requireInit('listCollectionNames');
        return this._kvService!.listNames();
    }

    /** Delete a collection's data and evict from cache. */
    deleteCollection(name: string): void {
        this._requireInit('deleteCollection');
        this._kvService!.delete(name);
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

    /** Semantic search over code only. Convenience for search({ codeK, gitK: 0 }). */
    async searchCode(query: string, k = 8): Promise<SearchResult[]> {
        await this.initialize();
        return this._searchAPI!.searchCode(query, k);
    }

    /** Semantic search over commits only. Convenience for search({ gitK, codeK: 0 }). */
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





    // ── Stats ────────────────────────────────────────

    /** Get statistics for all loaded modules. */
    stats(): IndexStats {
        this._requireInit('stats');
        const result: IndexStats = {};

        if (this.has(PLUGIN.CODE)) {
            result.code = this._registry.firstByType(PLUGIN.CODE)!.stats!() as IndexStats['code'];
        }
        if (this.has(PLUGIN.GIT)) {
            result.git = this._registry.firstByType(PLUGIN.GIT)!.stats!() as IndexStats['git'];
        }
        if (this.has(PLUGIN.DOCS)) {
            result.documents = this._registry.firstByType(PLUGIN.DOCS)!.stats!() as IndexStats['documents'];
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

        if (this._kvService) hnswMap.set(HNSW.KV, { hnsw: this._kvService.hnsw, vecs: this._kvService.vecs });

        for (const [type, shared] of this._sharedHnsw) {
            hnswMap.set(type, { hnsw: shared.hnsw, vecs: shared.vecCache });
        }

        for (const type of [PLUGIN.MEMORY, PLUGIN.DOCS] as const) {
            const mod = this._registry.firstByType(type);
            if (mod && isHnswPlugin(mod)) hnswMap.set(type, { hnsw: mod.hnsw, vecs: mod.vecCache });
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
        this._embedding?.close().catch(() => { });
        this._db?.close();
        this._initialized = false;
        this._kvService?.clear();
        this._sharedHnsw.clear();
        this._kvService = undefined;
        this._searchAPI = undefined;
        this._indexAPI = undefined;
        this._registry.clear();
    }

    /** Whether the brainbank has been initialized. */
    get isInitialized(): boolean { return this._initialized; }

    /** The resolved configuration. */
    get config(): Readonly<ResolvedConfig> { return this._config; }

    // ── Internal guard ───────────────────────────────

    private _requireInit(method: string): void {
        if (!this._initialized)
            throw new Error(`BrainBank: Not initialized. Call await brain.initialize() before ${method}().`);
    }
}

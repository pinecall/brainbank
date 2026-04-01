/**
 * BrainBank — Main Orchestrator
 *
 * Thin facade that composes services:
 *   - **PluginRegistry** — registration + lookup
 *   - **SearchAPI** — all search + context logic
 *   - **runIndex** — code / git / docs indexing orchestration
 *
 * Initialization is inline — no indirection layers.
 * All heavy logic lives in those modules; BrainBank owns state,
 * guards (`_requireInit` / `initialize`), and public API shape.
 */

import type { ReembedResult, ReembedOptions } from './engine/reembed.ts';
import type { IndexDeps } from './engine/index-api.ts';
import type { Plugin, PluginContext } from './plugin.ts';
import type { SearchOptions } from './search/types.ts';
import type { WatchOptions } from './services/watch.ts';
import type {
    BrainBankConfig, ResolvedConfig, EmbeddingProvider,
    SearchResult, ICollection,
    ContextOptions, StageProgressCallback,
} from './types.ts';

import { EventEmitter } from 'node:events';
import { resolveConfig } from './config.ts';
import { HNSW } from './constants.ts';
import { Database } from './db/database.ts';
import { setEmbeddingMeta, getEmbeddingMeta, detectProviderMismatch } from './db/embedding-meta.ts';
import { runIndex } from './engine/index-api.ts';
import { reembedAll } from './engine/reembed.ts';
import { SearchAPI, createSearchAPI } from './engine/search-api.ts';

import { resolveEmbedding } from './providers/embeddings/resolve.ts';
import { HNSWIndex } from './providers/vector/hnsw-index.ts';
import { hnswPath, countRows, saveAllHnsw, loadVectors, loadVecCache } from './providers/vector/hnsw-loader.ts';
import { KVService } from './services/kv-service.ts';
import { PluginRegistry } from './services/plugin-registry.ts';
import { Watcher } from './services/watch.ts';


export class BrainBank extends EventEmitter {
    private _config: ResolvedConfig;
    private _db!: Database;
    private _embedding!: EmbeddingProvider;
    private _registry = new PluginRegistry();
    private _searchAPI?: SearchAPI;
    private _indexDeps?: IndexDeps;
    private _kvService?: KVService;
    private _initialized = false;
    private _initPromise: Promise<void> | null = null;
    private _watcher?: Watcher;
    private _sharedHnsw = new Map<string, { hnsw: HNSWIndex; vecCache: Map<number, Float32Array> }>();

    constructor(config: BrainBankConfig = {}) {
        super();
        this._config = resolveConfig(config);
    }

    /** Whether the brainbank has been initialized. */
    get isInitialized(): boolean {
        return this._initialized;
    }

    /** The resolved configuration. */
    get config(): Readonly<ResolvedConfig> {
        return this._config;
    }

    /** All registered plugin names (insertion order). */
    get plugins(): string[] {
        return this._registry.names;
    }

    /**
     * Register a plugin. Chainable.
     *
     * @example
     * brain.use(code({ repoPath: '.' })).use(docs());
     *
     * @throws If called after `initialize()`.
     */
    use(plugin: Plugin): this {
        if (this._initialized) {
            throw new Error(
                `BrainBank: Cannot add plugin '${plugin.name}' after initialization. ` +
                `Call .use() before any operations.`,
            );
        }
        this._registry.register(plugin);
        return this;
    }

    /**
     * Check if a plugin is loaded.
     * Also matches type prefix (e.g. `'code'` matches `'code:frontend'`).
     */
    has(name: string): boolean {
        return this._registry.has(name);
    }

    /** Get a plugin instance by name. Returns `undefined` if not loaded. */
    plugin<T extends Plugin = Plugin>(name: string): T | undefined {
        return this._registry.has(name) ? this._registry.get<T>(name) : undefined;
    }

    /**
     * Initialize database, HNSW indices, and load existing vectors.
     * Automatically called by `index` / `search` methods if not yet initialized.
     * Concurrent calls are deduped via `_initPromise`.
     *
     * @param options.force - If `true`, skip vector load on dimension mismatch.
     */
    async initialize(options: { force?: boolean } = {}): Promise<void> {
        if (this._initialized) return;
        if (this._initPromise) return this._initPromise;

        this._initPromise = this._runInitialize(options)
            .then(() => { this._initPromise = null; })
            .catch(err => {
                this._cleanupAfterFailedInit();
                throw err;
            });

        return this._initPromise;
    }

    /** Close database and release all resources. Synchronous. */
    close(): void {
        this._watcher?.close();
        for (const plugin of this._registry.all) plugin.close?.();

        const reranker = this._config.reranker as { close?: () => void } | undefined;
        reranker?.close?.();

        this._embedding?.close().catch(() => { });
        this._db?.close();
        this._initialized = false;
        this._kvService?.clear();
        this._sharedHnsw.clear();
        this._kvService = undefined;
        this._searchAPI = undefined;
        this._indexDeps = undefined;
        this._registry.clear();
    }

    /**
     * Get or create a dynamic collection (universal KV primitive).
     *
     * @example
     * const errors = brain.collection('debug_errors');
     * await errors.add('Fixed null check', { file: 'api.ts' });
     * const hits = await errors.search('null pointer');
     *
     * @throws If not initialized.
     */
    collection(name: string): ICollection {
        if (!this._kvService) {
            throw new Error('BrainBank: Collections not ready. Call await brain.initialize() first.');
        }
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

    /** Run indexing across selected modules. Auto-initializes. */
    async index(options: {
        modules?: string[];
        forceReindex?: boolean;
        onProgress?: StageProgressCallback;
        pluginOptions?: Record<string, unknown>;
    } = {}): Promise<Record<string, unknown>> {
        await this.initialize();
        return runIndex(this._indexDeps!, options);
    }

    /**
     * Semantic search across all loaded modules.
     * Scope via `sources: { code: 10, git: 0 }`.
     */
    async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
        await this.initialize();
        return this._searchAPI?.search(query, options) ?? [];
    }

    /**
     * Hybrid search: vector + BM25 fused with Reciprocal Rank Fusion.
     * Scope via `sources: { code: 10, git: 5, docs: 3, myNotes: 5 }`.
     */
    async hybridSearch(query: string, options?: SearchOptions): Promise<SearchResult[]> {
        await this.initialize();
        return this._searchAPI?.hybridSearch(query, options) ?? [];
    }

    /** BM25 keyword search only (no embeddings needed). */
    async searchBM25(query: string, options?: SearchOptions): Promise<SearchResult[]> {
        await this.initialize();
        return this._searchAPI?.searchBM25(query, options) ?? [];
    }

    /** Build formatted context block for LLM system prompt injection. Auto-initializes. */
    async getContext(task: string, options: ContextOptions = {}): Promise<string> {
        await this.initialize();
        return this._searchAPI?.getContext(task, options) ?? '';
    }

    /** Rebuild FTS5 indices. */
    rebuildFTS(): void {
        this._requireInit('rebuildFTS');
        this._searchAPI?.rebuildFTS();
    }

    /** Get statistics for all loaded plugins. */
    stats(): Record<string, Record<string, number | string> | undefined> {
        this._requireInit('stats');
        const result: Record<string, Record<string, number | string> | undefined> = {};

        for (const mod of this._registry.all) {
            if (mod.stats) {
                const baseType = mod.name.split(':')[0];
                result[baseType] = mod.stats();
            }
        }

        return result;
    }

    /** Start watching for file changes and auto-re-index. */
    watch(options: WatchOptions = {}): Watcher {
        this._requireInit('watch');
        this._watcher?.close();
        this._watcher = new Watcher(
            async () => { await this.index(); },
            this._registry.raw,
            this._config.repoPath,
            options,
        );
        return this._watcher;
    }

    /**
     * Re-embed all existing text with the current embedding provider.
     * Use after switching providers (e.g. Local → OpenAI).
     */
    async reembed(options: ReembedOptions = {}): Promise<ReembedResult> {
        await this.initialize();

        const hnswMap = new Map<string, { hnsw: HNSWIndex; vecs: Map<number, Float32Array> }>();

        if (this._kvService) {
            hnswMap.set(HNSW.KV, { hnsw: this._kvService.hnsw, vecs: this._kvService.vecs });
        }
        for (const [type, shared] of this._sharedHnsw) {
            hnswMap.set(type, { hnsw: shared.hnsw, vecs: shared.vecCache });
        }


        const result = await reembedAll(this._db, this._embedding, hnswMap, this._registry.all, options, {
            dbPath: this._config.dbPath,
            kvHnsw: this._kvService!.hnsw,
            sharedHnsw: this._sharedHnsw,
        });

        this.emit('reembedded', result);
        return result;
    }

    /**
     * Linear 8-step initialization:
     * 1. Open database
     * 2. Resolve embedding provider
     * 3. Check dimension mismatch
     * 4. Create KV HNSW + KVService
     * 5. Load KV vectors
     * 6. Initialize plugins
     * 7. Persist HNSW indices
     * 8. Build SearchAPI + index deps
     */
    private async _runInitialize(options: { force?: boolean } = {}): Promise<void> {
        if (this._initialized) return;

        this._db = new Database(this._config.dbPath);
        this._embedding = await this._resolveEmbedding();

        const mismatch = detectProviderMismatch(this._db, this._embedding);
        if (mismatch?.mismatch && !options.force) {
            this._db.close();
            throw new Error(
                `BrainBank: Embedding dimension mismatch (stored: ${mismatch.stored}, current: ${mismatch.current}). ` +
                `Run brain.reembed() to re-index with the new provider, or switch back to the original provider.`,
            );
        }
        setEmbeddingMeta(this._db, this._embedding);

        const skipVectorLoad = !!(options.force && mismatch?.mismatch);
        const dims = this._embedding.dims ?? this._config.embeddingDims;

        const kvHnsw = new HNSWIndex(
            dims,
            this._config.maxElements ?? 500_000,
            this._config.hnswM,
            this._config.hnswEfConstruction,
            this._config.hnswEfSearch,
        );
        await kvHnsw.init();

        this._kvService = new KVService(this._db, this._embedding, kvHnsw, new Map(), this._config.reranker);

        if (!skipVectorLoad) {
            const kvIndexPath = hnswPath(this._config.dbPath, 'kv');
            const kvCount = countRows(this._db, 'kv_vectors');
            if (kvHnsw.tryLoad(kvIndexPath, kvCount)) {
                loadVecCache(this._db, 'kv_vectors', 'data_id', this._kvService.vecs);
            } else {
                loadVectors(this._db, 'kv_vectors', 'data_id', kvHnsw, this._kvService.vecs);
            }
        }

        const privateHnsw = new Map<string, HNSWIndex>();
        const ctx = this._buildPluginContext(skipVectorLoad, privateHnsw);
        for (const mod of this._registry.all) {
            await mod.initialize(ctx);
        }

        saveAllHnsw(this._config.dbPath, kvHnsw, this._sharedHnsw, privateHnsw);

        this._searchAPI = createSearchAPI(
            this._db, this._embedding, this._config,
            this._registry, this._kvService, this._sharedHnsw,
        );
        this._indexDeps = {
            registry: this._registry,
            emit: (e, d) => this.emit(e, d),
        };

        this._initialized = true;
        this.emit('initialized', { plugins: this.plugins });
    }

    /** Reset shared state after a failed `_runInitialize`. */
    private _cleanupAfterFailedInit(): void {
        for (const { hnsw } of this._sharedHnsw.values()) {
            try { hnsw.reinit(); } catch (e) {
                this.emit('warn', `HNSW reinit failed during cleanup: ${e}`);
            }
        }
        this._kvService?.clear();
        if (this._kvService) {
            try { this._kvService.hnsw.reinit(); } catch (e) {
                this.emit('warn', `KV HNSW reinit failed during cleanup: ${e}`);
            }
        }
        try { this._db?.close(); } catch { /* DB already closed — safe to ignore */ }

        this._db = undefined!;
        this._kvService = undefined;
        this._searchAPI = undefined;
        this._indexDeps = undefined;
        this._initPromise = null;
    }

    /** Resolve embedding: explicit config > stored DB key > local default. */
    private async _resolveEmbedding(): Promise<EmbeddingProvider> {
        if (this._config.embeddingProvider) return this._config.embeddingProvider;

        const meta = getEmbeddingMeta(this._db);
        if (meta?.providerKey && meta.providerKey !== 'local') {
            this.emit('progress', `Embedding: auto-resolved '${meta.providerKey}' from DB`);
            return resolveEmbedding(meta.providerKey);
        }
        return resolveEmbedding('local');
    }

    /** Build the `PluginContext` passed to each plugin's `initialize()`. */
    private _buildPluginContext(
        skipVectorLoad: boolean,
        privateHnsw: Map<string, HNSWIndex>,
    ): PluginContext {
        let autoId = 0;

        return {
            db: this._db,
            embedding: this._embedding,
            config: this._config,

            createHnsw: async (maxElements?: number, dims?: number, name?: string) => {
                const hnsw = await new HNSWIndex(
                    dims ?? this._config.embeddingDims,
                    maxElements ?? this._config.maxElements,
                    this._config.hnswM,
                    this._config.hnswEfConstruction,
                    this._config.hnswEfSearch,
                ).init();
                privateHnsw.set(name ?? `private-${autoId++}`, hnsw);
                return hnsw;
            },

            loadVectors: (table, idCol, hnsw, cache) => {
                if (skipVectorLoad) return;
                const indexName = table.replace('_vectors', '').replace('_chunks', '');
                const indexPath = hnswPath(this._config.dbPath, indexName);
                const rowCount = countRows(this._db, table);
                if (hnsw.tryLoad(indexPath, rowCount)) {
                    loadVecCache(this._db, table, idCol, cache);
                } else {
                    loadVectors(this._db, table, idCol, hnsw, cache);
                }
            },

            getOrCreateSharedHnsw: async (type, maxElements, dims) => {
                const existing = this._sharedHnsw.get(type);
                if (existing) return { ...existing, isNew: false };

                const hnsw = await new HNSWIndex(
                    dims ?? this._config.embeddingDims,
                    maxElements ?? this._config.maxElements,
                    this._config.hnswM,
                    this._config.hnswEfConstruction,
                    this._config.hnswEfSearch,
                ).init();

                const vecCache = new Map<number, Float32Array>();
                this._sharedHnsw.set(type, { hnsw, vecCache });
                return { hnsw, vecCache, isNew: true };
            },

            collection: (name) => this._kvService!.collection(name),
        };
    }

    /** Guard: throw descriptive error if not initialized. */
    private _requireInit(method: string): void {
        if (!this._initialized) {
            throw new Error(`BrainBank: Not initialized. Call await brain.initialize() before ${method}().`);
        }
    }
}

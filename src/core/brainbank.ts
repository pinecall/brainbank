/**
 * BrainBank — Main Orchestrator
 * 
 * Composable semantic knowledge bank for AI agents.
 * Enable only the modules you need via .use():
 * 
 *   import { BrainBank } from 'brainbank';
 *   import { code } from 'brainbank/code';
 *   import { docs } from 'brainbank/docs';
 *   import { notes } from 'brainbank/notes';
 *   import { memory } from 'brainbank/memory';
 *   
 *   const brain = new BrainBank()
 *     .use(code({ repoPath: '.' }))
 *     .use(docs())
 *     .use(notes())
 *     .use(memory());
 */

import { EventEmitter } from 'node:events';
import { resolveConfig } from './config.ts';
import { Database } from '../storage/database.ts';
import { HNSWIndex } from '../vector/hnsw.ts';
import { LocalEmbedding } from '../embeddings/local.ts';
import { UnifiedSearch } from '../query/search.ts';
import { BM25Search } from '../query/bm25.ts';
import { reciprocalRankFusion } from '../query/rrf.ts';
import { ContextBuilder } from '../query/context-builder.ts';
import { Collection } from './collection.ts';
import { reembedAll, setEmbeddingMeta, detectProviderMismatch } from './reembed.ts';
import { createWatcher, type WatchOptions, type Watcher } from './watch.ts';
import type { ReembedResult, ReembedOptions } from './reembed.ts';
import type { Indexer, IndexerContext } from '../plugins/types.ts';
import type {
    BrainBankConfig, ResolvedConfig, EmbeddingProvider,
    IndexResult, IndexStats, SearchResult,
    ContextOptions, CoEditSuggestion, ProgressCallback,
    DocumentCollection,
} from '../types.ts';

export class BrainBank extends EventEmitter {
    private _config: ResolvedConfig;
    private _db!: Database;
    private _embedding!: EmbeddingProvider;
    private _modules = new Map<string, Indexer>();

    // Cross-module search (created if code/git/memory are present)
    private _search?: UnifiedSearch;
    private _bm25?: BM25Search;
    private _contextBuilder?: ContextBuilder;

    private _initialized = false;
    private _watcher?: Watcher;

    // Collections
    private _collections = new Map<string, Collection>();
    private _kvHnsw?: HNSWIndex;
    private _kvVecs = new Map<number, Float32Array>();

    constructor(config: BrainBankConfig = {}) {
        super();
        this._config = resolveConfig(config);
    }

    // ── Indexer Registration ────────────────────────

    /**
     * Register an indexer. Chainable.
     * 
     *   brain.use(code({ repoPath: '.' })).use(docs());
     */
    use(indexer: Indexer): this {
        if (this._initialized) {
            throw new Error(
                `BrainBank: Cannot add indexer '${indexer.name}' after initialization. ` +
                `Call .use() before any operations.`
            );
        }
        this._modules.set(indexer.name, indexer);
        return this;
    }

    /** Get the list of registered indexer names. */
    get indexers(): string[] {
        return [...this._modules.keys()];
    }

    /** @deprecated Use .indexers instead. */
    get modules(): string[] {
        return this.indexers;
    }

    /** Check if an indexer is loaded. */
    has(name: string): boolean {
        return this._modules.has(name);
    }

    /** Get an indexer instance. Throws if not loaded. */
    indexer<T extends Indexer = Indexer>(name: string): T {
        const mod = this._modules.get(name);
        if (!mod) {
            throw new Error(
                `BrainBank: Indexer '${name}' is not loaded. ` +
                `Add .use(${name}()) to your BrainBank instance.`
            );
        }
        return mod as T;
    }

    /** @deprecated Use .indexer() instead. */
    module(name: string): Indexer {
        return this.indexer(name);
    }

    // ── Initialization ──────────────────────────────

    /**
     * Initialize database, HNSW indices, and load existing vectors.
     * Only initializes registered modules.
     * Automatically called by index/search methods if not yet initialized.
     */
    async initialize(): Promise<void> {
        if (this._initialized) return;

        const config = this._config;

        // Database (always needed)
        this._db = new Database(config.dbPath);

        // Embedding provider (needed for modules and collections)
        this._embedding = config.embeddingProvider ?? new LocalEmbedding();

        // Initialize HNSW for dynamic collections (must come before indexer init)
        this._kvHnsw = new HNSWIndex(
            config.embeddingDims,
            config.maxElements ?? 500_000,
            config.hnswM,
            config.hnswEfConstruction,
            config.hnswEfSearch,
        );
        await this._kvHnsw.init();
        this._loadVectors('kv_vectors', 'data_id', this._kvHnsw, this._kvVecs);

        // Create the shared context for indexers
        const ctx: IndexerContext = {
            db: this._db,
            embedding: this._embedding,
            config: config,
            createHnsw: async (maxElements?: number) => {
                return new HNSWIndex(
                    config.embeddingDims,
                    maxElements ?? config.maxElements,
                    config.hnswM,
                    config.hnswEfConstruction,
                    config.hnswEfSearch,
                ).init();
            },
            loadVectors: (table, idCol, hnsw, cache) => {
                this._loadVectors(table, idCol, hnsw, cache);
            },
            collection: (name: string) => this.collection(name),
        };

        // Initialize all registered indexers
        for (const mod of this._modules.values()) {
            await mod.initialize(ctx);
        }

        // Cross-module search (needs code, git, or memory)
        const codeMod = this._modules.get('code') as any;
        const gitMod = this._modules.get('git') as any;
        const memMod = this._modules.get('memory') as any;

        if (codeMod || gitMod || memMod) {
            this._search = new UnifiedSearch({
                db: this._db,
                codeHnsw: codeMod?.hnsw,
                gitHnsw: gitMod?.hnsw,
                memHnsw: memMod?.hnsw,
                codeVecs: codeMod?.vecCache ?? new Map(),
                gitVecs: gitMod?.vecCache ?? new Map(),
                memVecs: memMod?.vecCache ?? new Map(),
                embedding: this._embedding,
                reranker: this._config.reranker,
            });

            this._bm25 = new BM25Search(this._db);
        }

        // Context builder (needs search + optional co-edits)
        if (this._search) {
            this._contextBuilder = new ContextBuilder(this._search, gitMod?.coEdits);
        }

        // Track embedding provider metadata
        setEmbeddingMeta(this._db, this._embedding);

        // Check for provider mismatch
        const mismatch = detectProviderMismatch(this._db, this._embedding);
        if (mismatch?.mismatch) {
            this.emit('warning', {
                type: 'provider_mismatch',
                message: `Embedding provider changed (${mismatch.stored} → ${mismatch.current}). ` +
                    `Run brain.reembed() to regenerate vectors.`,
            });
        }

        this._initialized = true;
        this.emit('initialized', { indexers: this.indexers });
    }

    // ── Collections ─────────────────────────────────

    /**
     * Get or create a dynamic collection.
     * Collections are the universal data primitive — store anything, search semantically.
     * 
     *   const errors = brain.collection('debug_errors');
     *   await errors.add('Fixed null check', { file: 'api.ts' });
     *   const hits = await errors.search('null pointer');
     */
    collection(name: string): Collection {
        let coll = this._collections.get(name);
        if (coll) return coll;

        if (!this._initialized) {
            throw new Error(
                'BrainBank: Must call initialize() before using collections. ' +
                'Or use await brain.collection() after an async operation.'
            );
        }

        // Lazy-create shared HNSW for all collections
        if (!this._kvHnsw) {
            throw new Error('BrainBank: Collections HNSW not initialized. Call initialize() first.');
        }

        coll = new Collection(name, this._db, this._embedding, this._kvHnsw, this._kvVecs, this._config.reranker);
        this._collections.set(name, coll);
        return coll;
    }

    /** List all collection names that have data. */
    listCollectionNames(): string[] {
        const rows = this._db.prepare(
            'SELECT DISTINCT collection FROM kv_data ORDER BY collection'
        ).all() as any[];
        return rows.map(r => r.collection);
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
        const codeMod = this._modules.get('code') as any;
        const gitMod = this._modules.get('git') as any;

        if (codeMod) {
            options.onProgress?.('code', 'Starting...');
            result.code = await codeMod.index({
                forceReindex: options.forceReindex,
                onProgress: (f: string, i: number, t: number) => options.onProgress?.('code', `[${i}/${t}] ${f}`),
            });
        }

        if (gitMod) {
            options.onProgress?.('git', 'Starting...');
            result.git = await gitMod.index({
                depth: options.gitDepth ?? this._config.gitDepth,
                onProgress: (f: string, i: number, t: number) => options.onProgress?.('git', `[${i}/${t}] ${f}`),
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
        await this.initialize();
        return this.module('code').index(options);
    }

    /** Index only git history. */
    async indexGit(options: {
        depth?: number;
        onProgress?: ProgressCallback;
    } = {}): Promise<IndexResult> {
        await this.initialize();
        return this.module('git').index(options);
    }

    // ── Document Collections ────────────────────────

    /** Register a document collection. */
    async addCollection(collection: DocumentCollection): Promise<void> {
        await this.initialize();
        this.module('docs').addCollection(collection);
    }

    /** Remove a collection and all its indexed data. */
    async removeCollection(name: string): Promise<void> {
        await this.initialize();
        this.module('docs').removeCollection(name);
    }

    /** List all registered collections. */
    listCollections(): DocumentCollection[] {
        return this.module('docs').listCollections();
    }

    /** Index all (or specific) document collections. */
    async indexDocs(options: {
        collections?: string[];
        onProgress?: (collection: string, file: string, current: number, total: number) => void;
    } = {}): Promise<Record<string, { indexed: number; skipped: number; chunks: number }>> {
        await this.initialize();
        const results = await this.module('docs').indexCollections(options);
        this.emit('docsIndexed', results);
        return results;
    }

    /** Search documents only. */
    async searchDocs(query: string, options?: {
        collection?: string;
        k?: number;
        minScore?: number;
    }): Promise<SearchResult[]> {
        await this.initialize();
        return this.module('docs').search(query, options);
    }

    // ── Context Metadata ────────────────────────────

    /** Add context description for a collection path. */
    addContext(collection: string, path: string, context: string): void {
        this.module('docs').addContext(collection, path, context);
    }

    /** Remove context for a collection path. */
    removeContext(collection: string, path: string): void {
        this.module('docs').removeContext(collection, path);
    }

    /** List all context entries. */
    listContexts(): { collection: string; path: string; context: string }[] {
        return this.module('docs').listContexts();
    }

    // ── Context ─────────────────────────────────────

    /**
     * Get formatted context for a task.
     * Returns markdown ready for system prompt injection.
     */
    async getContext(task: string, options: ContextOptions = {}): Promise<string> {
        await this.initialize();

        const sections: string[] = [];

        // Code/git/patterns context
        if (this._contextBuilder) {
            const coreContext = await this._contextBuilder.build(task, options);
            if (coreContext) sections.push(coreContext);
        }

        // Document context
        if (this.has('docs')) {
            const docResults = await this.searchDocs(task, { k: options.codeResults ?? 4 });
            if (docResults.length > 0) {
                const docSection = docResults.map(r => {
                    const header = r.context
                        ? `**[${r.metadata.collection}]** ${r.metadata.title} — _${r.context}_`
                        : `**[${r.metadata.collection}]** ${r.metadata.title}`;
                    return `${header}\n\n${r.content}`;
                }).join('\n\n---\n\n');
                sections.push(`## Relevant Documents\n\n${docSection}`);
            }
        }
        return sections.join('\n\n');
    }

    // ── Search ──────────────────────────────────────

    /** Semantic search across all loaded modules. */
    async search(query: string, options?: {
        codeK?: number; gitK?: number; memoryK?: number;
        minScore?: number; useMMR?: boolean;
    }): Promise<SearchResult[]> {
        await this.initialize();
        if (!this._search) {
            // No code/git/memory — fall back to doc search
            if (this.has('docs')) return this.searchDocs(query, { k: 8 });
            return [];
        }
        return this._search.search(query, options);
    }

    /** Semantic search over code only. */
    async searchCode(query: string, k: number = 8): Promise<SearchResult[]> {
        this.module('code'); // throws if not loaded
        await this.initialize();
        return this._search!.search(query, { codeK: k, gitK: 0, memoryK: 0 });
    }

    /** Semantic search over commits only. */
    async searchCommits(query: string, k: number = 8): Promise<SearchResult[]> {
        this.module('git'); // throws if not loaded
        await this.initialize();
        return this._search!.search(query, { codeK: 0, gitK: k, memoryK: 0 });
    }

    // ── Hybrid Search ───────────────────────────────

    /**
     * Hybrid search: vector + BM25 fused with Reciprocal Rank Fusion.
     * Best quality — catches both exact keyword matches and conceptual similarities.
     */
    async hybridSearch(query: string, options?: {
        codeK?: number; gitK?: number; memoryK?: number;
        minScore?: number; useMMR?: boolean;
    }): Promise<SearchResult[]> {
        await this.initialize();

        const resultLists: SearchResult[][] = [];

        if (this._search) {
            const [vectorResults, bm25Results] = await Promise.all([
                this._search.search(query, options),
                Promise.resolve(this._bm25!.search(query, options)),
            ]);
            resultLists.push(vectorResults, bm25Results);
        }

        if (this.has('docs')) {
            const docResults = await this.searchDocs(query, { k: 8 });
            if (docResults.length > 0) resultLists.push(docResults);
        }

        if (resultLists.length === 0) return [];

        const fused = reciprocalRankFusion(resultLists);

        // Apply re-ranking if available
        if (this._config.reranker && fused.length > 1) {
            const documents = fused.map(r => r.content);
            const scores = await this._config.reranker.rank(query, documents);
            const blended = fused.map((r, i) => ({
                ...r,
                score: 0.6 * r.score + 0.4 * (scores[i] ?? 0),
            }));
            return blended.sort((a, b) => b.score - a.score);
        }

        return fused;
    }

    /** BM25 keyword search only (no embeddings needed). */
    searchBM25(query: string, options?: {
        codeK?: number; gitK?: number; memoryK?: number;
    }): SearchResult[] {
        if (!this._bm25) return [];
        return this._bm25.search(query, options);
    }

    /** Rebuild FTS5 indices. */
    rebuildFTS(): void {
        this._bm25?.rebuild();
    }



    // ── Query ───────────────────────────────────────

    /** Get git history for a specific file. */
    async fileHistory(filePath: string, limit: number = 20): Promise<any[]> {
        this.module('git');
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
        const gitMod = this.module('git') as any;
        return gitMod.suggest(filePath, limit);
    }

    // ── Stats ───────────────────────────────────────

    /** Get statistics for all loaded modules. */
    stats(): IndexStats {
        const result: IndexStats = {};

        if (this.has('code')) {
            const mod = this.indexer('code') as any;
            result.code = {
                files: (this._db.prepare('SELECT COUNT(DISTINCT file_path) as c FROM code_chunks').get() as any).c,
                chunks: (this._db.prepare('SELECT COUNT(*) as c FROM code_chunks').get() as any).c,
                hnswSize: mod.hnsw?.size ?? 0,
            };
        }

        if (this.has('git')) {
            const mod = this.indexer('git') as any;
            result.git = {
                commits: (this._db.prepare('SELECT COUNT(*) as c FROM git_commits').get() as any).c,
                filesTracked: (this._db.prepare('SELECT COUNT(DISTINCT file_path) as c FROM commit_files').get() as any).c,
                coEdits: (this._db.prepare('SELECT COUNT(*) as c FROM co_edits').get() as any).c,
                hnswSize: mod.hnsw?.size ?? 0,
            };
        }

        if (this.has('docs')) {
            const mod = this.indexer('docs') as any;
            result.documents = mod.stats();
        }

        return result;
    }

    // ── Watch Mode ───────────────────────────────────

    /**
     * Start watching for file changes and auto-re-index.
     * Works with built-in and custom indexers.
     * 
     *   const watcher = brain.watch({
     *     onIndex: (file, indexer) => console.log(`${indexer}: ${file}`),
     *   });
     *   // later: watcher.close();
     */
    watch(options: WatchOptions = {}): Watcher {
        if (!this._initialized) {
            throw new Error('BrainBank: Not initialized. Call initialize() before watch().');
        }

        // Close any existing watcher
        this._watcher?.close();

        this._watcher = createWatcher(
            async () => { await this.index(); },
            this._modules,
            this._config.repoPath,
            options,
        );

        return this._watcher;
    }

    // ── Re-embedding ────────────────────────────────

    /**
     * Re-embed all existing text with the current embedding provider.
     * Use this when switching providers (e.g. Local → OpenAI).
     * Does NOT re-parse files, git history, or documents — only regenerates vectors.
     *
     * @example
     *   const brain = new BrainBank({ embeddingProvider: new OpenAIEmbedding() });
     *   await brain.initialize();
     *   const result = await brain.reembed();
     *   // → { code: 1200, git: 500, docs: 80, kv: 45, notes: 12, total: 1837 }
     */
    async reembed(options: ReembedOptions = {}): Promise<ReembedResult> {
        if (!this._initialized) {
            throw new Error('BrainBank: Not initialized. Call initialize() before reembed().');
        }

        // Build HNSW map for rebuild
        const hnswMap = new Map<string, { hnsw: HNSWIndex; vecs: Map<number, Float32Array> }>();

        // KV collections HNSW
        if (this._kvHnsw) {
            hnswMap.set('kv', { hnsw: this._kvHnsw, vecs: this._kvVecs });
        }

        // Indexer-managed HNSW indices
        const codeMod = this._modules.get('code') as any;
        const gitMod = this._modules.get('git') as any;
        const memMod = this._modules.get('memory') as any;
        const docsMod = this._modules.get('docs') as any;
        const notesMod = this._modules.get('notes') as any;

        if (codeMod?.hnsw) hnswMap.set('code', { hnsw: codeMod.hnsw, vecs: codeMod.vecCache });
        if (gitMod?.hnsw) hnswMap.set('git', { hnsw: gitMod.hnsw, vecs: gitMod.vecCache });
        if (memMod?.hnsw) hnswMap.set('memory', { hnsw: memMod.hnsw, vecs: memMod.vecCache });
        if (notesMod?.hnsw) hnswMap.set('notes', { hnsw: notesMod.hnsw, vecs: notesMod.vecCache });
        if (docsMod?.hnsw) hnswMap.set('docs', { hnsw: docsMod.hnsw, vecs: docsMod.vecCache });

        const result = await reembedAll(
            this._db,
            this._embedding,
            hnswMap,
            options,
        );

        this.emit('reembedded', result);
        return result;
    }

    // ── Lifecycle ────────────────────────────────────

    /** Close database and release resources. */
    close(): void {
        this._watcher?.close();
        for (const indexer of this._modules.values()) {
            indexer.close?.();
        }
        if (this._db) this._db.close();
        this._initialized = false;
        this._collections.clear();
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

    /** Load vectors from SQLite into HNSW index. */
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

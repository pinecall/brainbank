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
import { resolveConfig } from '../config/defaults.ts';
import { Database } from '../db/database.ts';
import { HNSWIndex } from '../providers/vector/hnsw.ts';
import { LocalEmbedding } from '../providers/embeddings/local.ts';
import { MultiIndexSearch } from '../search/vector/multi-index.ts';
import { BM25Search } from '../search/keyword/bm25.ts';
import { reciprocalRankFusion } from '../search/rrf.ts';
import { ContextBuilder } from './context.ts';
import { Collection } from './collection.ts';
import { IndexerRegistry } from './registry.ts';
import { reembedAll, setEmbeddingMeta, detectProviderMismatch } from '../services/reembed.ts';
import { createWatcher, type WatchOptions, type Watcher } from '../services/watch.ts';
import type { ReembedResult, ReembedOptions } from '../services/reembed.ts';
import type { Indexer, IndexerContext } from '../indexers/base.ts';
import type {
    BrainBankConfig, ResolvedConfig, EmbeddingProvider,
    IndexResult, IndexStats, SearchResult,
    ContextOptions, CoEditSuggestion, ProgressCallback, StageProgressCallback,
    DocumentCollection,
} from '../types.ts';

export class BrainBank extends EventEmitter {
    private _config: ResolvedConfig;
    private _db!: Database;
    private _embedding!: EmbeddingProvider;
    private _registry = new IndexerRegistry();

    // Cross-module search (created if code/git/memory are present)
    private _search?: MultiIndexSearch;
    private _bm25?: BM25Search;
    private _contextBuilder?: ContextBuilder;

    private _initialized = false;
    private _initPromise: Promise<void> | null = null;
    private _watcher?: Watcher;

    // Collections
    private _collections = new Map<string, Collection>();
    private _kvHnsw?: HNSWIndex;
    private _kvVecs = new Map<number, Float32Array>();

    // Shared HNSW pool for multi-repo (code:frontend, code:backend share one HNSW)
    private _sharedHnsw = new Map<string, { hnsw: HNSWIndex; vecCache: Map<number, Float32Array> }>();

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
                `Call .use() before any operations.`,
            );
        }
        this._registry.register(indexer);
        return this;
    }

    /** Get the list of registered indexer names. */
    get indexers(): string[] {
        return this._registry.names;
    }

    /** Check if an indexer is loaded. Also matches type prefix (e.g. 'code' matches 'code:frontend'). */
    has(name: string): boolean {
        return this._registry.has(name);
    }

    /** Get an indexer instance. Throws if not loaded. */
    indexer<T extends Indexer = Indexer>(name: string): T {
        return this._registry.get<T>(name);
    }

    /** Find all indexers whose name equals or starts with the type prefix. */
    private _findAllByType(type: string): Indexer[] {
        return this._registry.allByType(type);
    }

    /** Find the first indexer that matches the type. */
    private _findFirstByType(type: string): Indexer | undefined {
        return this._registry.firstByType(type);
    }

    // ── Initialization ──────────────────────────────

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
                // Reset shared state so retry starts clean (no duplicate HNSW vectors)
                for (const { hnsw } of this._sharedHnsw.values()) {
                    try { hnsw.reinit(); } catch {}
                }
                this._kvVecs.clear();
                if (this._kvHnsw) {
                    try { this._kvHnsw.reinit(); } catch {}
                }
                throw err;
            })
            .finally(() => {
                this._initPromise = null;
            });
        return this._initPromise;
    }

    private async _runInitialize(): Promise<void> {
        if (this._initialized) return;

        const config = this._config;

        // Database (always needed)
        this._db = new Database(config.dbPath);

        // Embedding provider (needed for modules and collections)
        this._embedding = config.embeddingProvider ?? new LocalEmbedding();

        // Detect provider change BEFORE overwriting stored metadata.
        // If setEmbeddingMeta ran first, it would stamp the current provider,
        // making detectProviderMismatch always see current == stored → false.
        const mismatch = detectProviderMismatch(this._db, this._embedding);
        const skipVectorLoad = !!mismatch?.mismatch;
        if (skipVectorLoad) {
            this.emit('warning', {
                type: 'provider_mismatch',
                previous: mismatch!.stored,
                current: mismatch!.current,
                message: 'Embedding provider changed — vectors not loaded. Run brain.reembed() to regenerate.',
            });
        }

        // Update stored metadata AFTER the check so old values were readable above.
        setEmbeddingMeta(this._db, this._embedding);

        // Initialize HNSW for dynamic collections (must come before indexer init)
        this._kvHnsw = new HNSWIndex(
            config.embeddingDims,
            config.maxElements ?? 500_000,
            config.hnswM,
            config.hnswEfConstruction,
            config.hnswEfSearch,
        );
        await this._kvHnsw.init();
        if (!skipVectorLoad) {
            this._loadVectors('kv_vectors', 'data_id', this._kvHnsw, this._kvVecs);
        }

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
            getOrCreateSharedHnsw: async (type: string, maxElements?: number) => {
                const existing = this._sharedHnsw.get(type);
                if (existing) return { ...existing, isNew: false };
                const hnsw = await new HNSWIndex(
                    config.embeddingDims,
                    maxElements ?? config.maxElements,
                    config.hnswM,
                    config.hnswEfConstruction,
                    config.hnswEfSearch,
                ).init();
                const vecCache = new Map<number, Float32Array>();
                this._sharedHnsw.set(type, { hnsw, vecCache });
                return { hnsw, vecCache, isNew: true };
            },
            collection: (name: string) => this.collection(name),
        };

        // Initialize all registered indexers
        for (const mod of this._registry.all) {
            await mod.initialize(ctx);
        }

        // Cross-module search (needs code, git, or memory)
        // For multi-repo: find ANY indexer that starts with 'code' or 'git'
        const codeMod = this._sharedHnsw.get('code');
        const gitMod = this._sharedHnsw.get('git');
        const memMod = this._registry.firstByType('learning') as any;

        if (codeMod || gitMod || memMod) {
            this._search = new MultiIndexSearch({
                db: this._db,
                codeHnsw: codeMod?.hnsw,
                gitHnsw: gitMod?.hnsw,
                patternHnsw: memMod?.hnsw,
                codeVecs: codeMod?.vecCache ?? new Map(),
                gitVecs: gitMod?.vecCache ?? new Map(),
                patternVecs: memMod?.vecCache ?? new Map(),
                embedding: this._embedding,
                reranker: this._config.reranker,
            });

            this._bm25 = new BM25Search(this._db);
        }

        // Context builder (needs search + optional co-edits from first git indexer)
        if (this._search) {
            const firstGit = this._findFirstByType('git') as any;
            this._contextBuilder = new ContextBuilder(this._search, firstGit?.coEdits);
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

        // Guard: KV HNSW must be ready (set up before indexers run,
        // so indexers CAN call ctx.collection() during initialize())
        if (!this._kvHnsw) {
            throw new Error(
                'BrainBank: Collections not ready. Call await brain.initialize() first.'
            );
        }

        coll = new Collection(name, this._db, this._embedding, this._kvHnsw, this._kvVecs, this._config.reranker);
        this._collections.set(name, coll);
        return coll;
    }

    /** List all collection names that have data. */
    listCollectionNames(): string[] {
        this._requireInit('listCollectionNames');
        const rows = this._db.prepare(
            'SELECT DISTINCT collection FROM kv_data ORDER BY collection'
        ).all() as any[];
        return rows.map(r => r.collection);
    }

    // ── Indexing ─────────────────────────────────────

    /**
     * Index code, git, and/or docs in one call.
     * Incremental — only processes changes since last run.
     * @param modules - Which modules to index. Default: all available (['code', 'git', 'docs'])
     */
    async index(options: {
        modules?: ('code' | 'git' | 'docs')[];
        gitDepth?: number;
        forceReindex?: boolean;
        onProgress?: StageProgressCallback;
    } = {}): Promise<{ code?: IndexResult; git?: IndexResult; docs?: Record<string, { indexed: number; skipped: number; chunks: number }> }> {
        await this.initialize();

        const want = new Set(options.modules ?? ['code', 'git', 'docs']);
        const result: { code?: IndexResult; git?: IndexResult; docs?: Record<string, { indexed: number; skipped: number; chunks: number }> } = {};

        // Index ALL code-type indexers (code, code:frontend, code:backend, etc.)
        if (want.has('code')) {
            const codeMods = this._findAllByType('code');
            for (const mod of codeMods) {
                const label = mod.name === 'code' ? 'code' : mod.name;
                options.onProgress?.(label, 'Starting...');
                const r = await mod.index!({
                    forceReindex: options.forceReindex,
                    onProgress: (f: string, i: number, t: number) => options.onProgress?.(label, `[${i}/${t}] ${f}`),
                });
                // Merge results
                if (result.code) {
                    result.code.indexed += r.indexed;
                    result.code.skipped += r.skipped;
                    result.code.chunks = (result.code.chunks ?? 0) + (r.chunks ?? 0);
                } else {
                    result.code = r;
                }
            }
        }

        // Index ALL git-type indexers
        if (want.has('git')) {
            const gitMods = this._findAllByType('git');
            for (const mod of gitMods) {
                const label = mod.name === 'git' ? 'git' : mod.name;
                options.onProgress?.(label, 'Starting...');
                const r = await mod.index!({
                    depth: options.gitDepth ?? this._config.gitDepth,
                    onProgress: (f: string, i: number, t: number) => options.onProgress?.(label, `[${i}/${t}] ${f}`),
                });
                if (result.git) {
                    result.git.indexed += r.indexed;
                    result.git.skipped += r.skipped;
                } else {
                    result.git = r;
                }
            }
        }

        // Index document collections
        if (want.has('docs') && this._registry.has('docs')) {
            options.onProgress?.('docs', 'Starting...');
            const docsResults = await this.indexer('docs').indexCollections!({
                onProgress: (coll: string, file: string, cur: number, total: number) =>
                    options.onProgress?.('docs', `[${coll}] ${cur}/${total}: ${file}`),
            });
            result.docs = docsResults;
        }

        this.emit('indexed', result);
        return result;
    }

    /** Index only code files (all repos in multi-repo mode). */
    async indexCode(options: {
        forceReindex?: boolean;
        onProgress?: ProgressCallback;
    } = {}): Promise<IndexResult> {
        await this.initialize();
        const mods = this._findAllByType('code');
        if (mods.length === 0) throw new Error("BrainBank: Indexer 'code' is not loaded. Add .use(code()) to your BrainBank instance.");
        // Sequential: all code indexers share one HNSW index; Promise.all would interleave writes.
        const acc: IndexResult = { indexed: 0, skipped: 0, chunks: 0 };
        for (const mod of mods) {
            const r = await mod.index!(options);
            acc.indexed += r.indexed;
            acc.skipped += r.skipped;
            acc.chunks = (acc.chunks ?? 0) + (r.chunks ?? 0);
        }
        return acc;
    }

    /** Index only git history (all repos in multi-repo mode). */
    async indexGit(options: {
        depth?: number;
        onProgress?: ProgressCallback;
    } = {}): Promise<IndexResult> {
        await this.initialize();
        const mods = this._findAllByType('git');
        if (mods.length === 0) throw new Error("BrainBank: Indexer 'git' is not loaded. Add .use(git()) to your BrainBank instance.");
        // Sequential: all git indexers share one HNSW index.
        const acc: IndexResult = { indexed: 0, skipped: 0 };
        for (const mod of mods) {
            const r = await mod.index!(options);
            acc.indexed += r.indexed;
            acc.skipped += r.skipped;
        }
        return acc;
    }

    // ── Document Collections ────────────────────────

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
        if (!this._initialized) {
            throw new Error('BrainBank: Not initialized. Call await brain.initialize() before listCollections().');
        }
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
    async searchDocs(query: string, options?: {
        collection?: string;
        k?: number;
        minScore?: number;
    }): Promise<SearchResult[]> {
        await this.initialize();
        return this.indexer('docs').search!(query, options);
    }

    // ── Context Metadata ────────────────────────────

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
                    const meta = r.metadata as Record<string, any>;
                    const header = r.context
                        ? `**[${meta.collection}]** ${meta.title} — _${r.context}_`
                        : `**[${meta.collection}]** ${meta.title}`;
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
        codeK?: number; gitK?: number; patternK?: number;
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
        if (!this._findFirstByType('code')) throw new Error('BrainBank: code indexer not loaded.');
        await this.initialize();
        if (!this._search) throw new Error('BrainBank: MultiIndexSearch not available. Ensure code indexer is loaded.');
        return this._search.search(query, { codeK: k, gitK: 0, patternK: 0 });
    }

    /** Semantic search over commits only. */
    async searchCommits(query: string, k: number = 8): Promise<SearchResult[]> {
        if (!this._findFirstByType('git')) throw new Error('BrainBank: git indexer not loaded.');
        await this.initialize();
        if (!this._search) throw new Error('BrainBank: MultiIndexSearch not available. Ensure git indexer is loaded.');
        return this._search.search(query, { codeK: 0, gitK: k, patternK: 0 });
    }

    // ── Hybrid Search ───────────────────────────────

    /**
     * Hybrid search: vector + BM25 fused with Reciprocal Rank Fusion.
     * Best quality — catches both exact keyword matches and conceptual similarities.
     */
    async hybridSearch(query: string, options?: {
        /** Max code results (overridden by collections.code if set) */
        codeK?: number;
        /** Max git results (overridden by collections.git if set) */
        gitK?: number;
        patternK?: number;
        minScore?: number; useMMR?: boolean;
        /**
         * Sources to include and max results per source.
         * Reserved keys: "code", "git", "docs" control built-in indexers.
         * Any other key is treated as a KV collection name.
         * Example: { code: 8, git: 5, docs: 4, errors: 3, slack: 2 }
         */
        collections?: Record<string, number>;
    }): Promise<SearchResult[]> {
        await this.initialize();

        const cols = options?.collections ?? {};
        const codeK = cols.code ?? options?.codeK ?? 6;
        const gitK = cols.git ?? options?.gitK ?? 5;
        const docsK = cols.docs ?? 8;

        const resultLists: SearchResult[][] = [];

        if (this._search) {
            const searchOpts = { ...options, codeK, gitK };
            const [vectorResults, bm25Results] = await Promise.all([
                this._search.search(query, searchOpts),
                Promise.resolve(this._bm25!.search(query, searchOpts)),
            ]);
            resultLists.push(vectorResults, bm25Results);
        }

        if (this.has('docs')) {
            const docResults = await this.searchDocs(query, { k: docsK });
            if (docResults.length > 0) resultLists.push(docResults);
        }

        // Include KV collections (skip reserved keys)
        const reserved = new Set(['code', 'git', 'docs']);
        for (const [name, k] of Object.entries(cols)) {
            if (reserved.has(name)) continue;
            const col = this.collection(name);
            const hits = await col.search(query, { k });
            if (hits.length > 0) {
                resultLists.push(hits.map(h => ({
                    type: 'collection' as const,
                    score: h.score ?? 0,
                    content: h.content,
                    metadata: { collection: name, id: h.id, ...h.metadata },
                })));
            }
        }

        if (resultLists.length === 0) return [];

        const fused = reciprocalRankFusion(resultLists);

        // Apply position-aware re-ranking if available
        if (this._config.reranker && fused.length > 1) {
            const documents = fused.map(r => r.content);
            const scores = await this._config.reranker.rank(query, documents);
            const blended = fused.map((r, i) => {
                const pos = i + 1;
                const rrfWeight = pos <= 3 ? 0.75 : pos <= 10 ? 0.60 : 0.40;
                return {
                    ...r,
                    score: rrfWeight * r.score + (1 - rrfWeight) * (scores[i] ?? 0),
                };
            });
            return blended.sort((a, b) => b.score - a.score);
        }

        return fused;
    }

    /** BM25 keyword search only (no embeddings needed). */
    searchBM25(query: string, options?: {
        codeK?: number; gitK?: number; patternK?: number;
    }): SearchResult[] {
        this._requireInit('searchBM25');
        if (!this._bm25) return [];
        return this._bm25.search(query, options);
    }

    /** Rebuild FTS5 indices. */
    rebuildFTS(): void {
        this._requireInit('rebuildFTS');
        this._bm25?.rebuild();
    }



    // ── Query ───────────────────────────────────────

    /** Get git history for a specific file. */
    async fileHistory(filePath: string, limit: number = 20): Promise<any[]> {
        this.indexer('git');
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
        this._requireInit('coEdits');
        const gitMod = this.indexer('git');
        return (gitMod as any).suggestCoEdits(filePath, limit);
    }

    // ── Stats ───────────────────────────────────────

    /** Get statistics for all loaded modules. */
    stats(): IndexStats {
        this._requireInit('stats');
        const result: IndexStats = {};

        if (this.has('code')) {
            const sharedCode = this._sharedHnsw.get('code');
            result.code = {
                files: (this._db.prepare('SELECT COUNT(DISTINCT file_path) as c FROM code_chunks').get() as any).c,
                chunks: (this._db.prepare('SELECT COUNT(*) as c FROM code_chunks').get() as any).c,
                hnswSize: sharedCode?.hnsw.size ?? 0,
            };
        }

        if (this.has('git')) {
            const sharedGit = this._sharedHnsw.get('git');
            result.git = {
                commits: (this._db.prepare('SELECT COUNT(*) as c FROM git_commits').get() as any).c,
                filesTracked: (this._db.prepare('SELECT COUNT(DISTINCT file_path) as c FROM commit_files').get() as any).c,
                coEdits: (this._db.prepare('SELECT COUNT(*) as c FROM co_edits').get() as any).c,
                hnswSize: sharedGit?.hnsw.size ?? 0,
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
        this._requireInit('watch');

        // Close any existing watcher
        this._watcher?.close();

        this._watcher = createWatcher(
            async () => { await this.index(); },
            this._registry.raw,
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
        this._requireInit('reembed');

        // Build HNSW map for rebuild
        const hnswMap = new Map<string, { hnsw: HNSWIndex; vecs: Map<number, Float32Array> }>();

        // KV collections HNSW
        if (this._kvHnsw) {
            hnswMap.set('kv', { hnsw: this._kvHnsw, vecs: this._kvVecs });
        }

        // code/git use shared HNSW pool (key = type, e.g. 'code', 'git')
        for (const [type, shared] of this._sharedHnsw) {
            hnswMap.set(type, { hnsw: shared.hnsw, vecs: shared.vecCache });
        }

        // Per-indexer HNSW (learning → 'memory', notes, docs)
        const INDEXER_TABLE: Record<string, string> = { learning: 'memory' };
        for (const type of ['learning', 'notes', 'docs'] as const) {
            const mod = this._findFirstByType(type) as any;
            if (mod?.hnsw) {
                hnswMap.set(INDEXER_TABLE[type] ?? type, { hnsw: mod.hnsw, vecs: mod.vecCache });
            }
        }

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
        for (const indexer of this._registry.all) {
            indexer.close?.();
        }
        if (this._db) this._db.close();
        this._initialized = false;
        this._collections.clear();
        this._sharedHnsw.clear();
        this._kvVecs.clear();
        this._kvHnsw = undefined as any;
        this._registry.clear();
        this._search = undefined;
        this._bm25 = undefined;
        this._contextBuilder = undefined;
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
     * Assert the instance is initialized.
     * Consistent guard for all sync public methods.
     */
    private _requireInit(method: string): void {
        if (!this._initialized) {
            throw new Error(
                `BrainBank: Not initialized. ` +
                `Call await brain.initialize() before ${method}().`,
            );
        }
    }

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

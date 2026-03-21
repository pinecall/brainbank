/**
 * BrainBank — Main Orchestrator
 * 
 * Composable semantic knowledge bank for AI agents.
 * Enable only the modules you need via .use():
 * 
 *   import { BrainBank } from 'brainbank';
 *   import { code } from 'brainbank/code';
 *   import { docs } from 'brainbank/docs';
 *   import { conversations } from 'brainbank/conversations';
 *   import { memory } from 'brainbank/memory';
 *   
 *   const brain = new BrainBank()
 *     .use(code({ repoPath: '.' }))
 *     .use(docs())
 *     .use(conversations())
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
import type { BrainBankModule, ModuleContext } from '../modules/types.ts';
import type {
    BrainBankConfig, ResolvedConfig, EmbeddingProvider,
    IndexResult, IndexStats, MemoryPattern, SearchResult,
    ContextOptions, CoEditSuggestion, ProgressCallback,
    DistilledStrategy, DocumentCollection,
} from '../types.ts';

// Module implementations (for typed access)
import type { ConversationDigest, StoredMemory, RecallOptions } from '../memory/conversation-store.ts';

export class BrainBank extends EventEmitter {
    private _config: ResolvedConfig;
    private _db!: Database;
    private _embedding!: EmbeddingProvider;
    private _modules = new Map<string, BrainBankModule>();

    // Cross-module search (created if code/git/memory are present)
    private _search?: UnifiedSearch;
    private _bm25?: BM25Search;
    private _contextBuilder?: ContextBuilder;

    private _initialized = false;

    constructor(config: BrainBankConfig = {}) {
        super();
        this._config = resolveConfig(config);
    }

    // ── Module Registration ─────────────────────────

    /**
     * Register a module. Chainable.
     * 
     *   brain.use(code({ repoPath: '.' })).use(docs()).use(memory());
     */
    use(module: BrainBankModule): this {
        if (this._initialized) {
            throw new Error(
                `BrainBank: Cannot add module '${module.name}' after initialization. ` +
                `Call .use() before any operations.`
            );
        }
        this._modules.set(module.name, module);
        return this;
    }

    /** Get the list of registered module names. */
    get modules(): string[] {
        return [...this._modules.keys()];
    }

    /** Check if a module is loaded. */
    has(name: string): boolean {
        return this._modules.has(name);
    }

    /** Get a module instance. Throws if not loaded. */
    module(name: string): any {
        const mod = this._modules.get(name);
        if (!mod) {
            throw new Error(
                `BrainBank: Module '${name}' is not loaded. ` +
                `Add .use(${name}()) to your BrainBank instance.`
            );
        }
        return mod;
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

        // Embedding provider (needed if any modules are registered)
        if (this._modules.size > 0) {
            this._embedding = config.embeddingProvider ?? new LocalEmbedding();
        }

        // Create the shared context for modules
        const ctx: ModuleContext = {
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
        };

        // Initialize all registered modules
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
            });

            this._bm25 = new BM25Search(this._db);
        }

        // Context builder (needs search + optional co-edits)
        if (this._search) {
            this._contextBuilder = new ContextBuilder(this._search, gitMod?.coEdits);
        }

        this._initialized = true;
        this.emit('initialized', { modules: this.modules });
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

        // Conversation context
        if (this.has('conversations')) {
            const memories = await this.recall(task, { k: 3 });
            if (memories.length > 0) {
                const convSection = memories.map(m =>
                    `**${m.title}** (${new Date(m.createdAt * 1000).toLocaleDateString()})\n${m.summary}`
                ).join('\n\n');
                sections.push(`## Relevant Conversations\n\n${convSection}`);
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
        return reciprocalRankFusion(resultLists);
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

    // ── Memory / Learning ───────────────────────────

    /** Store a learned pattern from a completed task. */
    async learn(pattern: MemoryPattern): Promise<number> {
        await this.initialize();
        const mod = this.module('memory') as any;
        const id = await mod.learn(pattern);
        this.emit('learned', { id, pattern });
        return id;
    }

    /** Search for similar learned patterns. */
    async searchPatterns(query: string, k: number = 4): Promise<(MemoryPattern & { score: number })[]> {
        await this.initialize();
        return this.module('memory').search(query, k);
    }

    /** Consolidate memory: prune old failures + deduplicate. */
    consolidate(): { pruned: number; deduped: number } {
        return this.module('memory').consolidate();
    }

    /** Distill top patterns into a strategy for a task type. */
    distill(taskType: string): DistilledStrategy | null {
        return this.module('memory').distill(taskType);
    }

    // ── Conversation Memory ─────────────────────────

    /** Store a conversation digest for long-term memory. */
    async remember(digest: ConversationDigest): Promise<number> {
        await this.initialize();
        const mod = this.module('conversations') as any;
        const id = await mod.remember(digest);
        this.emit('remembered', { id, digest });
        return id;
    }

    /** Recall relevant conversation memories. */
    async recall(query: string, options?: RecallOptions): Promise<StoredMemory[]> {
        await this.initialize();
        return this.module('conversations').recall(query, options);
    }

    /** List recent conversation memories. */
    listMemories(limit?: number, tier?: 'short' | 'long'): StoredMemory[] {
        return this.module('conversations').list(limit, tier);
    }

    /** Consolidate old conversation memories (short → long tier). */
    consolidateMemories(keepRecent?: number): { promoted: number } {
        return this.module('conversations').consolidate(keepRecent);
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
            const mod = this.module('code') as any;
            result.code = {
                files: (this._db.prepare('SELECT COUNT(DISTINCT file_path) as c FROM code_chunks').get() as any).c,
                chunks: (this._db.prepare('SELECT COUNT(*) as c FROM code_chunks').get() as any).c,
                hnswSize: mod.hnsw?.size ?? 0,
            };
        }

        if (this.has('git')) {
            const mod = this.module('git') as any;
            result.git = {
                commits: (this._db.prepare('SELECT COUNT(*) as c FROM git_commits').get() as any).c,
                filesTracked: (this._db.prepare('SELECT COUNT(DISTINCT file_path) as c FROM commit_files').get() as any).c,
                coEdits: (this._db.prepare('SELECT COUNT(*) as c FROM co_edits').get() as any).c,
                hnswSize: mod.hnsw?.size ?? 0,
            };
        }

        if (this.has('memory')) {
            const mod = this.module('memory') as any;
            const count = (this._db.prepare('SELECT COUNT(*) as c FROM memory_patterns').get() as any).c;
            const avg = (this._db.prepare('SELECT AVG(success_rate) as a FROM memory_patterns').get() as any).a ?? 0;
            result.memory = {
                patterns: count,
                avgSuccess: avg,
                hnswSize: mod.hnsw?.size ?? 0,
            };
        }

        if (this.has('docs')) {
            const mod = this.module('docs') as any;
            result.documents = mod.stats();
        }

        if (this.has('conversations')) {
            const mod = this.module('conversations') as any;
            result.conversations = mod.count();
        }

        return result;
    }

    // ── Lifecycle ────────────────────────────────────

    /** Close database and release resources. */
    close(): void {
        for (const mod of this._modules.values()) {
            mod.close?.();
        }
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

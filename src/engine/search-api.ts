/**
 * BrainBank — Search API
 *
 * Thin orchestrator for all search operations.
 * Pipeline: collect → fuse (RRF) → rerank.
 *
 * Plugin-agnostic — discovers vector strategies and searchable plugins
 * via capability interfaces. No hardcoded plugin names.
 */

import type { DatabaseAdapter } from '@/db/adapter.ts';
import type { HNSWIndex } from '@/providers/vector/hnsw-index.ts';
import type { SearchStrategy, SearchOptions, DomainVectorSearch } from '@/search/types.ts';
import type { KVService } from '@/services/kv-service.ts';
import type { PluginRegistry } from '@/services/plugin-registry.ts';
import type { ResolvedConfig, EmbeddingProvider, SearchResult, ContextOptions } from '@/types.ts';

import { isVectorSearchPlugin, isSearchable, isCoEditPlugin, isContextFormatterPlugin } from '@/plugin.ts';
import { rerank } from '@/lib/rerank.ts';
import { reciprocalRankFusion } from '@/lib/rrf.ts';
import { ContextBuilder } from '@/search/context-builder.ts';
import { CompositeBM25Search } from '@/search/keyword/composite-bm25-search.ts';
import { CompositeVectorSearch } from '@/search/vector/composite-vector-search.ts';
import { logQuery } from '@/lib/logger.ts';
import type { QueryLogResult } from '@/lib/logger.ts';
import { providerKey } from '@/lib/provider-key.ts';

/** Dependencies injected at construction time. */
export interface SearchAPIDeps {
    search?:          SearchStrategy;
    bm25?:            SearchStrategy;
    registry:         PluginRegistry;
    config:           ResolvedConfig;
    kvService:        KVService;
    contextBuilder?:  ContextBuilder;
    embedding:        EmbeddingProvider;
}

/**
 * Build a fully-wired SearchAPI from registry state.
 * Discovers vector strategies from VectorSearchPlugin capability.
 * Always returns an instance — handles search-less setups internally.
 */
export function createSearchAPI(
    _db: DatabaseAdapter,
    embedding: EmbeddingProvider,
    config: ResolvedConfig,
    registry: PluginRegistry,
    kvService: KVService,
    sharedHnsw: Map<string, { hnsw: HNSWIndex; vecCache: Map<number, Float32Array> }>,
): SearchAPI {
    const strategies = new Map<string, DomainVectorSearch>();

    for (const mod of registry.all) {
        if (isVectorSearchPlugin(mod)) {
            const vs = mod.createVectorSearch();
            if (vs) {
                // Use full plugin name (e.g. code:servicehub-backend)
                // so each repo gets its own vector search strategy
                strategies.set(mod.name, vs);
            }
        }
    }

    const search = strategies.size > 0
        ? new CompositeVectorSearch({
            strategies,
            embedding,
        })
        : undefined;

    const bm25 = new CompositeBM25Search(registry);

    const rerankerName = config.reranker ? (config.reranker.constructor?.name ?? 'custom') : undefined;
    const contextBuilder = new ContextBuilder(search, registry, config.pruner, embedding, rerankerName, config.contextFields ?? {}, config.expander);

    return new SearchAPI({
        search, bm25, registry, config,
        kvService, contextBuilder, embedding,
    });
}


export class SearchAPI {
    constructor(private _d: SearchAPIDeps) {}

    /** Build formatted context block for LLM injection. */
    async getContext(task: string, options: ContextOptions = {}): Promise<string> {
        if (!this._d.contextBuilder) return '';
        return this._d.contextBuilder.build(task, options);
    }

    /** Semantic search across all loaded modules. */
    async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
        const t0 = Date.now();
        const lists: SearchResult[][] = [];

        if (this._d.search) {
            lists.push(await this._d.search.search(query, options));
        }

        lists.push(...await this._collectSearchablePlugins(query, options));

        let results: SearchResult[];
        if (lists.length === 0) results = [];
        else if (lists.length === 1) results = lists[0];
        else results = reciprocalRankFusion(lists);

        this._logSearch('search', query, options, results, Date.now() - t0);
        return results;
    }

    /** Hybrid search: vector + BM25 → RRF. */
    async hybridSearch(query: string, options?: SearchOptions): Promise<SearchResult[]> {
        const t0 = Date.now();
        const src = options?.sources ?? {};
        const lists: SearchResult[][] = [];

        if (this._d.search) {
            const [vec, kw] = await Promise.all([
                this._d.search.search(query, options),
                Promise.resolve(this._d.bm25?.search(query, options) ?? []),
            ]);
            lists.push(vec, kw);
        }

        lists.push(...await this._collectSearchablePlugins(query, options));
        lists.push(...await this._collectKvCollections(query, src));

        let results: SearchResult[];
        if (lists.length === 0) results = [];
        else {
            const fused = reciprocalRankFusion(lists);
            if (this._d.config.reranker && fused.length > 1) {
                results = await rerank(query, fused, this._d.config.reranker);
            } else {
                results = fused;
            }
        }

        this._logSearch('hybridSearch', query, options, results, Date.now() - t0);
        return results;
    }

    /** BM25 keyword search only. */
    async searchBM25(query: string, options?: SearchOptions): Promise<SearchResult[]> {
        const t0 = Date.now();
        const results = await this._d.bm25?.search(query, options) ?? [];
        this._logSearch('searchBM25', query, options, results, Date.now() - t0);
        return results;
    }

    /** Rebuild FTS5 indices. */
    rebuildFTS(): void {
        this._d.bm25?.rebuild?.();
    }

    /** Collect results from all SearchablePlugins (docs, custom). */
    private async _collectSearchablePlugins(
        query: string, options?: SearchOptions,
    ): Promise<SearchResult[][]> {
        const lists: SearchResult[][] = [];
        for (const mod of this._d.registry.all) {
            if (!isSearchable(mod)) continue;
            // Skip plugins that already participate via VectorSearchPlugin
            if (isVectorSearchPlugin(mod)) continue;
            const hits = await mod.search(query, options ? { ...options } : undefined);
            if (hits.length > 0) lists.push(hits);
        }
        return lists;
    }

    /** Collect results from KV collections named in sources. */
    private async _collectKvCollections(
        query: string, sources: Record<string, number>,
    ): Promise<SearchResult[][]> {
        const pluginNames = new Set(this._d.registry.names.map(n => n.split(':')[0]));
        const lists: SearchResult[][] = [];
        for (const [name, k] of Object.entries(sources)) {
            if (pluginNames.has(name)) continue;
            const hits = await this._d.kvService.collection(name).searchAsResults(query, k);
            if (hits.length > 0) lists.push(hits);
        }
        return lists;
    }

    /** Log a search/hybridSearch/searchBM25 call. */
    private _logSearch(
        method: 'search' | 'hybridSearch' | 'searchBM25',
        query: string,
        options: SearchOptions | undefined,
        results: SearchResult[],
        durationMs: number,
    ): void {
        logQuery({
            source: options?.source ?? 'api',
            method,
            query,
            embedding: providerKey(this._d.embedding),
            pruner: null,
            reranker: this._d.config.reranker ? (this._d.config.reranker.constructor?.name ?? 'custom') : null,
            options: {
                sources: options?.sources,
                minScore: options?.minScore,
            },
            results: results.map(_toLogResult),
            durationMs,
        });
    }
}

// ── Helpers ──────────────────────────────────────────

function _toLogResult(r: SearchResult): QueryLogResult {
    const meta = r.metadata as Record<string, unknown> | undefined;
    return {
        filePath: r.filePath ?? 'unknown',
        score: r.score,
        type: r.type,
        name: (meta?.name as string | undefined) ?? undefined,
    };
}

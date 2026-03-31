/**
 * BrainBank — Search API
 *
 * Thin orchestrator for all search operations.
 * Pipeline: collect → fuse (RRF) → rerank.
 *
 * Always created after initialization (even when search services are absent),
 * so BrainBank can unconditionally delegate to it.
 */

import type { SearchStrategy, SearchOptions } from '@/search/types.ts';
import type { ContextBuilder } from '@/search/context-builder.ts';
import type { ResolvedConfig, SearchResult, ContextOptions } from '@/types.ts';
import type { PluginRegistry } from '@/services/plugin-registry.ts';
import type { KVService } from '@/services/kv-service.ts';
import type { SearchAPIDeps } from './types.ts';
import { isSearchable } from '@/plugin.ts';
import { reciprocalRankFusion } from '@/lib/rrf.ts';
import { rerank } from '@/lib/rerank.ts';
import { PLUGIN } from '@/constants.ts';



export class SearchAPI {
    constructor(private _d: SearchAPIDeps) {}

    // ── Context ─────────────────────────────────────

    /** Build formatted context block for LLM injection. */
    async getContext(task: string, options: ContextOptions = {}): Promise<string> {
        if (!this._d.contextBuilder) return '';
        return this._d.contextBuilder.build(task, options);
    }

    // ── Vector ──────────────────────────────────────

    /** Semantic search across all loaded modules. Scope via sources: { code: 10, git: 0 }. */
    async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
        const lists: SearchResult[][] = [];

        if (this._d.search) {
            lists.push(await this._d.search.search(query, options));
        } else if (this._d.registry.has('docs')) {
            lists.push(await this._collectDocs(query, { k: 8 }));
        }

        lists.push(...await this._collectCustomPlugins(query, options));

        if (lists.length === 0) return [];
        if (lists.length === 1) return lists[0];
        return reciprocalRankFusion(lists);
    }

    // ── Hybrid ──────────────────────────────────────

    /** Hybrid search: vector + BM25 → RRF. Scope via sources: { code: 10, git: 5, docs: 3, myNotes: 5 }. */
    async hybridSearch(query: string, options?: SearchOptions): Promise<SearchResult[]> {
        const src = options?.sources ?? {};
        const codeK = src.code ?? 20;
        const gitK = src.git ?? 8;
        const docsK = src.docs ?? 8;

        const lists: SearchResult[][] = [];

        // Core search strategies (code, git, memory via CompositeVectorSearch + KeywordSearch)
        if (this._d.search) {
            const searchOpts: SearchOptions = {
                ...options,
                sources: { ...src, code: codeK, git: gitK },
            };
            const [vec, kw] = await Promise.all([
                this._d.search.search(query, searchOpts),
                Promise.resolve(this._d.bm25?.search(query, searchOpts) ?? []),
            ]);
            lists.push(vec, kw);
        }

        // Docs plugin
        if (this._d.registry.has('docs')) {
            const docs = await this._collectDocs(query, { k: docsK });
            if (docs.length > 0) lists.push(docs);
        }
        lists.push(...await this._collectCustomPlugins(query, options));
        lists.push(...await this._collectKvCollections(query, src));

        if (lists.length === 0) return [];
        const fused = reciprocalRankFusion(lists);
        if (this._d.config.reranker && fused.length > 1) {
            return rerank(query, fused, this._d.config.reranker);
        }
        return fused;
    }

    // ── Keyword ─────────────────────────────────────

    /** BM25 keyword search only. */
    async searchBM25(query: string, options?: SearchOptions): Promise<SearchResult[]> {
        return this._d.bm25?.search(query, options) ?? [];
    }

    rebuildFTS(): void { this._d.bm25?.rebuild?.(); }

    // ── Private: result collection ──────────────────

    /** Search docs via the docs plugin. */
    private async _collectDocs(
        query: string, options?: { collection?: string; k?: number; minScore?: number },
    ): Promise<SearchResult[]> {
        const plugin = this._d.registry.firstByType(PLUGIN.DOCS);
        if (!plugin || !isSearchable(plugin)) return [];
        return plugin.search(query, options);
    }

    /** Search all custom SearchablePlugins (non-builtin). */
    private async _collectCustomPlugins(
        query: string, options?: SearchOptions,
    ): Promise<SearchResult[][]> {
        const builtinTypes = new Set(['code', 'git', 'docs']);
        const lists: SearchResult[][] = [];
        for (const mod of this._d.registry.all) {
            const baseType = mod.name.split(':')[0];
            if (builtinTypes.has(baseType)) continue;
            if (!isSearchable(mod)) continue;
            const hits = await mod.search(query, options ? { ...options } : undefined);
            if (hits.length > 0) lists.push(hits);
        }
        return lists;
    }

    /** Search named KV collections (skips reserved names). */
    private async _collectKvCollections(
        query: string, sources: Record<string, number>,
    ): Promise<SearchResult[][]> {
        const reserved = new Set(['code', 'git', 'docs', 'memory']);
        const lists: SearchResult[][] = [];
        for (const [name, k] of Object.entries(sources)) {
            if (reserved.has(name)) continue;
            const hits = await this._d.kvService.collection(name).searchAsResults(query, k);
            if (hits.length > 0) lists.push(hits);
        }
        return lists;
    }
}

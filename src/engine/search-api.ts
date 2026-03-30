/**
 * BrainBank — Search API
 *
 * Thin orchestrator for all search operations.
 * Pipeline: collect → fuse (RRF) → rerank.
 *
 * Always created after initialization (even when search services are absent),
 * so BrainBank can unconditionally delegate to it.
 */

import type { SearchStrategy } from '@/search/types.ts';
import type { ContextBuilder } from '@/search/context-builder.ts';
import type { ResolvedConfig, SearchResult, ContextOptions } from '@/types.ts';
import type { PluginRegistry } from '@/services/plugin-registry.ts';
import type { KVService } from '@/services/kv-service.ts';
import { isSearchable } from '@/plugin.ts';
import { reciprocalRankFusion } from '@/lib/rrf.ts';
import { rerank } from '@/lib/rerank.ts';
import { PLUGIN } from '@/constants.ts';

export interface SearchAPIDeps {
    search?:          SearchStrategy;
    bm25?:            SearchStrategy;
    registry:         PluginRegistry;
    config:           ResolvedConfig;
    kvService:        KVService;
    contextBuilder?:  ContextBuilder;
}

export class SearchAPI {
    constructor(private _d: SearchAPIDeps) {}

    // ── Context ─────────────────────────────────────

    /** Build formatted context block for LLM injection. */
    async getContext(task: string, options: ContextOptions = {}): Promise<string> {
        if (!this._d.contextBuilder) return '';
        return this._d.contextBuilder.build(task, options);
    }

    // ── Vector ──────────────────────────────────────

    async search(query: string, options?: {
        codeK?: number; gitK?: number; patternK?: number;
        minScore?: number; useMMR?: boolean;
    }): Promise<SearchResult[]> {
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

    /**
     * Convenience shortcut for code-only vector search.
     * Scopes the multi-index search to code only.
     */
    async searchCode(query: string, k = 8): Promise<SearchResult[]> {
        if (!this._d.registry.firstByType('code'))
            throw new Error("BrainBank: Plugin 'code' is not loaded. Install @brainbank/code and add .use(code()).");
        if (!this._d.search)
            throw new Error('BrainBank: VectorSearch not available. Ensure code plugin is loaded.');
        return this._d.search.search(query, { codeK: k, gitK: 0, patternK: 0 });
    }

    /**
     * Convenience shortcut for commit-only vector search.
     * Scopes the multi-index search to git only.
     */
    async searchCommits(query: string, k = 8): Promise<SearchResult[]> {
        if (!this._d.registry.firstByType('git'))
            throw new Error("BrainBank: Plugin 'git' is not loaded. Install @brainbank/git and add .use(git()).");
        if (!this._d.search)
            throw new Error('BrainBank: VectorSearch not available. Ensure git plugin is loaded.');
        return this._d.search.search(query, { codeK: 0, gitK: k, patternK: 0 });
    }

    // ── Hybrid ──────────────────────────────────────

    async hybridSearch(query: string, options?: {
        codeK?: number; gitK?: number; patternK?: number;
        minScore?: number; useMMR?: boolean;
        collections?: Record<string, number>;
    }): Promise<SearchResult[]> {
        const cols  = options?.collections ?? {};
        const codeK = cols.code ?? options?.codeK ?? 20;
        const gitK  = cols.git  ?? options?.gitK  ?? 8;
        const docsK = cols.docs ?? 8;

        const lists: SearchResult[][] = [];

        // Core search strategies
        if (this._d.search) {
            const [vec, kw] = await Promise.all([
                this._d.search.search(query, { ...options, codeK, gitK }),
                Promise.resolve(this._d.bm25?.search(query, { codeK, gitK }) ?? []),
            ]);
            lists.push(vec, kw);
        }

        // Docs plugin
        if (this._d.registry.has('docs')) {
            const docs = await this._collectDocs(query, { k: docsK });
            if (docs.length > 0) lists.push(docs);
        }
        lists.push(...await this._collectCustomPlugins(query, options));
        lists.push(...await this._collectKvCollections(query, cols));

        if (lists.length === 0) return [];
        const fused = reciprocalRankFusion(lists);
        if (this._d.config.reranker && fused.length > 1) {
            return rerank(query, fused, this._d.config.reranker);
        }
        return fused;
    }

    // ── Keyword ─────────────────────────────────────

    async searchBM25(query: string, options?: { codeK?: number; gitK?: number; patternK?: number }): Promise<SearchResult[]> {
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
        query: string, options?: Record<string, unknown>,
    ): Promise<SearchResult[][]> {
        const builtinTypes = new Set(['code', 'git', 'docs']);
        const lists: SearchResult[][] = [];
        for (const mod of this._d.registry.all) {
            const baseType = mod.name.split(':')[0];
            if (builtinTypes.has(baseType)) continue;
            if (!isSearchable(mod)) continue;
            const hits = await mod.search(query, options);
            if (hits.length > 0) lists.push(hits);
        }
        return lists;
    }

    /** Search named KV collections (skips reserved names). */
    private async _collectKvCollections(
        query: string, cols: Record<string, number>,
    ): Promise<SearchResult[][]> {
        const reserved = new Set(['code', 'git', 'docs']);
        const lists: SearchResult[][] = [];
        for (const [name, k] of Object.entries(cols)) {
            if (reserved.has(name)) continue;
            const hits = await this._d.kvService.collection(name).searchAsResults(query, k);
            if (hits.length > 0) lists.push(hits);
        }
        return lists;
    }
}

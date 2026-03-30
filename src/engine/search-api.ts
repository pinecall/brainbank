/**
 * BrainBank — Search API
 *
 * Thin orchestrator for all search operations.
 * Pipeline: collect → fuse (RRF) → rerank.
 *
 * Result gathering is delegated to ResultCollector.
 * Always created after initialization (even when search services are absent),
 * so BrainBank can unconditionally delegate to it.
 */

import type { SearchStrategy } from '@/search/types.ts';
import type { ContextBuilder } from '@/search/context-builder.ts';
import { formatDocuments } from '@/search/context/document-formatter.ts';
import type { Collection } from '@/services/collection.ts';
import type { PluginRegistry } from '@/bootstrap/registry.ts';
import type { SearchablePlugin } from '@/plugin.ts';
import type { ResolvedConfig, SearchResult, ContextOptions } from '@/types.ts';
import { reciprocalRankFusion } from '@/lib/rrf.ts';
import { rerank } from '@/lib/rerank.ts';
import { ResultCollector } from './result-collector.ts';

export interface SearchAPIDeps {
    search?:         SearchStrategy;
    bm25?:           SearchStrategy;
    contextBuilder?: ContextBuilder;
    registry:        PluginRegistry;
    config:          ResolvedConfig;
    getDocsPlugin(): SearchablePlugin | undefined;
    collection(name: string): Collection;
}

export class SearchAPI {
    private _collector: ResultCollector;

    constructor(private _d: SearchAPIDeps) {
        this._collector = new ResultCollector({
            registry:      _d.registry,
            getDocsPlugin: _d.getDocsPlugin,
            collection:    _d.collection,
        });
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
            lists.push(await this._collector.collectDocs(query, { k: 8 }));
        }

        lists.push(...await this._collector.collectCustomPlugins(query, options));

        if (lists.length === 0) return [];
        if (lists.length === 1) return lists[0];
        return reciprocalRankFusion(lists);
    }

    /**
     * Convenience shortcut for code-only vector search.
     * Delegates to VectorSearch.search() with gitK=0, patternK=0 — does not
     * bypass SearchStrategy, simply scopes the multi-index search to code.
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
     * Delegates to VectorSearch.search() with codeK=0, patternK=0 — does not
     * bypass SearchStrategy, simply scopes the multi-index search to git.
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

        // Delegated gathering
        if (this._d.registry.has('docs')) {
            const docs = await this._collector.collectDocs(query, { k: docsK });
            if (docs.length > 0) lists.push(docs);
        }
        lists.push(...await this._collector.collectCustomPlugins(query, options));
        lists.push(...await this._collector.collectKvCollections(query, cols));

        if (lists.length === 0) return [];
        const fused = reciprocalRankFusion(lists);
        return this._rerankResults(query, fused);
    }

    // ── Keyword ─────────────────────────────────────

    async searchBM25(query: string, options?: { codeK?: number; gitK?: number; patternK?: number }): Promise<SearchResult[]> {
        return this._d.bm25?.search(query, options) ?? [];
    }

    rebuildFTS(): void { this._d.bm25?.rebuild?.(); }

    // ── Context ─────────────────────────────────────

    async getContext(task: string, options: ContextOptions = {}): Promise<string> {
        const sections: string[] = [];

        if (this._d.contextBuilder) {
            const core = await this._d.contextBuilder.build(task, options);
            if (core) sections.push(core);
        }

        if (this._d.registry.has('docs')) {
            const docs = await this._collector.collectDocs(task, { k: options.codeResults ?? 4 });
            const docSection = formatDocuments(docs);
            if (docSection) sections.push(docSection);
        }

        return sections.join('\n\n');
    }

    /** Apply reranking if a reranker is configured. */
    private async _rerankResults(query: string, fused: SearchResult[]): Promise<SearchResult[]> {
        if (!this._d.config.reranker || fused.length <= 1) return fused;
        return rerank(query, fused, this._d.config.reranker);
    }
}

/**
 * BrainBank — Search API
 *
 * All search and context operations in one place.
 * Composed from VectorSearch, KeywordSearch, ContextBuilder, and KV collections.
 * Always created after initialization (even when search services are absent),
 * so BrainBank can unconditionally delegate to it.
 */

import type { SearchStrategy } from '@/search/types.ts';
import type { ContextBuilder } from '@/search/context-builder.ts';
import type { Collection } from '@/domain/collection.ts';
import type { IndexerRegistry } from '@/bootstrap/registry.ts';
import type { ResolvedConfig, SearchResult, ContextOptions } from '@/types.ts';
import { reciprocalRankFusion } from '@/lib/rrf.ts';
import { rerank } from '@/search/vector/rerank.ts';

export interface SearchAPIDeps {
    search?:         SearchStrategy;
    bm25?:           SearchStrategy;
    contextBuilder?: ContextBuilder;
    registry:        IndexerRegistry;
    config:          ResolvedConfig;
    searchDocs(query: string, options?: { collection?: string; k?: number; minScore?: number }): Promise<SearchResult[]>;
    collection(name: string): Collection;
}

export class SearchAPI {
    constructor(private _d: SearchAPIDeps) {}

    // ── Vector ──────────────────────────────────────

    async search(query: string, options?: {
        codeK?: number; gitK?: number; patternK?: number;
        minScore?: number; useMMR?: boolean;
    }): Promise<SearchResult[]> {
        if (!this._d.search) {
            return this._d.registry.has('docs')
                ? this._d.searchDocs(query, { k: 8 })
                : [];
        }
        return this._d.search.search(query, options);
    }

    async searchCode(query: string, k = 8): Promise<SearchResult[]> {
        if (!this._d.registry.firstByType('code'))
            throw new Error("BrainBank: Indexer 'code' is not loaded. Add .use(code()) to your BrainBank instance.");
        if (!this._d.search)
            throw new Error('BrainBank: MultiIndexSearch not available. Ensure code indexer is loaded.');
        return this._d.search.search(query, { codeK: k, gitK: 0, patternK: 0 });
    }

    async searchCommits(query: string, k = 8): Promise<SearchResult[]> {
        if (!this._d.registry.firstByType('git'))
            throw new Error("BrainBank: Indexer 'git' is not loaded. Add .use(git()) to your BrainBank instance.");
        if (!this._d.search)
            throw new Error('BrainBank: MultiIndexSearch not available. Ensure git indexer is loaded.');
        return this._d.search.search(query, { codeK: 0, gitK: k, patternK: 0 });
    }

    // ── Hybrid ──────────────────────────────────────

    async hybridSearch(query: string, options?: {
        codeK?: number; gitK?: number; patternK?: number;
        minScore?: number; useMMR?: boolean;
        collections?: Record<string, number>;
    }): Promise<SearchResult[]> {
        const cols  = options?.collections ?? {};
        const codeK = cols.code ?? options?.codeK ?? 6;
        const gitK  = cols.git  ?? options?.gitK  ?? 5;
        const docsK = cols.docs ?? 8;

        const resultLists: SearchResult[][] = [];

        if (this._d.search) {
            const [vec, kw] = await Promise.all([
                this._d.search.search(query, { ...options, codeK, gitK }),
                Promise.resolve(this._d.bm25!.search(query, { codeK, gitK })),
            ]);
            resultLists.push(vec, kw);
        }

        if (this._d.registry.has('docs')) {
            const docs = await this._d.searchDocs(query, { k: docsK });
            if (docs.length > 0) resultLists.push(docs);
        }

        await this._searchKvCollections(query, cols, resultLists);
        if (resultLists.length === 0) return [];

        const fused = reciprocalRankFusion(resultLists);
        return this._rerankResults(query, fused);
    }

    /** Search non-reserved KV collections and push results. */
    private async _searchKvCollections(
        query: string, cols: Record<string, number>, resultLists: SearchResult[][],
    ): Promise<void> {
        const reserved = new Set(['code', 'git', 'docs']);
        for (const [name, k] of Object.entries(cols)) {
            if (reserved.has(name)) continue;
            const hits = await this._d.collection(name).search(query, { k });
            if (hits.length > 0) {
                resultLists.push(hits.map(h => ({
                    type: 'collection' as const,
                    score: h.score ?? 0,
                    content: h.content,
                    metadata: { collection: name, id: h.id, ...h.metadata },
                })));
            }
        }
    }

    /** Apply reranking if a reranker is configured. */
    private async _rerankResults(query: string, fused: SearchResult[]): Promise<SearchResult[]> {
        if (!this._d.config.reranker || fused.length <= 1) return fused;
        return rerank(query, fused, this._d.config.reranker);
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
            const docs = await this._d.searchDocs(task, { k: options.codeResults ?? 4 });
            if (docs.length > 0) {
                const body = docs.map(r => {
                    const m = r.metadata as Record<string, any>;
                    const h = r.context
                        ? `**[${m.collection}]** ${m.title} — _${r.context}_`
                        : `**[${m.collection}]** ${m.title}`;
                    return `${h}\n\n${r.content}`;
                }).join('\n\n---\n\n');
                sections.push(`## Relevant Documents\n\n${body}`);
            }
        }

        return sections.join('\n\n');
    }
}

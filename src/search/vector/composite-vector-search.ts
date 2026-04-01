/**
 * BrainBank — Composite Vector Search
 *
 * Generic orchestrator for domain-specific vector searches.
 * Embeds the query once, delegates to registered DomainVectorSearch strategies.
 * Plugin-agnostic — strategies are discovered at wiring time.
 */

import type { EmbeddingProvider, SearchResult } from '@/types.ts';
import type { SearchStrategy, SearchOptions, DomainVectorSearch } from '@/search/types.ts';

export interface CompositeVectorConfig {
    strategies: Map<string, DomainVectorSearch>;
    embedding: EmbeddingProvider;
    /** Default K values per strategy name. Strategies not listed default to 0. */
    defaults?: Record<string, number>;
}

export class CompositeVectorSearch implements SearchStrategy {
    constructor(private _c: CompositeVectorConfig) {}

    /** Search across all registered domain strategies. */
    async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
        const src = options.sources ?? {};
        const { minScore = 0.25, useMMR = true, mmrLambda = 0.7 } = options;

        const queryVec = await this._c.embedding.embed(query);
        const results: SearchResult[] = [];

        for (const [name, strategy] of this._c.strategies) {
            const k = src[name] ?? this._c.defaults?.[name] ?? 0;
            if (k <= 0) continue;
            results.push(...strategy.search(queryVec, k, minScore, useMMR, mmrLambda));
        }

        results.sort((a, b) => b.score - a.score);
        return results;
    }
}

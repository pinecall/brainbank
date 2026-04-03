/**
 * BrainBank — Composite Vector Search
 *
 * Generic orchestrator for domain-specific vector searches.
 * Embeds the query once, delegates to registered DomainVectorSearch strategies.
 * Uses round-robin interleaving when multiple strategies exist to ensure
 * balanced representation across repos/domains.
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
    /** Default K when no source override is provided. */
    private static readonly DEFAULT_K = 6;

    constructor(private _c: CompositeVectorConfig) {}

    /** Search across all registered domain strategies with round-robin diversity. */
    async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
        const src = options.sources ?? {};
        const { minScore = 0.25, useMMR = true, mmrLambda = 0.7 } = options;

        const queryVec = await this._c.embedding.embed(query);

        // Collect per-strategy results
        const strategyResults: SearchResult[][] = [];
        let totalK = 0;

        for (const [name, strategy] of this._c.strategies) {
            // Support both full name (code:backend) and base type (code) lookups
            const baseName = name.split(':')[0];
            const k = src[name] ?? src[baseName] ?? this._c.defaults?.[name] ?? CompositeVectorSearch.DEFAULT_K;
            if (k <= 0) continue;
            totalK = Math.max(totalK, k);
            const hits = strategy.search(queryVec, k, minScore, useMMR, mmrLambda, query);
            if (hits.length > 0) strategyResults.push(hits);
        }

        // Single strategy: return sorted as-is
        if (strategyResults.length <= 1) {
            const results = strategyResults[0] ?? [];
            results.sort((a, b) => b.score - a.score);
            return results;
        }

        // Multiple strategies: round-robin interleave for cross-repo diversity
        return _interleave(strategyResults, totalK);
    }
}

/**
 * Round-robin interleave results from multiple strategies.
 * Takes one result from each strategy in turn, preserving per-strategy rank order.
 * This ensures each repo/domain gets balanced representation.
 */
function _interleave(lists: SearchResult[][], maxResults: number): SearchResult[] {
    // Sort each list by score descending
    for (const list of lists) list.sort((a, b) => b.score - a.score);

    const result: SearchResult[] = [];
    const indices = new Array(lists.length).fill(0) as number[];
    let exhausted = 0;

    while (result.length < maxResults && exhausted < lists.length) {
        exhausted = 0;
        for (let i = 0; i < lists.length; i++) {
            if (indices[i] >= lists[i].length) { exhausted++; continue; }
            result.push(lists[i][indices[i]]);
            indices[i]++;
            if (result.length >= maxResults) break;
        }
    }

    return result;
}

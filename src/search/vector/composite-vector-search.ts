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

    /** Search across all registered domain strategies with score-based merge. */
    async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
        const src = options.sources ?? {};
        const { minScore = 0.25, useMMR = true, mmrLambda = 0.7 } = options;

        const queryVec = await this._c.embedding.embed(query);

        // Each strategy gets full K for ranking quality, cap total after merge
        const allResults: SearchResult[] = [];
        let requestedK = 0;

        for (const [name, strategy] of this._c.strategies) {
            const baseName = name.split(':')[0];
            const k = src[name] ?? src[baseName] ?? this._c.defaults?.[name] ?? CompositeVectorSearch.DEFAULT_K;
            if (k <= 0) continue;
            requestedK = Math.max(requestedK, k);
            const hits = strategy.search(queryVec, k, minScore, useMMR, mmrLambda, query);

            // Multi-repo: prefix filePaths with sub-repo name so path filtering works
            // e.g. strategy 'code:servicehub-backend' → filePath 'servicehub-backend/src/app.ts'
            const colonIdx = name.indexOf(':');
            if (colonIdx > 0) {
                const subRepo = name.slice(colonIdx + 1);
                for (const hit of hits) {
                    if (hit.filePath) hit.filePath = `${subRepo}/${hit.filePath}`;
                    const meta = hit.metadata as Record<string, unknown>;
                    if (typeof meta.filePath === 'string') {
                        meta.filePath = `${subRepo}/${meta.filePath}`;
                    }
                }
            }

            allResults.push(...hits);
        }

        if (allResults.length === 0) return [];

        // Sort by raw rrfScore (comparable across repos), cap to requested K
        allResults.sort((a, b) => b.score - a.score);
        const capped = allResults.slice(0, requestedK);

        // Normalize scores 0-1 globally
        const maxScore = capped[0].score;
        if (maxScore > 0) {
            for (const r of capped) r.score = r.score / maxScore;
        }

        return capped;
    }
}

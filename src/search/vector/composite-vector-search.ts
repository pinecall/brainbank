/**
 * BrainBank — Composite Vector Search
 *
 * Composes CodeVectorSearch + GitVectorSearch + PatternVectorSearch.
 * Implements SearchStrategy — drop-in replacement for the monolithic VectorSearch.
 * Embeds the query once, delegates to per-domain strategies, merges + reranks.
 */

import type { EmbeddingProvider, Reranker, SearchResult } from '@/types.ts';
import type { SearchStrategy, SearchOptions } from '@/search/types.ts';
import type { CodeVectorSearch } from './code-vector-search.ts';
import type { GitVectorSearch } from './git-vector-search.ts';
import type { PatternVectorSearch } from './pattern-vector-search.ts';
import { rerank } from '@/lib/rerank.ts';

export interface CompositeVectorConfig {
    code?: CodeVectorSearch;
    git?: GitVectorSearch;
    patterns?: PatternVectorSearch;
    embedding: EmbeddingProvider;
    reranker?: Reranker;
}

export class CompositeVectorSearch implements SearchStrategy {
    constructor(private _c: CompositeVectorConfig) {}

    /** Search across all registered domains. */
    async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
        const {
            codeK = 6, gitK = 5, patternK = 4,
            minScore = 0.25, useMMR = true, mmrLambda = 0.7,
        } = options;

        const queryVec = await this._c.embedding.embed(query);
        const results: SearchResult[] = [];

        if (this._c.code && codeK > 0) {
            results.push(...this._c.code.search(queryVec, codeK, minScore, useMMR, mmrLambda));
        }
        if (this._c.git && gitK > 0) {
            results.push(...this._c.git.search(queryVec, gitK, minScore));
        }
        if (this._c.patterns && patternK > 0) {
            results.push(...this._c.patterns.search(queryVec, patternK, minScore, useMMR, mmrLambda));
        }

        results.sort((a, b) => b.score - a.score);

        if (this._c.reranker && results.length > 1) {
            return rerank(query, results, this._c.reranker);
        }
        return results;
    }
}

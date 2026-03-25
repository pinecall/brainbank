/**
 * BrainBank — Rerank
 * 
 * Position-aware score blending between retrieval and reranker.
 * Pure function — no state.
 * 
 * Top 1-3:  75% retrieval / 25% reranker (preserves exact matches)
 * Top 4-10: 60% retrieval / 40% reranker
 * Top 11+:  40% retrieval / 60% reranker (trust reranker more)
 */

import type { Reranker, SearchResult } from '../../types.ts';

/** Re-rank results using position-aware blending. */
export async function rerank(
    query: string,
    results: SearchResult[],
    reranker: Reranker,
): Promise<SearchResult[]> {
    const documents = results.map(r => r.content);
    const scores = await reranker.rank(query, documents);

    const blended = results.map((r, i) => {
        const pos = i + 1;
        const rrfWeight = pos <= 3 ? 0.75 : pos <= 10 ? 0.60 : 0.40;
        return {
            ...r,
            score: rrfWeight * r.score + (1 - rrfWeight) * (scores[i] ?? 0),
        };
    });

    return blended.sort((a, b) => b.score - a.score);
}

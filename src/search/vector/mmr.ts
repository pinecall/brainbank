/**
 * BrainBank — Maximum Marginal Relevance (MMR)
 * 
 * Diversifies vector search results to avoid returning redundant items.
 * λ=1.0 → pure relevance, λ=0.0 → pure diversity.
 * Default λ=0.7 balances both.
 */

import type { VectorIndex, SearchHit } from '@/types.ts';
import { cosineSimilarity } from '@/lib/math.ts';

/**
 * Search with Maximum Marginal Relevance for diversified results.
 * 
 * Algorithm:
 *   1. Get 3x candidates from HNSW
 *   2. Greedily select items that maximize: λ * relevance - (1-λ) * max_sim_to_selected
 */
export function searchMMR(
    index: VectorIndex,
    query: Float32Array,
    vectorCache: Map<number, Float32Array>,
    k: number,
    lambda: number = 0.7,
): SearchHit[] {
    // Get more candidates than needed
    const candidates = index.search(query, k * 3);
    if (candidates.length <= k) return candidates;

    const selected: SearchHit[] = [];
    const remaining = [...candidates];

    while (selected.length < k && remaining.length > 0) {
        let bestScore = -Infinity;
        let bestIdx = 0;

        for (let i = 0; i < remaining.length; i++) {
            const relevance = remaining[i].score;

            // Max similarity to any already-selected item
            let maxSim = 0;
            for (const sel of selected) {
                const candidateVec = vectorCache.get(remaining[i].id);
                const selectedVec = vectorCache.get(sel.id);
                if (candidateVec && selectedVec) {
                    maxSim = Math.max(maxSim, cosineSimilarity(candidateVec, selectedVec));
                }
            }

            // MMR score: balance relevance vs diversity
            const mmrScore = lambda * relevance - (1 - lambda) * maxSim;

            if (mmrScore > bestScore) {
                bestScore = mmrScore;
                bestIdx = i;
            }
        }

        selected.push(remaining[bestIdx]);
        remaining.splice(bestIdx, 1);
    }

    return selected;
}

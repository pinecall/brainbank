/**
 * BrainBank — Reciprocal Rank Fusion (RRF)
 * 
 * Combines results from multiple search systems (vector + BM25)
 * using the RRF algorithm: score = Σ 1/(k + rank_i)
 * 
 * This is the same algorithm used by Elasticsearch, QMD, and most
 * production hybrid search systems. Simple but very effective.
 * 
 * Reference: Cormack et al., "Reciprocal Rank Fusion outperforms
 * Condorcet and individual Rank Learning Methods" (2009)
 */

import type { SearchResult } from '../types.ts';

/**
 * Fuse ranked lists from different search systems into a single ranked list.
 * 
 * @param resultSets - Arrays of SearchResult from different systems (e.g. vector, BM25)
 * @param k - Smoothing constant. Default: 60 (standard value). Higher = less emphasis on top ranks.
 * @param maxResults - Maximum results to return.
 */
export function reciprocalRankFusion(
    resultSets: SearchResult[][],
    k: number = 60,
    maxResults: number = 15,
): SearchResult[] {
    // Build a map: unique key → { bestResult, rrfScore }
    const fused = new Map<string, { result: SearchResult; rrfScore: number }>();

    for (const results of resultSets) {
        for (let rank = 0; rank < results.length; rank++) {
            const r = results[rank];
            const key = resultKey(r);
            const rrfContribution = 1.0 / (k + rank + 1);

            const existing = fused.get(key);
            if (existing) {
                existing.rrfScore += rrfContribution;
                // Keep the result with the higher original score
                if (r.score > existing.result.score) {
                    existing.result = { ...r };
                }
            } else {
                fused.set(key, {
                    result: { ...r },
                    rrfScore: rrfContribution,
                });
            }
        }
    }

    // Sort by RRF score descending, normalize, and return
    const sorted = Array.from(fused.values())
        .sort((a, b) => b.rrfScore - a.rrfScore)
        .slice(0, maxResults);

    // Normalize RRF scores to 0..1 range
    const maxRRF = sorted[0]?.rrfScore ?? 1;
    return sorted.map(entry => ({
        ...entry.result,
        score: entry.rrfScore / maxRRF,
        metadata: {
            ...entry.result.metadata,
            rrfScore: entry.rrfScore,
        } as any,
    }));
}

/**
 * Generate a unique key for a search result to detect duplicates across systems.
 */
function resultKey(r: SearchResult): string {
    switch (r.type) {
        case 'code':
            return `code:${r.filePath}:${r.metadata.startLine}-${r.metadata.endLine}`;
        case 'commit':
            return `commit:${r.metadata.hash || r.metadata.shortHash}`;
        case 'pattern':
            return `pattern:${r.metadata.taskType}:${r.content?.slice(0, 60)}`;
        case 'document':
            return `document:${r.filePath ?? ''}:${(r.metadata as any).seq ?? r.content?.slice(0, 80)}`;
        case 'collection':
            return `collection:${(r.metadata as any).id ?? r.content?.slice(0, 80)}`;
    }
}

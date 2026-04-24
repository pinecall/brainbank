/**
 * BrainBank — BM25 Intersection Boost
 *
 * Pure functions for post-processing vector search results with BM25 keyword overlap.
 * Extracted from ContextBuilder for single-responsibility and testability.
 */

import type { SearchResult } from '@/types.ts';
import type { SearchStrategy } from './types.ts';

/** BM25 boost factor applied to vector results that also match keywords. */
export const BM25_BOOST = 0.15;

/**
 * Boost vector results that also appear in BM25 keyword results.
 * Does NOT add new results — only re-scores and re-sorts existing vector hits.
 * This promotes keyword-relevant files without introducing BM25-only noise.
 */
export async function boostWithBM25(
    vectorResults: SearchResult[],
    bm25: SearchStrategy,
    query: string,
    sources: Record<string, number>,
): Promise<SearchResult[]> {
    if (vectorResults.length === 0) return vectorResults;

    const bm25Results = await bm25.search(query, { sources });
    if (bm25Results.length === 0) return vectorResults;

    // Build a set of BM25 hit keys for fast lookup
    const bm25Keys = new Set<string>();
    for (const r of bm25Results) {
        bm25Keys.add(resultKey(r));
    }

    // Boost scores of vector results that also appear in BM25
    const boosted = vectorResults.map(r => {
        const k = resultKey(r);
        if (bm25Keys.has(k)) {
            return { ...r, score: r.score + BM25_BOOST };
        }
        return r;
    });

    // Re-sort by boosted score
    boosted.sort((a, b) => b.score - a.score);
    return boosted;
}

/** Filter results whose filePath starts with any of the given prefixes. */
export function filterByPath(results: SearchResult[], prefix: string | string[] | undefined): SearchResult[] {
    if (!prefix) return results;
    const prefixes = Array.isArray(prefix) ? prefix : [prefix];
    if (prefixes.length === 0) return results;
    return results.filter(r => prefixes.some(p => r.filePath?.startsWith(p)));
}

/** Exclude results whose filePath starts with any of the given prefixes. */
export function filterByIgnore(results: SearchResult[], ignorePaths: string[] | undefined): SearchResult[] {
    if (!ignorePaths || ignorePaths.length === 0) return results;
    return results.filter(r => !r.filePath || !ignorePaths.some(p => r.filePath!.startsWith(p)));
}

/** Generate a dedup key for a search result (file:startLine:endLine). */
export function resultKey(r: SearchResult): string {
    const sl = 'startLine' in r.metadata ? r.metadata.startLine : '';
    const el = 'endLine' in r.metadata ? r.metadata.endLine : '';
    return `${r.filePath ?? ''}:${sl}:${el}`;
}

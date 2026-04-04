/**
 * BrainBank — Prune Utility
 *
 * Bridges SearchResult[] → Pruner.prune() → filtered SearchResult[].
 * Converts results to lightweight PrunerItems with trimmed previews,
 * calls the pruner, and filters out dropped results.
 */

import type { Pruner, PrunerItem, SearchResult } from '@/types.ts';

const DEFAULT_MAX_PREVIEW_LINES = 50;

/** Run the pruner on search results. Returns only results the pruner kept. */
export async function pruneResults(
    query: string,
    results: SearchResult[],
    pruner: Pruner,
    maxPreviewLines: number = DEFAULT_MAX_PREVIEW_LINES,
): Promise<SearchResult[]> {
    if (results.length <= 1) return results;

    // Map results to lightweight items for the pruner
    const items: PrunerItem[] = results.map((r, i) => ({
        id: i,
        filePath: r.filePath ?? 'unknown',
        preview: r.content.split('\n').slice(0, maxPreviewLines).join('\n'),
        metadata: r.metadata as Record<string, unknown>,
    }));

    const keepIds = await pruner.prune(query, items);
    const keepSet = new Set(keepIds);

    return results.filter((_, i) => keepSet.has(i));
}

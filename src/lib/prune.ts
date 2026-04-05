/**
 * BrainBank — Prune Utility
 *
 * Bridges SearchResult[] → Pruner.prune() → filtered SearchResult[].
 * Converts results to lightweight PrunerItems with full content previews,
 * calls the pruner, and filters out dropped results.
 *
 * Content strategy: send the FULL chunk content to the pruner so it can
 * make informed decisions. A per-item character cap prevents cost blowups
 * on monster files — when truncated, the middle is kept (imports + core
 * logic) rather than just the top.
 */

import type { Pruner, PrunerItem, SearchResult } from '@/types.ts';

/**
 * Max characters per item sent to the pruner.
 * ~8K chars ≈ 200-250 lines — enough for the model to understand
 * the file's purpose without blowing up token budgets.
 */
const MAX_PREVIEW_CHARS = 8_000;

/** Run the pruner on search results. Returns only results the pruner kept. */
export async function pruneResults(
    query: string,
    results: SearchResult[],
    pruner: Pruner,
): Promise<SearchResult[]> {
    if (results.length <= 1) return results;

    // Map results to items with full content (capped per item)
    const items: PrunerItem[] = results.map((r, i) => ({
        id: i,
        filePath: r.filePath ?? 'unknown',
        preview: _buildPreview(r.content),
        metadata: r.metadata as Record<string, unknown>,
    }));

    const keepIds = await pruner.prune(query, items);
    const keepSet = new Set(keepIds);

    return results.filter((_, i) => keepSet.has(i));
}

/**
 * Build a preview from full content.
 *
 * If the content fits within MAX_PREVIEW_CHARS, return it as-is.
 * For oversized content, keep the first half + last quarter with a
 * "[... N lines omitted ...]" marker — this preserves imports/types
 * at the top AND exports/key functions that often live at the bottom.
 */
function _buildPreview(content: string): string {
    if (content.length <= MAX_PREVIEW_CHARS) return content;

    const lines = content.split('\n');
    const totalLines = lines.length;

    // Keep ~60% from top, ~25% from bottom
    const topCount = Math.floor(totalLines * 0.6);
    const bottomCount = Math.floor(totalLines * 0.25);
    const omitted = totalLines - topCount - bottomCount;

    const topPart = lines.slice(0, topCount).join('\n');
    const bottomPart = lines.slice(totalLines - bottomCount).join('\n');

    return `${topPart}\n\n// [... ${omitted} lines omitted ...]\n\n${bottomPart}`;
}

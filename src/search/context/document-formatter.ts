/**
 * BrainBank — Document Formatter
 *
 * Formats document search results as markdown sections.
 * Extracted from SearchAPI.getContext() to centralize formatting
 * alongside code-formatter.ts and graph-formatter.ts.
 */

import type { SearchResult } from '@/types.ts';

/** Format document search results into a markdown section. Returns empty string if no results. */
export function formatDocuments(docs: SearchResult[]): string {
    if (docs.length === 0) return '';

    const body = docs.map(r => {
        const m = r.metadata as Record<string, any>;
        const h = r.context
            ? `**[${m.collection}]** ${m.title} — _${r.context}_`
            : `**[${m.collection}]** ${m.title}`;
        return `${h}\n\n${r.content}`;
    }).join('\n\n---\n\n');

    return `## Relevant Documents\n\n${body}`;
}

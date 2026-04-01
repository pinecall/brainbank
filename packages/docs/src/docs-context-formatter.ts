/**
 * @brainbank/docs — Docs Context Formatter
 *
 * Formats document search results into a markdown section.
 * Moved from core — domain-specific formatting for docs results.
 */

import type { SearchResult } from 'brainbank';
import { isDocumentResult } from 'brainbank';

/** Format document search results into a markdown section. Returns empty string if no results. */
export function formatDocuments(docs: SearchResult[]): string {
    if (docs.length === 0) return '';

    const body = docs.map(r => {
        if (!isDocumentResult(r)) return r.content;
        const m = r.metadata;
        const h = r.context
            ? `**[${m.collection}]** ${m.title} — _${r.context}_`
            : `**[${m.collection}]** ${m.title}`;
        return `${h}\n\n${r.content}`;
    }).join('\n\n---\n\n');

    return `## Relevant Documents\n\n${body}`;
}

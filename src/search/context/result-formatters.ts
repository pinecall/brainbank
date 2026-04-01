/**
 * BrainBank — Git Formatters
 *
 * Formats git commit results and co-edit suggestions.
 */

import type { SearchResult, CoEditSuggestion } from '@/types.ts';

import { isDocumentResult } from '@/types.ts';

/** Duck-typed interface for co-edit suggestions (provided by @brainbank/git). */
export interface CoEditProvider {
    suggest(filePath: string, limit: number): CoEditSuggestion[];
}

/** Format git commit results with diff snippets. */
export function formatGitResults(results: SearchResult[], limit: number, parts: string[]): void {
    const gitHits = results.filter(r => r.type === 'commit').slice(0, limit);
    if (gitHits.length === 0) return;

    parts.push('## Related Git History\n');
    for (const c of gitHits) {
        const m = c.metadata;
        const score = Math.round(c.score * 100);
        const files = (m.files ?? []).slice(0, 4).join(', ');
        parts.push(`**[${m.shortHash}]** ${c.content} *(${m.author}, ${m.date?.slice(0, 10)}, ${score}%)*`);
        if (files) parts.push(`  Files: ${files}`);
        if (m.diff) {
            const snippet = m.diff
                .split('\n')
                .filter((l: string) => l.startsWith('+') || l.startsWith('-') || l.startsWith('@@'))
                .slice(0, 10)
                .join('\n');
            if (snippet) {
                parts.push('```diff');
                parts.push(snippet);
                parts.push('```');
            }
        }
        parts.push('');
    }
}

/** Format co-edit suggestions for affected files. */
export function formatCoEdits(affectedFiles: string[], parts: string[], coEdits?: CoEditProvider): void {
    if (affectedFiles.length === 0 || !coEdits) return;

    const coEditLines: string[] = [];
    for (const file of affectedFiles.slice(0, 3)) {
        const suggestions = coEdits.suggest(file, 4);
        if (suggestions.length > 0) {
            coEditLines.push(
                `- **${file}** → also tends to change: ${suggestions.map(s => `${s.file} (${s.count}x)`).join(', ')}`
            );
        }
    }
    if (coEditLines.length > 0) {
        parts.push('## Co-Edit Patterns\n');
        parts.push(...coEditLines);
        parts.push('');
    }
}




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

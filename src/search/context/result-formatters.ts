/**
 * BrainBank — Git & Pattern Formatters
 *
 * Formats git commit results, co-edit suggestions, and memory patterns.
 */

import type { SearchResult, CoEditSuggestion } from '@/types.ts';

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

/** Format memory pattern results. */
export function formatPatternResults(results: SearchResult[], limit: number, parts: string[]): void {
    const memHits = results.filter(r => r.type === 'pattern').slice(0, limit);
    if (memHits.length === 0) return;

    parts.push('## Learned Patterns\n');
    for (const p of memHits) {
        const m = p.metadata;
        const score = Math.round(p.score * 100);
        const success = Math.round((m.successRate ?? 0) * 100);
        parts.push(`**${m.taskType}** — ${success}% success, ${score}% match`);
        parts.push(`Task: ${m.task}`);
        parts.push(`Approach: ${p.content}`);
        if (m.critique) parts.push(`Lesson: ${m.critique}`);
        parts.push('');
    }
}

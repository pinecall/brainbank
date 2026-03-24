/**
 * BrainBank — Context Builder
 * 
 * Builds a formatted markdown context block from search results.
 * Ready for injection into an LLM system prompt.
 * Groups code by file, includes git history and learned patterns.
 */

import type { SearchResult, CoEditSuggestion, ContextOptions } from '../types.ts';
import type { MultiIndexSearch } from '../search/engine.ts';
import type { CoEditAnalyzer } from '../indexers/git/co-edits.ts';

export class ContextBuilder {
    constructor(
        private _search: MultiIndexSearch,
        private _coEdits?: CoEditAnalyzer,
    ) {}

    /**
     * Build a full context block for a task.
     * Returns clean markdown ready for system prompt injection.
     */
    async build(task: string, options: ContextOptions = {}): Promise<string> {
        const {
            codeResults = 6,
            gitResults = 5,
            patternResults = 4,
            affectedFiles = [],
            minScore = 0.25,
            useMMR = true,
            mmrLambda = 0.7,
        } = options;

        // Run unified search
        const results = await this._search.search(task, {
            codeK: codeResults,
            gitK: gitResults,
            patternK: patternResults,
            minScore,
            useMMR,
            mmrLambda,
        });

        const parts: string[] = [`# Context for: "${task}"\n`];

        // ── Code Results ────────────────────────────
        const codeHits = results.filter(r => r.type === 'code').slice(0, codeResults);
        if (codeHits.length > 0) {
            parts.push('## Relevant Code\n');

            // Group by file
            const byFile = new Map<string, typeof codeHits>();
            for (const r of codeHits) {
                const key = r.filePath ?? 'unknown';
                if (!byFile.has(key)) byFile.set(key, []);
                byFile.get(key)!.push(r);
            }

            for (const [file, chunks] of byFile) {
                parts.push(`### ${file}`);
                for (const c of chunks) {
                    const m = c.metadata;
                    const label = m.name
                        ? `${m.chunkType} \`${m.name}\` (L${m.startLine}-${m.endLine})`
                        : `L${m.startLine}-${m.endLine}`;
                    parts.push(`**${label}** — ${Math.round(c.score * 100)}% match`);
                    parts.push('```' + (m.language || ''));
                    parts.push(c.content);
                    parts.push('```\n');
                }
            }
        }

        // ── Git Results ─────────────────────────────
        const gitHits = results.filter(r => r.type === 'commit').slice(0, gitResults);
        if (gitHits.length > 0) {
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

        // ── Co-Edits ────────────────────────────────
        if (affectedFiles.length > 0 && this._coEdits) {
            const coEditLines: string[] = [];
            for (const file of affectedFiles.slice(0, 3)) {
                const suggestions = this._coEdits.suggest(file, 4);
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

        // ── Memory Results ──────────────────────────
        const memHits = results.filter(r => r.type === 'pattern').slice(0, patternResults);
        if (memHits.length > 0) {
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

        return parts.join('\n');
    }
}

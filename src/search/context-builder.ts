/**
 * BrainBank — Context Builder
 * 
 * Builds a formatted markdown context block from search results.
 * Ready for injection into an LLM system prompt.
 * Groups code by file, includes git history, call graph, and learned patterns.
 */

import type { SearchResult, ContextOptions } from '@/types.ts';
import type { SearchStrategy } from '@/search/types.ts';
import type { CoEditAnalyzer } from '@/indexers/git/co-edit-analyzer.ts';
import type { Database } from '@/db/database.ts';

export class ContextBuilder {
    constructor(
        private _search: SearchStrategy,
        private _coEdits?: CoEditAnalyzer,
        private _db?: Database,
    ) {}

    /** Build a full context block for a task. Returns markdown for system prompt. */
    async build(task: string, options: ContextOptions = {}): Promise<string> {
        const {
            codeResults = 6, gitResults = 5, patternResults = 4,
            affectedFiles = [], minScore = 0.25,
            useMMR = true, mmrLambda = 0.7,
        } = options;

        const results = await this._search.search(task, {
            codeK: codeResults, gitK: gitResults, patternK: patternResults,
            minScore, useMMR, mmrLambda,
        });

        const parts: string[] = [`# Context for: "${task}"\n`];

        const codeHits = results.filter(r => r.type === 'code').slice(0, codeResults);
        this._formatCodeResults(codeHits, parts);
        this._formatCodeGraph(codeHits, parts);
        this._formatGitResults(results, gitResults, parts);
        this._formatCoEdits(affectedFiles, parts);
        this._formatPatternResults(results, patternResults, parts);

        return parts.join('\n');
    }

    /** Format code search results grouped by file. */
    private _formatCodeResults(codeHits: SearchResult[], parts: string[]): void {
        if (codeHits.length === 0) return;

        parts.push('## Relevant Code\n');

        const byFile = new Map<string, typeof codeHits>();
        for (const r of codeHits) {
            const key = r.filePath ?? 'unknown';
            if (!byFile.has(key)) byFile.set(key, []);
            byFile.get(key)!.push(r);
        }

        for (const [file, chunks] of byFile) {
            parts.push(`### ${file}`);
            for (const c of chunks) {
                const m = c.metadata as Record<string, any>;
                const label = m.name
                    ? `${m.chunkType} \`${m.name}\` (L${m.startLine}-${m.endLine})`
                    : `L${m.startLine}-${m.endLine}`;

                // Add call graph annotations
                const callInfo = this._getCallInfo(c);
                const annotation = callInfo ? ` ${callInfo}` : '';

                parts.push(`**${label}** — ${Math.round(c.score * 100)}% match${annotation}`);
                parts.push('```' + (m.language || ''));
                parts.push(c.content);
                parts.push('```\n');
            }
        }
    }

    /** Format code graph: imports and related files. */
    private _formatCodeGraph(codeHits: SearchResult[], parts: string[]): void {
        if (!this._db || codeHits.length === 0) return;

        const files = new Set(codeHits.map(r => r.filePath).filter(Boolean) as string[]);
        const relatedFiles = new Set<string>();

        try {
            for (const file of files) {
                // Files this file imports
                const imports = this._db.prepare(
                    'SELECT imports_path FROM code_imports WHERE file_path = ?'
                ).all(file) as { imports_path: string }[];
                for (const row of imports) relatedFiles.add(`→ ${row.imports_path}`);

                // Files that import this file (reverse lookup by basename)
                const basename = file.split('/').pop()?.replace(/\.\w+$/, '') ?? '';
                if (basename) {
                    const importers = this._db.prepare(
                        'SELECT DISTINCT file_path FROM code_imports WHERE imports_path LIKE ?'
                    ).all(`%${basename}%`) as { file_path: string }[];
                    for (const row of importers) {
                        if (!files.has(row.file_path)) relatedFiles.add(`← ${row.file_path}`);
                    }
                }
            }
        } catch {
            return; // Table might not exist yet
        }

        if (relatedFiles.size === 0) return;
        parts.push('## Related Files (Import Graph)\n');
        for (const f of [...relatedFiles].slice(0, 15)) {
            parts.push(`- ${f}`);
        }
        parts.push('');
    }

    /** Get call graph info for a single search result. */
    private _getCallInfo(result: SearchResult): string | null {
        if (!this._db) return null;
        const chunkId = (result.metadata as Record<string, any>)?.id;
        if (!chunkId) return null;

        try {
            // What this chunk calls
            const calls = this._db.prepare(
                'SELECT DISTINCT symbol_name FROM code_refs WHERE chunk_id = ? LIMIT 5'
            ).all(chunkId) as { symbol_name: string }[];

            // What calls this chunk's main symbol
            const name = (result.metadata as Record<string, any>)?.name;
            const callers = name ? this._db.prepare(
                `SELECT DISTINCT cc.file_path, cc.name FROM code_refs cr
                 JOIN code_chunks cc ON cc.id = cr.chunk_id
                 WHERE cr.symbol_name = ? LIMIT 5`
            ).all(name) as { file_path: string; name: string }[] : [];

            const parts: string[] = [];
            if (calls.length > 0) parts.push(`calls: ${calls.map(c => c.symbol_name).join(', ')}`);
            if (callers.length > 0) parts.push(`called by: ${callers.map(c => c.name || c.file_path).join(', ')}`);

            return parts.length > 0 ? `*(${parts.join(' | ')})*` : null;
        } catch {
            return null;
        }
    }

    /** Format git commit results with diff snippets. */
    private _formatGitResults(results: SearchResult[], limit: number, parts: string[]): void {
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
    private _formatCoEdits(affectedFiles: string[], parts: string[]): void {
        if (affectedFiles.length === 0 || !this._coEdits) return;

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

    /** Format memory pattern results. */
    private _formatPatternResults(results: SearchResult[], limit: number, parts: string[]): void {
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
}

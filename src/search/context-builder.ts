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

    /** Expand results via import graph and format related files with code. */
    private _formatCodeGraph(codeHits: SearchResult[], parts: string[]): void {
        if (!this._db || codeHits.length === 0) return;

        const hitFiles = new Set(codeHits.map(r => r.filePath).filter(Boolean) as string[]);
        const graphFiles = this._expandViaImportGraph(hitFiles);

        if (graphFiles.size === 0) return;

        // Prioritize files from same directories as search hits
        const hitDirs = new Set([...hitFiles].map(f => f.split('/').slice(0, -1).join('/')));
        const sorted = [...graphFiles].sort((a, b) => {
            const aDir = a.split('/').slice(0, -1).join('/');
            const bDir = b.split('/').slice(0, -1).join('/');
            const aLocal = hitDirs.has(aDir) ? 0 : 1;
            const bLocal = hitDirs.has(bDir) ? 0 : 1;
            return aLocal - bLocal;
        });

        // Fetch best chunk per related file (largest chunk = most informative)
        const expanded = this._fetchBestChunks(sorted);
        if (expanded.length === 0) return;

        parts.push('## Related Code (Import Graph)\n');
        const byFile = new Map<string, typeof expanded>();
        for (const r of expanded) {
            if (!byFile.has(r.filePath)) byFile.set(r.filePath, []);
            byFile.get(r.filePath)!.push(r);
        }

        for (const [file, chunks] of byFile) {
            parts.push(`### ${file}`);
            for (const c of chunks) {
                const label = c.name
                    ? `${c.chunkType} \`${c.name}\` (L${c.startLine}-${c.endLine})`
                    : `L${c.startLine}-${c.endLine}`;
                parts.push(`**${label}**`);
                parts.push('```' + (c.language || ''));
                parts.push(c.content);
                parts.push('```\n');
            }
        }
    }

    /** Traverse import graph 1-2 hops from seed files, return new file paths. */
    private _expandViaImportGraph(seedFiles: Set<string>): Set<string> {
        if (!this._db) return new Set();

        const discovered = new Set<string>();
        const frontier = new Set(seedFiles);

        // 2-hop traversal
        for (let hop = 0; hop < 2; hop++) {
            const nextFrontier = new Set<string>();

            for (const file of frontier) {
                try {
                    // Forward: files imported BY this file — resolve basenames to real paths
                    const imports = this._db.prepare(
                        'SELECT imports_path FROM code_imports WHERE file_path = ?'
                    ).all(file) as { imports_path: string }[];

                    const fileDir = file.split('/').slice(0, -1).join('/');
                    for (const row of imports) {
                        // Skip external packages (no slash = npm package)
                        if (!row.imports_path.includes('/') && row.imports_path.startsWith('@')) continue;
                        if (!row.imports_path.includes('/') && !row.imports_path.includes('.')) {
                            // Basename like "message", "create-message" — resolve via code_chunks
                            const resolved = this._resolveImportPath(row.imports_path, fileDir);
                            for (const rp of resolved) {
                                if (!seedFiles.has(rp) && !discovered.has(rp)) {
                                    discovered.add(rp);
                                    nextFrontier.add(rp);
                                }
                            }
                            continue;
                        }
                        if (!seedFiles.has(row.imports_path) && !discovered.has(row.imports_path)) {
                            discovered.add(row.imports_path);
                            nextFrontier.add(row.imports_path);
                        }
                    }

                    // Reverse: files that IMPORT this file
                    const basename = file.split('/').pop()?.replace(/\.\w+$/, '') ?? '';
                    if (basename) {
                        const importers = this._db.prepare(
                            'SELECT DISTINCT file_path FROM code_imports WHERE imports_path = ? OR imports_path LIKE ?'
                        ).all(basename, `%/${basename}`) as { file_path: string }[];
                        for (const row of importers) {
                            if (!seedFiles.has(row.file_path) && !discovered.has(row.file_path)) {
                                discovered.add(row.file_path);
                                nextFrontier.add(row.file_path);
                            }
                        }
                    }
                } catch { /* table might not exist */ }
            }

            // Only explore hop-1 files in hop-2 (don't re-explore seeds)
            frontier.clear();
            for (const f of nextFrontier) frontier.add(f);
        }

        // Also cluster: if 3+ results from same directory, add sibling files
        this._clusterSiblings(seedFiles, discovered);

        return discovered;
    }

    /** Resolve a basename import (e.g. 'message') to real file paths. */
    private _resolveImportPath(basename: string, fromDir: string): string[] {
        if (!this._db) return [];
        try {
            // First: same directory (most likely for relative imports)
            const sameDir = this._db.prepare(
                `SELECT DISTINCT file_path FROM code_chunks
                 WHERE file_path LIKE ? AND file_path LIKE ?
                 LIMIT 3`
            ).all(`${fromDir}/%`, `%/${basename}.%`) as { file_path: string }[];
            if (sameDir.length > 0) return sameDir.map(r => r.file_path);

            // Also check subdirectories (e.g. dto/create-message)
            const subDir = this._db.prepare(
                `SELECT DISTINCT file_path FROM code_chunks
                 WHERE file_path LIKE ? AND file_path LIKE ?
                 LIMIT 3`
            ).all(`${fromDir}/%`, `%${basename}%`) as { file_path: string }[];
            if (subDir.length > 0) return subDir.map(r => r.file_path);

            // Fallback: global search
            const global = this._db.prepare(
                `SELECT DISTINCT file_path FROM code_chunks
                 WHERE file_path LIKE ? LIMIT 3`
            ).all(`%/${basename}.%`) as { file_path: string }[];
            return global.map(r => r.file_path);
        } catch { return []; }
    }

    /** If 3+ hits from same directory, include other files in that directory. */
    private _clusterSiblings(seedFiles: Set<string>, discovered: Set<string>): void {
        if (!this._db) return;

        const dirCounts = new Map<string, number>();
        for (const f of seedFiles) {
            const dir = f.split('/').slice(0, -1).join('/');
            dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1);
        }

        for (const [dir, count] of dirCounts) {
            if (count < 3 || !dir) continue;
            try {
                const siblings = this._db.prepare(
                    'SELECT DISTINCT file_path FROM code_chunks WHERE file_path LIKE ? AND file_path NOT LIKE ?'
                ).all(`${dir}/%`, `${dir}/%/%`) as { file_path: string }[];
                for (const row of siblings) {
                    if (!seedFiles.has(row.file_path)) discovered.add(row.file_path);
                }
            } catch { /* ignore */ }
        }
    }

    /** Fetch the most informative chunk per file. */
    private _fetchBestChunks(filePaths: string[]): Array<{
        filePath: string; content: string; name: string;
        chunkType: string; startLine: number; endLine: number; language: string;
    }> {
        if (!this._db || filePaths.length === 0) return [];

        const results: Array<{
            filePath: string; content: string; name: string;
            chunkType: string; startLine: number; endLine: number; language: string;
        }> = [];

        // Batch query — get the best chunk per file (largest by line span)
        for (const fp of filePaths.slice(0, 30)) {
            try {
                const row = this._db.prepare(
                    `SELECT file_path, content, name, chunk_type, start_line, end_line, language
                     FROM code_chunks WHERE file_path = ?
                     ORDER BY (end_line - start_line) DESC LIMIT 1`
                ).get(fp) as any;
                if (row) {
                    results.push({
                        filePath: row.file_path, content: row.content, name: row.name ?? '',
                        chunkType: row.chunk_type ?? 'block', startLine: row.start_line,
                        endLine: row.end_line, language: row.language ?? '',
                    });
                }
            } catch { /* ignore */ }
        }

        return results;
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

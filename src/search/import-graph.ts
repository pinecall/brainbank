/**
 * BrainBank — Import Graph Traversal
 *
 * 2-hop traversal of the code_imports table to discover related files.
 * Also clusters sibling files from directories with 3+ search hits.
 */

import type { Database } from '@/db/database.ts';
import type { CodeChunkRow } from '@/db/rows.ts';
import { escapeLike } from '@/lib/fts.ts';

/** Traverse import graph 1-2 hops from seed files, return new file paths. */
export function expandViaImportGraph(db: Database, seedFiles: Set<string>): Set<string> {
    const discovered = new Set<string>();
    const frontier = new Set(seedFiles);

    for (let hop = 0; hop < 2; hop++) {
        const nextFrontier = new Set<string>();

        for (const file of frontier) {
            try {
                const imports = db.prepare(
                    'SELECT imports_path FROM code_imports WHERE file_path = ?'
                ).all(file) as { imports_path: string }[];

                const fileDir = file.split('/').slice(0, -1).join('/');
                for (const row of imports) {
                    if (!row.imports_path.includes('/') && row.imports_path.startsWith('@')) continue;
                    if (!row.imports_path.includes('/') && !row.imports_path.includes('.')) {
                        const resolved = resolveImportPath(db, row.imports_path, fileDir);
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

                const basename = file.split('/').pop()?.replace(/\.\w+$/, '') ?? '';
                if (basename) {
                    const escapedBasename = escapeLike(basename);
                    const importers = db.prepare(
                        `SELECT DISTINCT file_path FROM code_imports WHERE imports_path = ? OR imports_path LIKE ? ESCAPE '\\'`
                    ).all(basename, `%/${escapedBasename}`) as { file_path: string }[];
                    for (const row of importers) {
                        if (!seedFiles.has(row.file_path) && !discovered.has(row.file_path)) {
                            discovered.add(row.file_path);
                            nextFrontier.add(row.file_path);
                        }
                    }
                }
            } catch { /* table might not exist */ }
        }

        frontier.clear();
        for (const f of nextFrontier) frontier.add(f);
    }

    clusterSiblings(db, seedFiles, discovered);
    return discovered;
}

/** Resolve a basename import (e.g. 'message') to real file paths. */
function resolveImportPath(db: Database, basename: string, fromDir: string): string[] {
    try {
        const escapedDir = escapeLike(fromDir);
        const escapedBase = escapeLike(basename);

        const sameDir = db.prepare(
            `SELECT DISTINCT file_path FROM code_chunks
             WHERE file_path LIKE ? ESCAPE '\\' AND file_path LIKE ? ESCAPE '\\'
             LIMIT 3`
        ).all(`${escapedDir}/%`, `%/${escapedBase}.%`) as { file_path: string }[];
        if (sameDir.length > 0) return sameDir.map(r => r.file_path);

        const subDir = db.prepare(
            `SELECT DISTINCT file_path FROM code_chunks
             WHERE file_path LIKE ? ESCAPE '\\' AND file_path LIKE ? ESCAPE '\\'
             LIMIT 3`
        ).all(`${escapedDir}/%`, `%${escapedBase}%`) as { file_path: string }[];
        if (subDir.length > 0) return subDir.map(r => r.file_path);

        const global = db.prepare(
            `SELECT DISTINCT file_path FROM code_chunks
             WHERE file_path LIKE ? ESCAPE '\\' LIMIT 3`
        ).all(`%/${escapedBase}.%`) as { file_path: string }[];
        return global.map(r => r.file_path);
    } catch { return []; }
}

/** If 3+ hits from same directory, include other files in that directory. */
function clusterSiblings(db: Database, seedFiles: Set<string>, discovered: Set<string>): void {
    const dirCounts = new Map<string, number>();
    for (const f of seedFiles) {
        const dir = f.split('/').slice(0, -1).join('/');
        dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1);
    }

    for (const [dir, count] of dirCounts) {
        if (count < 3 || !dir) continue;
        try {
            const escapedDir = escapeLike(dir);
            const siblings = db.prepare(
                `SELECT DISTINCT file_path FROM code_chunks WHERE file_path LIKE ? ESCAPE '\\' AND file_path NOT LIKE ? ESCAPE '\\'`
            ).all(`${escapedDir}/%`, `${escapedDir}/%/%`) as { file_path: string }[];
            for (const row of siblings) {
                if (!seedFiles.has(row.file_path)) discovered.add(row.file_path);
            }
        } catch { /* ignore */ }
    }
}

/** Fetch the most informative chunk per file (largest by line span). */
export function fetchBestChunks(db: Database, filePaths: string[]): Array<{
    filePath: string; content: string; name: string;
    chunkType: string; startLine: number; endLine: number; language: string;
}> {
    if (filePaths.length === 0) return [];

    const results: Array<{
        filePath: string; content: string; name: string;
        chunkType: string; startLine: number; endLine: number; language: string;
    }> = [];

    for (const fp of filePaths.slice(0, 30)) {
        try {
            const row = db.prepare(
                `SELECT file_path, content, name, chunk_type, start_line, end_line, language
                 FROM code_chunks WHERE file_path = ?
                 ORDER BY (end_line - start_line) DESC LIMIT 1`
            ).get(fp) as CodeChunkRow | undefined;
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

/**
 * BrainBank — Keyword Search Strategy
 * 
 * Keyword search via SQLite FTS5 with BM25 ranking.
 * Searches across code chunks and git commits.
 * Uses Porter stemming + unicode61 tokenizer.
 */

import type { Database } from '@/db/database.ts';
import type { CodeChunkRow, GitCommitRow } from '@/db/rows.ts';
import type { SearchResult } from '@/types.ts';
import type { SearchStrategy, SearchOptions } from '@/search/types.ts';
import { sanitizeFTS, normalizeBM25, escapeLike } from '@/lib/fts.ts';

/** Check if an error is an FTS5 query syntax error (expected, safe to ignore). */
function isFTSError(e: unknown): boolean {
    return e instanceof Error && /fts5|syntax error|parse error/i.test(e.message);
}

export class KeywordSearch implements SearchStrategy {
    constructor(private _db: Database) {}

    /**
     * Full-text keyword search across all FTS5 indices.
     * Uses BM25 scoring — lower scores = better matches.
     */
    async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
        const src = options.sources ?? {};
        const codeK = src.code ?? 8;
        const gitK = src.git ?? 5;

        const ftsQuery = sanitizeFTS(query);
        if (!ftsQuery) return [];

        const results: SearchResult[] = [];

        if (codeK > 0) this._searchCode(ftsQuery, query, codeK, results);
        if (gitK > 0) this._searchGit(ftsQuery, gitK, results);

        return results.sort((a, b) => b.score - a.score);
    }

    /** FTS5 search across code chunks + file-path fallback. */
    private _searchCode(ftsQuery: string, rawQuery: string, k: number, results: SearchResult[]): void {
        const seenIds = new Set<number>();

        try {
            const rows = this._db.prepare(`
                SELECT c.id, c.file_path, c.chunk_type, c.name, c.start_line, c.end_line,
                       c.content, c.language, bm25(fts_code, 5.0, 3.0, 1.0) AS score
                FROM fts_code f
                JOIN code_chunks c ON c.id = f.rowid
                WHERE fts_code MATCH ?
                ORDER BY score ASC
                LIMIT ?
            `).all(ftsQuery, k) as (CodeChunkRow & { score: number })[];

            for (const r of rows) {
                seenIds.add(r.id);
                results.push(this._toCodeResult(r, normalizeBM25(r.score), 'bm25'));
            }
        } catch (e) { if (!isFTSError(e)) throw e; }

        this._searchCodeByPath(rawQuery, seenIds, results);
    }

    /** File-path fallback: match filenames via LIKE. */
    private _searchCodeByPath(rawQuery: string, seenIds: Set<number>, results: SearchResult[]): void {
        try {
            const words = rawQuery.replace(/[^a-zA-Z0-9]/g, ' ').split(/\s+/).filter(w => w.length > 2);
            for (const word of words.slice(0, 3)) {
                const pathRows = this._db.prepare(`
                    SELECT id, file_path, chunk_type, name, start_line, end_line, content, language
                    FROM code_chunks
                    WHERE file_path LIKE ? ESCAPE '\\' AND chunk_type = 'file'
                    LIMIT 3
                `).all(`%${escapeLike(word)}%`) as CodeChunkRow[];

                for (const r of pathRows) {
                    if (seenIds.has(r.id)) continue;
                    seenIds.add(r.id);
                    results.push(this._toCodeResult(r, 0.6, 'bm25-path'));
                }
            }
        } catch (e) { if (!isFTSError(e)) throw e; }
    }

    /** FTS5 search across git commits. */
    private _searchGit(ftsQuery: string, k: number, results: SearchResult[]): void {
        try {
            const rows = this._db.prepare(`
                SELECT c.id, c.hash, c.short_hash, c.message, c.author, c.date,
                       c.files_json, c.diff, c.additions, c.deletions,
                       bm25(fts_commits, 5.0, 2.0, 1.0) AS score
                FROM fts_commits f
                JOIN git_commits c ON c.id = f.rowid
                WHERE fts_commits MATCH ? AND c.is_merge = 0
                ORDER BY score ASC
                LIMIT ?
            `).all(ftsQuery, k) as (GitCommitRow & { score: number })[];

            for (const r of rows) {
                results.push({
                    type: 'commit',
                    score: normalizeBM25(r.score),
                    content: r.message,
                    metadata: {
                        hash: r.hash,
                        shortHash: r.short_hash,
                        author: r.author,
                        date: r.date,
                        files: JSON.parse(r.files_json ?? '[]') as string[],
                        additions: r.additions,
                        deletions: r.deletions,
                        diff: r.diff ?? undefined,
                        searchType: 'bm25',
                    },
                });
            }
        } catch (e) { if (!isFTSError(e)) throw e; }
    }

    /** Map a code_chunks row to a CodeResult. */
    private _toCodeResult(r: CodeChunkRow, score: number, searchType: string): SearchResult {
        return {
            type: 'code',
            score,
            filePath: r.file_path,
            content: r.content,
            metadata: {
                id: r.id,
                chunkType: r.chunk_type,
                name: r.name ?? undefined,
                startLine: r.start_line,
                endLine: r.end_line,
                language: r.language,
                searchType,
            },
        };
    }

    /** Rebuild all FTS5 indices from their content tables. */
    rebuild(): void {
        try {
            this._db.prepare("INSERT INTO fts_code(fts_code) VALUES('rebuild')").run();
            this._db.prepare("INSERT INTO fts_commits(fts_commits) VALUES('rebuild')").run();
        } catch { /* non-fatal */ }
    }
}

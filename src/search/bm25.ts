/**
 * BrainBank — BM25 Full-Text Search
 * 
 * Keyword search via SQLite FTS5 with BM25 ranking.
 * Searches across code chunks, git commits, and learning patterns.
 * Uses Porter stemming + unicode61 tokenizer.
 */

import type { Database } from '../db/database.ts';
import type { SearchResult } from '../types.ts';
import { sanitizeFTS, normalizeBM25 } from './utils.ts';

export interface BM25Options {
    /** Max code results. Default: 8 */
    codeK?: number;
    /** Max git results. Default: 5 */
    gitK?: number;
    /** Max pattern results. Default: 4 */
    patternK?: number;
}

export class BM25Search {
    constructor(private _db: Database) {}

    /**
     * Full-text keyword search across all FTS5 indices.
     * Uses BM25 scoring — lower scores = better matches.
     * Query syntax: simple words, OR, NOT, "exact phrases", prefix*
     */
    search(query: string, options: BM25Options = {}): SearchResult[] {
        const { codeK = 8, gitK = 5, patternK = 4 } = options;
        const results: SearchResult[] = [];

        const ftsQuery = sanitizeFTS(query);
        if (!ftsQuery) return [];

        // ── Code search ────────────────────────────
        if (codeK > 0) {
            try {
                const rows = this._db.prepare(`
                    SELECT c.id, c.file_path, c.chunk_type, c.name, c.start_line, c.end_line,
                           c.content, c.language, bm25(fts_code, 5.0, 3.0, 1.0) AS score
                    FROM fts_code f
                    JOIN code_chunks c ON c.id = f.rowid
                    WHERE fts_code MATCH ?
                    ORDER BY score ASC
                    LIMIT ?
                `).all(ftsQuery, codeK) as any[];

                for (const r of rows) {
                    results.push({
                        type: 'code',
                        score: normalizeBM25(r.score),
                        filePath: r.file_path,
                        content: r.content,
                        metadata: {
                            chunkType: r.chunk_type,
                            name: r.name,
                            startLine: r.start_line,
                            endLine: r.end_line,
                            language: r.language,
                            searchType: 'bm25',
                        },
                    });
                }
            } catch {}
        }

        // ── Git search ─────────────────────────────
        if (gitK > 0) {
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
                `).all(ftsQuery, gitK) as any[];

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
                            files: JSON.parse(r.files_json ?? '[]'),
                            additions: r.additions,
                            deletions: r.deletions,
                            diff: r.diff,
                            searchType: 'bm25',
                        },
                    });
                }
            } catch {}
        }

        // ── Pattern search ──────────────────────────
        if (patternK > 0) {
            try {
                const rows = this._db.prepare(`
                    SELECT p.id, p.task_type, p.task, p.approach, p.outcome,
                           p.success_rate, p.critique,
                           bm25(fts_patterns, 3.0, 5.0, 5.0, 1.0) AS score
                    FROM fts_patterns f
                    JOIN memory_patterns p ON p.id = f.rowid
                    WHERE fts_patterns MATCH ? AND p.success_rate >= 0.5
                    ORDER BY score ASC
                    LIMIT ?
                `).all(ftsQuery, patternK) as any[];

                for (const r of rows) {
                    results.push({
                        type: 'pattern',
                        score: normalizeBM25(r.score),
                        content: r.approach,
                        metadata: {
                            taskType: r.task_type,
                            task: r.task,
                            outcome: r.outcome,
                            successRate: r.success_rate,
                            critique: r.critique,
                            searchType: 'bm25',
                        },
                    });
                }
            } catch {}
        }

        return results.sort((a, b) => b.score - a.score);
    }

    /**
     * Rebuild the FTS index from scratch.
     * Call this after bulk imports or if FTS gets out of sync.
     */
    rebuild(): void {
        try {
            this._db.prepare("INSERT INTO fts_code(fts_code) VALUES('rebuild')").run();
            this._db.prepare("INSERT INTO fts_commits(fts_commits) VALUES('rebuild')").run();
            this._db.prepare("INSERT INTO fts_patterns(fts_patterns) VALUES('rebuild')").run();
        } catch {}
    }

}

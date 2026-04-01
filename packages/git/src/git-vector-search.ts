/**
 * @brainbank/git — Git Vector Search
 *
 * Searches git_commits via HNSW.
 * Moved from core — domain-specific strategy for CompositeVectorSearch.
 */

import type { SearchResult } from 'brainbank';

/** Typed row shape for git_commits table. */
export interface GitCommitRow {
    id: number;
    hash: string;
    short_hash: string;
    message: string;
    author: string;
    date: string;
    timestamp: number;
    files_json: string;
    diff: string | null;
    additions: number;
    deletions: number;
    is_merge: number;
}

export interface GitVectorConfig {
    db: { prepare(sql: string): { all(...params: unknown[]): unknown[] } };
    hnsw: { size: number; search(vec: Float32Array, k: number): { id: number; score: number }[] };
}

export class GitVectorSearch {
    constructor(private _c: GitVectorConfig) {}

    /** Search git_commits by vector similarity. */
    search(queryVec: Float32Array, k: number, minScore: number): SearchResult[] {
        const { hnsw, db } = this._c;
        if (hnsw.size === 0) return [];

        const hits = hnsw.search(queryVec, k * 2);
        if (hits.length === 0) return [];

        const ids = hits.map(h => h.id);
        const scoreMap = new Map(hits.map(h => [h.id, h.score]));
        const placeholders = ids.map(() => '?').join(',');
        const rows = db.prepare(
            `SELECT * FROM git_commits WHERE id IN (${placeholders}) AND is_merge = 0`
        ).all(...ids) as GitCommitRow[];

        const results: SearchResult[] = [];
        for (const r of rows) {
            const score = scoreMap.get(r.id) ?? 0;
            if (score >= minScore) {
                results.push({
                    type: 'commit', score, content: r.message,
                    metadata: {
                        hash: r.hash, shortHash: r.short_hash,
                        author: r.author, date: r.date,
                        files: JSON.parse(r.files_json ?? '[]') as string[],
                        additions: r.additions, deletions: r.deletions, diff: r.diff ?? undefined,
                    },
                });
            }
        }
        return results;
    }
}

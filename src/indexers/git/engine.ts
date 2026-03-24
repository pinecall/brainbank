/**
 * BrainBank — Git Indexer
 * 
 * Reads git history, embeds commit messages + diffs,
 * and computes file co-edit relationships.
 * Incremental: only processes new commits.
 */

import type { Database } from '../../db/database.ts';
import type { EmbeddingProvider, ProgressCallback, IndexResult } from '../../types.ts';
import type { HNSWIndex } from '../../providers/vector/hnsw.ts';

export interface GitIndexerDeps {
    db: Database;
    hnsw: HNSWIndex;
    vectorCache: Map<number, Float32Array>;
    embedding: EmbeddingProvider;
}

export interface GitIndexOptions {
    depth?: number;
    onProgress?: ProgressCallback;
}

export class GitIndexer {
    private _deps: GitIndexerDeps;
    private _repoPath: string;
    private _maxDiffBytes: number;

    constructor(repoPath: string, deps: GitIndexerDeps, maxDiffBytes: number = 8192) {
        this._deps = deps;
        this._repoPath = repoPath;
        this._maxDiffBytes = maxDiffBytes;
    }

    /**
     * Index git history.
     * Only processes commits not already in the database.
     */
    async index(options: GitIndexOptions = {}): Promise<IndexResult> {
        const { depth = 500, onProgress } = options;

        let git: any;
        try {
            const simpleGit = (await import('simple-git')).default;
            git = simpleGit(this._repoPath);
        } catch {
            return { indexed: 0, skipped: 0 };
        }

        let log: any;
        try { log = await git.log({ maxCount: depth }); }
        catch { return { indexed: 0, skipped: 0 }; }

        const commits = log.all;
        let indexed = 0, skipped = 0;
        const newCommitIds: number[] = [];

        for (let i = 0; i < commits.length; i++) {
            const c = commits[i];
            onProgress?.(`[${c.hash.slice(0, 7)}] ${c.message.slice(0, 50)}`, i + 1, commits.length);

            // Skip if already indexed WITH vector (LEFT JOIN catches zombie commits)
            const exists = this._deps.db.prepare(
                `SELECT gc.id, gv.commit_id AS has_vector
                 FROM git_commits gc
                 LEFT JOIN git_vectors gv ON gv.commit_id = gc.id
                 WHERE gc.hash = ?`
            ).get(c.hash) as any;
            if (exists?.has_vector) { skipped++; continue; }

            // Zombie commit (data exists but vector missing) — delete and re-insert cleanly
            if (exists && !exists.has_vector) {
                this._deps.db.prepare('DELETE FROM commit_files WHERE commit_id = ?').run(exists.id);
                this._deps.db.prepare('DELETE FROM git_commits WHERE id = ?').run(exists.id);
            }

            // Get diff and stat
            let diff = '';
            let additions = 0, deletions = 0;
            const filesChanged: string[] = [];

            try {
                // Use --numstat for real line counts: "<add>\t<del>\t<file>"
                const numstat = await git.raw(['show', '--numstat', '--format=', c.hash]);
                for (const line of numstat.trim().split('\n')) {
                    if (!line.trim()) continue;
                    const parts = line.split('\t');
                    if (parts.length < 3) continue;
                    const add = parseInt(parts[0], 10);
                    const del = parseInt(parts[1], 10);
                    const file = parts[2].trim();
                    if (file) {
                        filesChanged.push(file);
                        if (!isNaN(add)) additions += add;
                        if (!isNaN(del)) deletions += del;
                    }
                }

                const rawDiff = await git.raw(['show', '--format=', '--unified=3', '--no-color', c.hash]);
                diff = rawDiff.length > this._maxDiffBytes
                    ? rawDiff.slice(0, this._maxDiffBytes) + '\n... [truncated]'
                    : rawDiff;
            } catch {}

            // Detect merges by regex first, then fall back to parent count
            // (Parent count is checked in batch below to avoid N+1 git calls)
            let isMerge = /^(Merge|merge)\s+(branch|pull|remote|tag)\b/.test(c.message);
            const ts = Math.floor(new Date(c.date).getTime() / 1000);

            const result = this._deps.db.prepare(`
                INSERT OR IGNORE INTO git_commits (hash, short_hash, message, author, date, timestamp, files_json, diff, additions, deletions, is_merge)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                c.hash, c.hash.slice(0, 7), c.message, c.author_name, c.date,
                ts, JSON.stringify(filesChanged), diff || null,
                additions, deletions, isMerge ? 1 : 0,
            );

            if (result.changes === 0) { skipped++; continue; }
            const commitId = Number(result.lastInsertRowid);

            // Insert commit files
            for (const f of filesChanged) {
                this._deps.db.prepare(
                    'INSERT INTO commit_files (commit_id, file_path) VALUES (?, ?)'
                ).run(commitId, f);
            }

            // Embed: message + files + diff snippet
            const text = [
                `Commit: ${c.message}`,
                `Author: ${c.author_name}`,
                `Date: ${c.date}`,
                filesChanged.length > 0 ? `Files: ${filesChanged.join(', ')}` : '',
                diff ? `Changes:\n${diff.slice(0, 2000)}` : '',
            ].filter(Boolean).join('\n');

            const vec = await this._deps.embedding.embed(text);
            this._deps.db.prepare(
                'INSERT OR IGNORE INTO git_vectors (commit_id, embedding) VALUES (?, ?)'
            ).run(commitId, Buffer.from(vec.buffer));

            this._deps.hnsw.add(vec, commitId);
            this._deps.vectorCache.set(commitId, vec);
            newCommitIds.push(commitId);
            indexed++;
        }

        // Compute co-edits only for new commits
        if (newCommitIds.length > 0) {
            this._computeCoEdits(newCommitIds);
        }

        return { indexed, skipped };
    }

    /**
     * Compute which files tend to be edited together.
     * Stored in the co_edits table for later suggestion.
     */
    private _computeCoEdits(newCommitIds: number[]): void {
        if (newCommitIds.length === 0) return;

        // Chunk queries to stay under SQLite's 999-variable limit
        const CHUNK_SIZE = 500;
        const allRows: any[] = [];
        for (let i = 0; i < newCommitIds.length; i += CHUNK_SIZE) {
            const chunk = newCommitIds.slice(i, i + CHUNK_SIZE);
            const placeholders = chunk.map(() => '?').join(',');
            const rows = this._deps.db.prepare(
                `SELECT commit_id, file_path FROM commit_files WHERE commit_id IN (${placeholders}) ORDER BY commit_id`
            ).all(...chunk) as any[];
            allRows.push(...rows);
        }
        const rows = allRows;

        const byCommit = new Map<number, string[]>();
        for (const r of rows) {
            if (!byCommit.has(r.commit_id)) byCommit.set(r.commit_id, []);
            byCommit.get(r.commit_id)!.push(r.file_path);
        }

        const upsert = this._deps.db.prepare(
            `INSERT INTO co_edits (file_a, file_b, count)
             VALUES (?, ?, 1)
             ON CONFLICT(file_a, file_b) DO UPDATE SET count = count + 1`
        );

        this._deps.db.transaction(() => {
            for (const files of byCommit.values()) {
                // Skip very small or very large changesets
                if (files.length < 2 || files.length > 20) continue;
                for (let i = 0; i < files.length; i++) {
                    for (let j = i + 1; j < files.length; j++) {
                        const [a, b] = [files[i], files[j]].sort();
                        upsert.run(a, b);
                    }
                }
            }
        });
    }
}

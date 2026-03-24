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

        for (let i = 0; i < commits.length; i++) {
            const c = commits[i];
            onProgress?.(`[${c.hash.slice(0, 7)}] ${c.message.slice(0, 50)}`, i + 1, commits.length);

            // Skip if already indexed
            const exists = this._deps.db.prepare(
                'SELECT id FROM git_commits WHERE hash = ?'
            ).get(c.hash);
            if (exists) { skipped++; continue; }

            // Get diff and stat
            let diff = '';
            let additions = 0, deletions = 0;
            const filesChanged: string[] = [];

            try {
                const stat = await git.raw(['show', '--stat', '--format=', c.hash]);
                for (const line of stat.trim().split('\n')) {
                    const m = line.match(/^\s+(.+?)\s+\|\s+(\d+)\s*([\+\-]*)/);
                    if (m) {
                        filesChanged.push(m[1].trim());
                        additions += (m[3].match(/\+/g) ?? []).length;
                        deletions += (m[3].match(/-/g) ?? []).length;
                    }
                }

                const rawDiff = await git.raw(['show', '--format=', '--unified=3', '--no-color', c.hash]);
                diff = rawDiff.length > this._maxDiffBytes
                    ? rawDiff.slice(0, this._maxDiffBytes) + '\n... [truncated]'
                    : rawDiff;
            } catch {}

            const isMerge = c.message.startsWith('Merge') || c.message.startsWith('merge');
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
            indexed++;
        }

        // Compute co-edits
        this._computeCoEdits();

        return { indexed, skipped };
    }

    /**
     * Compute which files tend to be edited together.
     * Stored in the co_edits table for later suggestion.
     */
    private _computeCoEdits(): void {
        const rows = this._deps.db.prepare(
            'SELECT commit_id, file_path FROM commit_files ORDER BY commit_id'
        ).all() as any[];

        const byCommit = new Map<number, string[]>();
        for (const r of rows) {
            if (!byCommit.has(r.commit_id)) byCommit.set(r.commit_id, []);
            byCommit.get(r.commit_id)!.push(r.file_path);
        }

        const counts = new Map<string, number>();
        for (const files of byCommit.values()) {
            // Skip very small or very large changesets
            if (files.length < 2 || files.length > 20) continue;
            for (let i = 0; i < files.length; i++) {
                for (let j = i + 1; j < files.length; j++) {
                    const key = [files[i], files[j]].sort().join('|||');
                    counts.set(key, (counts.get(key) ?? 0) + 1);
                }
            }
        }

        for (const [key, count] of counts) {
            if (count < 2) continue;
            const [a, b] = key.split('|||');
            this._deps.db.prepare(
                `INSERT INTO co_edits (file_a, file_b, count)
                 VALUES (?, ?, ?)
                 ON CONFLICT(file_a, file_b) DO UPDATE SET count = excluded.count`
            ).run(a, b, count);
        }
    }
}

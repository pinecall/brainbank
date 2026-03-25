/**
 * BrainBank — Git Indexer
 * 
 * Reads git history, embeds commit messages + diffs,
 * and computes file co-edit relationships.
 * Incremental: only processes new commits.
 */

import type { Database } from '@/db/database.ts';
import type { EmbeddingProvider, ProgressCallback, IndexResult } from '@/types.ts';
import type { HNSWIndex } from '@/providers/vector/hnsw-index.ts';

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

interface CommitData {
    commit: any;
    diff: string;
    additions: number;
    deletions: number;
    filesChanged: string[];
    isMerge: boolean;
    text: string;
}

/** Prepared statements for git commit operations. */
interface GitStatements {
    check: any;
    deleteFiles: any;
    deleteCommit: any;
    insertCommit: any;
    insertFile: any;
    insertVec: any;
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

        const git = await this._initGit();
        if (!git) return { indexed: 0, skipped: 0 };

        let log: any;
        try { log = await git.log({ maxCount: depth }); }
        catch { return { indexed: 0, skipped: 0 }; }

        const stmts = this._prepareStatements();
        const { toProcess, skipped } = await this._collectCommits(git, log.all, stmts, onProgress);

        if (toProcess.length === 0) return { indexed: 0, skipped };

        const vecs = await this._deps.embedding.embedBatch(toProcess.map(d => d.text));
        const { indexed, newCommitIds } = this._insertCommits(toProcess, vecs, stmts);

        this._updateHnsw(vecs, newCommitIds);

        return { indexed, skipped };
    }

    /** Initialize simple-git. Returns null if git is unavailable. */
    private async _initGit(): Promise<any | null> {
        try {
            const simpleGit = (await import('simple-git')).default;
            return simpleGit(this._repoPath);
        } catch {
            return null;
        }
    }

    /** Prepare all SQL statements (hoisted outside loops). */
    private _prepareStatements(): GitStatements {
        const db = this._deps.db;
        return {
            check: db.prepare(`
                SELECT gc.id, gv.commit_id AS has_vector
                FROM git_commits gc
                LEFT JOIN git_vectors gv ON gv.commit_id = gc.id
                WHERE gc.hash = ?`),
            deleteFiles: db.prepare('DELETE FROM commit_files WHERE commit_id = ?'),
            deleteCommit: db.prepare('DELETE FROM git_commits WHERE id = ?'),
            insertCommit: db.prepare(`
                INSERT OR IGNORE INTO git_commits (hash, short_hash, message, author, date, timestamp, files_json, diff, additions, deletions, is_merge)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
            insertFile: db.prepare('INSERT INTO commit_files (commit_id, file_path) VALUES (?, ?)'),
            insertVec: db.prepare('INSERT OR IGNORE INTO git_vectors (commit_id, embedding) VALUES (?, ?)'),
        };
    }

    /** Phase 1: Collect commit data from git (async git calls). */
    private async _collectCommits(
        git: any,
        commits: any[],
        stmts: GitStatements,
        onProgress?: ProgressCallback,
    ): Promise<{ toProcess: CommitData[]; skipped: number }> {
        const toProcess: CommitData[] = [];
        let skipped = 0;

        for (let i = 0; i < commits.length; i++) {
            const c = commits[i];
            onProgress?.(`[${c.hash.slice(0, 7)}] ${c.message.slice(0, 50)}`, i + 1, commits.length);

            const exists = stmts.check.get(c.hash) as any;
            if (exists?.has_vector) { skipped++; continue; }

            // Zombie commit (data exists but vector missing) — clean up
            if (exists && !exists.has_vector) {
                stmts.deleteFiles.run(exists.id);
                stmts.deleteCommit.run(exists.id);
            }

            const data = await this._parseCommit(git, c);
            toProcess.push(data);
        }

        return { toProcess, skipped };
    }

    /** Extract diff, stat, and text from a single commit. */
    private async _parseCommit(git: any, c: any): Promise<CommitData> {
        let diff = '';
        let additions = 0, deletions = 0;
        const filesChanged: string[] = [];

        try {
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

        const isMerge = /^(Merge|merge)\s+(branch|pull|remote|tag)\b/.test(c.message);
        const text = [
            `Commit: ${c.message}`,
            `Author: ${c.author_name}`,
            `Date: ${c.date}`,
            filesChanged.length > 0 ? `Files: ${filesChanged.join(', ')}` : '',
            diff ? `Changes:\n${diff.slice(0, 2000)}` : '',
        ].filter(Boolean).join('\n');

        return { commit: c, diff, additions, deletions, filesChanged, isMerge, text };
    }

    /** Phase 3: Insert commits + vectors in a single transaction. */
    private _insertCommits(
        toProcess: CommitData[],
        vecs: Float32Array[],
        stmts: GitStatements,
    ): { indexed: number; newCommitIds: { commitId: number; vecIndex: number }[] } {
        let indexed = 0;
        const newCommitIds: { commitId: number; vecIndex: number }[] = [];

        this._deps.db.transaction(() => {
            for (let i = 0; i < toProcess.length; i++) {
                const d = toProcess[i];
                const c = d.commit;
                const ts = Math.floor(new Date(c.date).getTime() / 1000);

                const result = stmts.insertCommit.run(
                    c.hash, c.hash.slice(0, 7), c.message, c.author_name, c.date,
                    ts, JSON.stringify(d.filesChanged), d.diff || null,
                    d.additions, d.deletions, d.isMerge ? 1 : 0,
                );

                if (result.changes === 0) continue;
                const commitId = Number(result.lastInsertRowid);

                for (const f of d.filesChanged) {
                    stmts.insertFile.run(commitId, f);
                }

                stmts.insertVec.run(commitId, Buffer.from(vecs[i].buffer));
                newCommitIds.push({ commitId, vecIndex: i });
                indexed++;
            }
        });

        return { indexed, newCommitIds };
    }

    /** Phase 4: Update HNSW index and compute co-edits. */
    private _updateHnsw(
        vecs: Float32Array[],
        inserted: { commitId: number; vecIndex: number }[],
    ): void {
        const newCommitIds: number[] = [];
        for (const { commitId, vecIndex } of inserted) {
            this._deps.hnsw.add(vecs[vecIndex], commitId);
            this._deps.vectorCache.set(commitId, vecs[vecIndex]);
            newCommitIds.push(commitId);
        }

        if (newCommitIds.length > 0) {
            this._computeCoEdits(newCommitIds);
        }
    }

    /** Compute which files tend to be edited together. */
    private _computeCoEdits(newCommitIds: number[]): void {
        if (newCommitIds.length === 0) return;

        const rows = this._queryCommitFiles(newCommitIds);
        const byCommit = this._groupFilesByCommit(rows);

        const upsert = this._deps.db.prepare(
            `INSERT INTO co_edits (file_a, file_b, count)
             VALUES (?, ?, 1)
             ON CONFLICT(file_a, file_b) DO UPDATE SET count = count + 1`
        );

        this._deps.db.transaction(() => {
            for (const files of byCommit.values()) {
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

    /** Query commit_files in chunks to stay under SQLite's 999-variable limit. */
    private _queryCommitFiles(commitIds: number[]): any[] {
        const CHUNK_SIZE = 500;
        const allRows: any[] = [];
        for (let i = 0; i < commitIds.length; i += CHUNK_SIZE) {
            const chunk = commitIds.slice(i, i + CHUNK_SIZE);
            const placeholders = chunk.map(() => '?').join(',');
            const rows = this._deps.db.prepare(
                `SELECT commit_id, file_path FROM commit_files WHERE commit_id IN (${placeholders}) ORDER BY commit_id`
            ).all(...chunk) as any[];
            allRows.push(...rows);
        }
        return allRows;
    }

    /** Group file paths by commit ID. */
    private _groupFilesByCommit(rows: any[]): Map<number, string[]> {
        const byCommit = new Map<number, string[]>();
        for (const r of rows) {
            if (!byCommit.has(r.commit_id)) byCommit.set(r.commit_id, []);
            byCommit.get(r.commit_id)!.push(r.file_path);
        }
        return byCommit;
    }
}

/**
 * @brainbank/git — Git Plugin
 * 
 * Git history indexing with co-edit relationships.
 * 
 *   import { BrainBank } from 'brainbank';
 *   import { git } from '@brainbank/git';
 *   
 *   const brain = new BrainBank().use(git({ depth: 500 }));
 */

import type { Plugin, PluginContext, EmbeddingProvider, IndexResult, ProgressCallback, CoEditSuggestion, ReembedTable, SearchResult } from 'brainbank';
import type { HNSWIndex } from 'brainbank';
import { runPluginMigrations, sanitizeFTS, normalizeBM25 } from 'brainbank';

import { GitIndexer } from './git-indexer.js';
import { CoEditAnalyzer } from './co-edit-analyzer.js';
import { GitVectorSearch } from './git-vector-search.js';
import { formatGitResults, formatCoEdits } from './git-context-formatter.js';
import { GIT_SCHEMA_VERSION, GIT_MIGRATIONS } from './git-schema.js';
import type { GitCommitRow } from './git-vector-search.js';

type Database = PluginContext['db'];

/** Check if an error is an FTS5 query syntax error (expected, safe to ignore). */
function isFTSError(e: unknown): boolean {
    return e instanceof Error && /fts5|syntax error|parse error/i.test(e.message);
}

export interface GitPluginOptions {
    /** Repository path. Default: from config */
    repoPath?: string;
    /** Max commits to index. Default: from config */
    depth?: number;
    /** Max diff bytes. Default: from config */
    maxDiffBytes?: number;
    /** Per-plugin embedding provider. Default: global embedding from BrainBank config. */
    embeddingProvider?: EmbeddingProvider;
}

class GitPlugin implements Plugin {
    readonly name: string;
    private db!: Database;
    hnsw!: HNSWIndex;
    indexer!: GitIndexer;
    coEdits!: CoEditAnalyzer;
    vecCache = new Map<number, Float32Array>();

    constructor(private opts: GitPluginOptions = {}) {
        this.name = 'git';
    }

    async initialize(ctx: PluginContext): Promise<void> {
        this.db = ctx.db;
        runPluginMigrations(ctx.db, this.name, GIT_SCHEMA_VERSION, GIT_MIGRATIONS);
        const embedding = this.opts.embeddingProvider ?? ctx.embedding;

        // HNSW index for git vector search
        const shared = await ctx.getOrCreateSharedHnsw('git', 500_000, embedding.dims);
        this.hnsw = shared.hnsw;
        this.vecCache = shared.vecCache;

        if (shared.isNew) {
            ctx.loadVectors('git_vectors', 'commit_id', this.hnsw, this.vecCache);
        }

        const repoPath = this.opts.repoPath ?? ctx.config.repoPath;
        this.indexer = new GitIndexer(repoPath, {
            db: ctx.db,
            hnsw: this.hnsw,
            vectorCache: this.vecCache,
            embedding,
        }, this.opts.maxDiffBytes ?? ctx.config.maxDiffBytes);

        this.coEdits = new CoEditAnalyzer(ctx.db);
    }

    async index(options: {
        depth?: number;
        onProgress?: ProgressCallback;
    } = {}): Promise<IndexResult> {
        return this.indexer.index(options);
    }

    suggestCoEdits(filePath: string, limit: number = 5): CoEditSuggestion[] {
        return this.coEdits.suggest(filePath, limit);
    }

    /** VectorSearchPlugin — create domain vector search strategy. */
    createVectorSearch() {
        return new GitVectorSearch({
            db: this.db,
            hnsw: this.hnsw,
        });
    }

    /** ContextFormatterPlugin — format git results with co-edit patterns. */
    formatContext(results: SearchResult[], parts: string[], options?: Record<string, unknown>): void {
        formatGitResults(results, 5, parts);

        const affectedFiles = options?.affectedFiles as string[] | undefined;
        if (affectedFiles && affectedFiles.length > 0) {
            formatCoEdits(affectedFiles, parts, this.coEdits);
        }
    }

    /** BM25SearchPlugin — FTS5 keyword search across git commits. */
    searchBM25(query: string, k: number): SearchResult[] {
        const ftsQuery = sanitizeFTS(query);
        if (!ftsQuery) return [];

        const results: SearchResult[] = [];
        try {
            const rows = this.db.prepare(`
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

        return results;
    }

    /** Rebuild the FTS5 index from the content table. */
    rebuildFTS(): void {
        try {
            this.db.prepare("INSERT INTO fts_commits(fts_commits) VALUES('rebuild')").run();
        } catch { /* non-fatal */ }
    }

    /** Get git history for a specific file. */
    fileHistory(filePath: string, limit: number = 20): unknown[] {
        const escaped = filePath.replace(/[%_\\]/g, '\\$&');
        return this.db.prepare(`
            SELECT c.short_hash, c.message, c.author, c.date, c.additions, c.deletions
            FROM git_commits c
            INNER JOIN commit_files cf ON c.id = cf.commit_id
            WHERE cf.file_path LIKE ? ESCAPE '\\' AND c.is_merge = 0
            ORDER BY c.timestamp DESC LIMIT ?
        `).all(`%${escaped}%`, limit) as unknown[];
    }

    /** Table descriptor for re-embedding git vectors from DB rows. */
    reembedConfig(): ReembedTable {
        return {
            name: 'git',
            textTable: 'git_commits',
            vectorTable: 'git_vectors',
            idColumn: 'id',
            fkColumn: 'commit_id',
            textBuilder: (r) => [
                `Commit: ${r.message}`,
                `Author: ${r.author}`,
                `Date: ${r.date}`,
                r.files_json && r.files_json !== '[]'
                    ? `Files: ${JSON.parse(String(r.files_json)).join(', ')}`
                    : '',
                r.diff ? `Changes:\n${String(r.diff).slice(0, 2000)}` : '',
            ].filter(Boolean).join('\n'),
        };
    }

    stats(): Record<string, number> {
        return {
            commits:      (this.db.prepare('SELECT COUNT(*) as c FROM git_commits').get() as { c: number }).c,
            filesTracked: (this.db.prepare('SELECT COUNT(DISTINCT file_path) as c FROM commit_files').get() as { c: number }).c,
            coEdits:      (this.db.prepare('SELECT COUNT(*) as c FROM co_edits').get() as { c: number }).c,
            hnswSize:     this.hnsw.size,
        };
    }
}

/** Create a git history plugin. */
export function git(opts?: GitPluginOptions): Plugin {
    return new GitPlugin(opts);
}

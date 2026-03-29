/**
 * BrainBank — Git Module
 * 
 * Git history indexing with co-edit relationships.
 * 
 *   import { git } from 'brainbank/git';
 *   brain.use(git({ depth: 500 }));
 *   
 *   // Multi-repo: namespace to avoid key collisions
 *   brain
 *     .use(git({ repoPath: './frontend', name: 'git:frontend' }))
 *     .use(git({ repoPath: './backend',  name: 'git:backend' }));
 */

import type { Plugin, PluginContext } from '@/indexers/base.ts';
import { expose } from '@/indexers/base.ts';
import type { HNSWIndex } from '@/providers/vector/hnsw-index.ts';
import type { Database } from '@/db/database.ts';
import { GitIndexer } from './git-indexer.ts';
import { CoEditAnalyzer } from './co-edit-analyzer.ts';
import type { EmbeddingProvider, IndexResult, ProgressCallback, CoEditSuggestion } from '@/types.ts';

export interface GitPluginOptions {
    /** Repository path. Default: from config */
    repoPath?: string;
    /** Max commits to index. Default: from config */
    depth?: number;
    /** Max diff bytes. Default: from config */
    maxDiffBytes?: number;
    /** Custom indexer name for multi-repo (e.g. 'git:frontend'). Default: 'git' */
    name?: string;
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
        this.name = opts.name ?? 'git';
    }

    async initialize(ctx: PluginContext): Promise<void> {
        this.db = ctx.db;
        const embedding = this.opts.embeddingProvider ?? ctx.embedding;

        // Use shared HNSW so all git indexers share one index
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

    @expose
    suggestCoEdits(filePath: string, limit: number = 5): CoEditSuggestion[] {
        return this.coEdits.suggest(filePath, limit);
    }

    /** Get git history for a specific file. */
    @expose
    fileHistory(filePath: string, limit: number = 20): any[] {
        return this.db.prepare(`
            SELECT c.short_hash, c.message, c.author, c.date, c.additions, c.deletions
            FROM git_commits c
            INNER JOIN commit_files cf ON c.id = cf.commit_id
            WHERE cf.file_path LIKE ? AND c.is_merge = 0
            ORDER BY c.timestamp DESC LIMIT ?
        `).all(`%${filePath}%`, limit) as any[];
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

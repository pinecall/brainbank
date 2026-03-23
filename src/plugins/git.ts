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

import type { BrainBankModule, ModuleContext } from './types.ts';
import type { HNSWIndex } from '../vector/hnsw.ts';
import { GitIndexer } from '../indexers/git-indexer.ts';
import { CoEditAnalyzer } from '../indexers/co-edits.ts';
import type { IndexResult, ProgressCallback, CoEditSuggestion } from '../types.ts';

export interface GitModuleOptions {
    /** Repository path. Default: from config */
    repoPath?: string;
    /** Max commits to index. Default: from config */
    depth?: number;
    /** Max diff bytes. Default: from config */
    maxDiffBytes?: number;
    /** Custom indexer name for multi-repo (e.g. 'git:frontend'). Default: 'git' */
    name?: string;
}

class GitModuleImpl implements BrainBankModule {
    readonly name: string;
    hnsw!: HNSWIndex;
    indexer!: GitIndexer;
    coEdits!: CoEditAnalyzer;
    vecCache = new Map<number, Float32Array>();

    constructor(private opts: GitModuleOptions = {}) {
        this.name = opts.name ?? 'git';
    }

    async initialize(ctx: ModuleContext): Promise<void> {
        // Use shared HNSW so all git indexers share one index
        const shared = await ctx.getOrCreateSharedHnsw('git', 500_000);
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
            embedding: ctx.embedding,
        }, this.opts.maxDiffBytes ?? ctx.config.maxDiffBytes);

        this.coEdits = new CoEditAnalyzer(ctx.db);
    }

    async index(options: {
        depth?: number;
        onProgress?: ProgressCallback;
    } = {}): Promise<IndexResult> {
        return this.indexer.index(options);
    }

    suggest(filePath: string, limit: number = 5): CoEditSuggestion[] {
        return this.coEdits.suggest(filePath, limit);
    }

    stats(): Record<string, any> {
        return { hnswSize: this.hnsw.size };
    }
}

/** Create a git history module. */
export function git(opts?: GitModuleOptions): BrainBankModule {
    return new GitModuleImpl(opts);
}

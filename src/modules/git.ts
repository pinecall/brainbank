/**
 * BrainBank — Git Module
 * 
 * Git history indexing with co-edit relationships.
 * 
 *   import { git } from 'brainbank/git';
 *   brain.use(git({ depth: 500 }));
 */

import type { BrainBankModule, ModuleContext } from './types.ts';
import type { HNSWIndex } from '../vector/hnsw.ts';
import { GitIndexer } from '../indexers/git-indexer.ts';
import { CoEditAnalyzer } from '../query/co-edits.ts';
import type { IndexResult, ProgressCallback, CoEditSuggestion } from '../types.ts';

export interface GitModuleOptions {
    /** Repository path. Default: from config */
    repoPath?: string;
    /** Max commits to index. Default: from config */
    depth?: number;
    /** Max diff bytes. Default: from config */
    maxDiffBytes?: number;
}

class GitModuleImpl implements BrainBankModule {
    readonly name = 'git';
    hnsw!: HNSWIndex;
    indexer!: GitIndexer;
    coEdits!: CoEditAnalyzer;
    vecCache = new Map<number, Float32Array>();

    constructor(private opts: GitModuleOptions = {}) {}

    async initialize(ctx: ModuleContext): Promise<void> {
        this.hnsw = await ctx.createHnsw(500_000);
        ctx.loadVectors('git_vectors', 'commit_id', this.hnsw, this.vecCache);

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

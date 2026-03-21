/**
 * BrainBank — Code Module
 * 
 * Language-aware code indexing for 30+ languages.
 * 
 *   import { BrainBank } from 'brainbank';
 *   import { code } from 'brainbank/code';
 *   
 *   const brain = new BrainBank().use(code({ repoPath: '.' }));
 */

import type { BrainBankModule, ModuleContext } from './types.ts';
import type { HNSWIndex } from '../vector/hnsw.ts';
import { CodeIndexer } from '../indexers/code-indexer.ts';
import type { IndexResult, ProgressCallback } from '../types.ts';

export interface CodeModuleOptions {
    /** Repository path to index. Default: '.' */
    repoPath?: string;
    /** Maximum file size in bytes. Default: from config */
    maxFileSize?: number;
}

class CodeModuleImpl implements BrainBankModule {
    readonly name = 'code';
    hnsw!: HNSWIndex;
    indexer!: CodeIndexer;
    vecCache = new Map<number, Float32Array>();

    constructor(private opts: CodeModuleOptions = {}) {}

    async initialize(ctx: ModuleContext): Promise<void> {
        this.hnsw = await ctx.createHnsw();
        ctx.loadVectors('code_vectors', 'chunk_id', this.hnsw, this.vecCache);

        const repoPath = this.opts.repoPath ?? ctx.config.repoPath;
        this.indexer = new CodeIndexer(repoPath, {
            db: ctx.db,
            hnsw: this.hnsw,
            vectorCache: this.vecCache,
            embedding: ctx.embedding,
        }, this.opts.maxFileSize ?? ctx.config.maxFileSize);
    }

    async index(options: {
        forceReindex?: boolean;
        onProgress?: ProgressCallback;
    } = {}): Promise<IndexResult> {
        return this.indexer.index(options);
    }

    stats(): Record<string, any> {
        return { hnswSize: this.hnsw.size };
    }
}

/** Create a code indexing module. */
export function code(opts?: CodeModuleOptions): BrainBankModule {
    return new CodeModuleImpl(opts);
}

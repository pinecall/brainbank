/**
 * BrainBank — Code Module
 * 
 * Language-aware code indexing for 30+ languages.
 * 
 *   import { BrainBank } from 'brainbank';
 *   import { code } from 'brainbank/code';
 *   
 *   const brain = new BrainBank().use(code({ repoPath: '.' }));
 *   
 *   // Multi-repo: namespace to avoid key collisions
 *   brain
 *     .use(code({ repoPath: './frontend', name: 'code:frontend' }))
 *     .use(code({ repoPath: './backend',  name: 'code:backend' }));
 */

import type { Indexer, IndexerContext } from '@/indexers/base.ts';
import type { HNSWIndex } from '@/providers/vector/hnsw-index.ts';
import type { Database } from '@/db/database.ts';
import { CodeWalker } from './code-indexer.ts';
import type { IndexResult, ProgressCallback } from '@/types.ts';

export interface CodePluginOptions {
    /** Repository path to index. Default: '.' */
    repoPath?: string;
    /** Maximum file size in bytes. Default: from config */
    maxFileSize?: number;
    /** Custom indexer name for multi-repo (e.g. 'code:frontend'). Default: 'code' */
    name?: string;
}

class CodePlugin implements Indexer {
    readonly name: string;
    private db!: Database;
    hnsw!: HNSWIndex;
    indexer!: CodeWalker;
    vecCache = new Map<number, Float32Array>();

    constructor(private opts: CodePluginOptions = {}) {
        this.name = opts.name ?? 'code';
    }

    async initialize(ctx: IndexerContext): Promise<void> {
        this.db = ctx.db;
        // Use shared HNSW so all code indexers (code, code:frontend, etc.) share one index
        const shared = await ctx.getOrCreateSharedHnsw('code');
        this.hnsw = shared.hnsw;
        this.vecCache = shared.vecCache;

        // Only load vectors once (first code indexer to initialize)
        if (shared.isNew) {
            ctx.loadVectors('code_vectors', 'chunk_id', this.hnsw, this.vecCache);
        }

        const repoPath = this.opts.repoPath ?? ctx.config.repoPath;
        this.indexer = new CodeWalker(repoPath, {
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

    stats(): Record<string, number> {
        return {
            files:    (this.db.prepare('SELECT COUNT(DISTINCT file_path) as c FROM code_chunks').get() as { c: number }).c,
            chunks:   (this.db.prepare('SELECT COUNT(*) as c FROM code_chunks').get() as { c: number }).c,
            hnswSize: this.hnsw.size,
        };
    }
}

/** Create a code indexing plugin. */
export function code(opts?: CodePluginOptions): Indexer {
    return new CodePlugin(opts);
}

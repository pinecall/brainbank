/**
 * @brainbank/code — Code Plugin
 * 
 * Language-aware code indexing for 20+ languages.
 * 
 *   import { BrainBank } from 'brainbank';
 *   import { code } from '@brainbank/code';
 *   
 *   const brain = new BrainBank().use(code({ repoPath: '.' }));
 *   
 *   // Multi-repo: namespace to avoid key collisions
 *   brain
 *     .use(code({ repoPath: './frontend', name: 'code:frontend' }))
 *     .use(code({ repoPath: './backend',  name: 'code:backend' }));
 */

import type { Plugin, PluginContext, EmbeddingProvider, IndexResult, ProgressCallback, ReembedTable } from 'brainbank';
import type { HNSWIndex } from 'brainbank';
import { CodeWalker } from './code-walker.js';

// Re-export Database type locally for class property
type Database = PluginContext['db'];

export interface CodePluginOptions {
    /** Repository path to index. Default: '.' */
    repoPath?: string;
    /** Maximum file size in bytes. Default: from config */
    maxFileSize?: number;
    /** Glob patterns to ignore (e.g. sdk/**, *.generated.ts). Applied on top of built-in ignores. */
    ignore?: string[];
    /** Custom indexer name for multi-repo (e.g. 'code:frontend'). Default: 'code' */
    name?: string;
    /** Per-plugin embedding provider. Default: global embedding from BrainBank config. */
    embeddingProvider?: EmbeddingProvider;
}

class CodePlugin implements Plugin {
    readonly name: string;
    private db!: Database;
    hnsw!: HNSWIndex;
    indexer!: CodeWalker;
    vecCache = new Map<number, Float32Array>();

    constructor(private opts: CodePluginOptions = {}) {
        this.name = opts.name ?? 'code';
    }

    async initialize(ctx: PluginContext): Promise<void> {
        this.db = ctx.db;
        const embedding = this.opts.embeddingProvider ?? ctx.embedding;

        // Use shared HNSW so all code indexers (code, code:frontend, etc.) share one index
        const shared = await ctx.getOrCreateSharedHnsw('code', undefined, embedding.dims);
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
            embedding,
        }, this.opts.maxFileSize ?? ctx.config.maxFileSize, this.opts.ignore);
    }

    async index(options: {
        forceReindex?: boolean;
        onProgress?: ProgressCallback;
    } = {}): Promise<IndexResult> {
        return this.indexer.index(options);
    }

    /** Table descriptor for re-embedding code vectors from DB rows. */
    reembedConfig(): ReembedTable {
        return {
            name: 'code',
            textTable: 'code_chunks',
            vectorTable: 'code_vectors',
            idColumn: 'id',
            fkColumn: 'chunk_id',
            textBuilder: (r) => [
                `File: ${r.file_path}`,
                r.name ? `${r.chunk_type}: ${r.name}` : String(r.chunk_type),
                String(r.content),
            ].join('\n'),
        };
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
export function code(opts?: CodePluginOptions): Plugin {
    return new CodePlugin(opts);
}

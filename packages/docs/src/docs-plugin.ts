/**
 * @brainbank/docs — Docs Plugin
 * 
 * Index any folder of markdown/text files (notes, docs, wikis).
 * Heading-aware smart chunking inspired by qmd.
 * 
 *   import { BrainBank } from 'brainbank';
 *   import { docs } from '@brainbank/docs';
 *   
 *   const brain = new BrainBank().use(docs());
 */

import type { Plugin, PluginContext, EmbeddingProvider, DocumentCollection, SearchResult, ReembedTable, IndexResult } from 'brainbank';
import type { HNSWIndex } from 'brainbank';

import * as path from 'node:path';
import { DocsIndexer } from './docs-indexer.js';
import { DocumentSearch } from './document-search.js';

type Database = PluginContext['db'];

class DocsPlugin implements Plugin {
    readonly name = 'docs';
    hnsw!: HNSWIndex;
    indexer!: DocsIndexer;
    vecCache = new Map<number, Float32Array>();
    private _db!: Database;
    private _search!: DocumentSearch;

    constructor(private opts: { embeddingProvider?: EmbeddingProvider } = {}) {}

    async initialize(ctx: PluginContext): Promise<void> {
        this._db = ctx.db;
        const embedding = this.opts.embeddingProvider ?? ctx.embedding;

        this.hnsw = await ctx.createHnsw(undefined, embedding.dims, 'doc');
        ctx.loadVectors('doc_vectors', 'chunk_id', this.hnsw, this.vecCache);
        this.indexer = new DocsIndexer(ctx.db, embedding, this.hnsw, this.vecCache);
        this._search = new DocumentSearch({
            db: ctx.db,
            embedding,
            hnsw: this.hnsw,
            vecCache: this.vecCache,
            reranker: ctx.config.reranker,
        });
    }

    /** Register a document collection. */
    addCollection(collection: DocumentCollection): void {
        const absPath = path.resolve(collection.path);
        this._db.prepare(`
            INSERT OR REPLACE INTO collections (name, path, pattern, ignore_json, context)
            VALUES (?, ?, ?, ?, ?)
        `).run(
            collection.name,
            absPath,
            collection.pattern ?? '**/*.md',
            JSON.stringify(collection.ignore ?? []),
            collection.context ?? null,
        );
    }

    /** Remove a collection and its indexed data. */
    removeCollection(name: string): void {
        this.indexer.removeCollection(name);
    }

    /** List all registered collections. */
    listCollections(): DocumentCollection[] {
        return (this._db.prepare('SELECT * FROM collections').all() as { name: string; path: string; pattern: string; ignore_json: string; context: string | null }[]).map(row => ({
            name: row.name,
            path: row.path,
            pattern: row.pattern,
            ignore: JSON.parse(row.ignore_json) as string[],
            context: row.context ?? undefined,
        }));
    }

    /**
     * IndexablePlugin implementation — allows docs to participate in brain.index().
     * Delegates to indexDocs() and aggregates per-collection results.
     */
    async index(options?: { forceReindex?: boolean; onProgress?: (msg: string, cur: number, total: number) => void }): Promise<IndexResult> {
        const results = await this.indexDocs({
            onProgress: options?.onProgress
                ? (col, file, cur, total) => options.onProgress!(file, cur, total)
                : undefined,
        });

        let indexed = 0;
        let skipped = 0;
        let chunks = 0;
        for (const stat of Object.values(results)) {
            indexed += stat.indexed;
            skipped += stat.skipped;
            chunks += stat.chunks;
        }

        return { indexed, skipped, chunks };
    }

    /** Index all (or specific) collections. Incremental. */
    async indexDocs(options: {
        collections?: string[];
        onProgress?: (collection: string, file: string, current: number, total: number) => void;
    } = {}): Promise<Record<string, { indexed: number; skipped: number; chunks: number }>> {
        const allCollections = this.listCollections();
        const toIndex = options.collections
            ? allCollections.filter(c => options.collections!.includes(c.name))
            : allCollections;

        const results: Record<string, { indexed: number; skipped: number; chunks: number }> = {};

        for (const coll of toIndex) {
            results[coll.name] = await this.indexer.indexCollection(
                coll.name,
                coll.path,
                coll.pattern,
                {
                    ignore: coll.ignore,
                    onProgress: (file, cur, total) => options.onProgress?.(coll.name, file, cur, total),
                },
            );
        }

        return results;
    }



    /** Search documents using hybrid search (vector + BM25 → RRF). */
    async search(query: string, options?: {
        collection?: string;
        k?: number;
        minScore?: number;
        mode?: 'hybrid' | 'vector' | 'keyword';
    }): Promise<SearchResult[]> {
        return this._search.search(query, options);
    }

    /** Table descriptor for re-embedding doc vectors from DB rows. */
    reembedConfig(): ReembedTable {
        return {
            name: 'docs',
            textTable: 'doc_chunks',
            vectorTable: 'doc_vectors',
            idColumn: 'id',
            fkColumn: 'chunk_id',
            textBuilder: (r) => `title: ${r.title ?? ''} | text: ${r.content}`,
        };
    }

    /** Add context description for a document path. */
    addContext(collection: string, path: string, context: string): void {
        this._db.prepare(`
            INSERT OR REPLACE INTO path_contexts (collection, path, context)
            VALUES (?, ?, ?)
        `).run(collection, path, context);
    }

    /** Remove context for a path. */
    removeContext(collection: string, path: string): void {
        this._db.prepare(
            'DELETE FROM path_contexts WHERE collection = ? AND path = ?'
        ).run(collection, path);
    }

    /** List all context entries. */
    listContexts(): { collection: string; path: string; context: string }[] {
        return this._db.prepare('SELECT * FROM path_contexts').all() as { collection: string; path: string; context: string }[];
    }

    stats(): Record<string, number | string> {
        return {
            collections: (this._db.prepare('SELECT COUNT(*) as c FROM collections').get() as { c: number }).c,
            documents: (this._db.prepare('SELECT COUNT(DISTINCT file_path) as c FROM doc_chunks').get() as { c: number }).c,
            chunks: (this._db.prepare('SELECT COUNT(*) as c FROM doc_chunks').get() as { c: number }).c,
            hnswSize: this.hnsw.size,
        };
    }
}

export interface DocsPluginOptions {
    /** Per-plugin embedding provider. Default: global embedding from BrainBank config. */
    embeddingProvider?: EmbeddingProvider;
}

/** Create a document collections plugin. */
export function docs(opts?: DocsPluginOptions): Plugin {
    return new DocsPlugin(opts);
}

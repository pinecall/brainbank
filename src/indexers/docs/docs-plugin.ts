/**
 * BrainBank — Docs Module
 * 
 * Index any folder of markdown/text files (notes, docs, wikis).
 * Heading-aware smart chunking inspired by qmd.
 * 
 *   import { docs } from 'brainbank/docs';
 *   brain.use(docs());
 */

import type { Plugin, PluginContext } from '@/indexers/base.ts';
import type { HNSWIndex } from '@/providers/vector/hnsw-index.ts';
import type { Database } from '@/db/database.ts';
import type { EmbeddingProvider, DocumentCollection, SearchResult } from '@/types.ts';
import { DocsIndexer } from './docs-indexer.ts';
import { DocumentSearch } from './document-search.ts';

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

        this.hnsw = await ctx.createHnsw(undefined, embedding.dims);
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
        this._db.prepare(`
            INSERT OR REPLACE INTO collections (name, path, pattern, ignore_json, context)
            VALUES (?, ?, ?, ?, ?)
        `).run(
            collection.name,
            collection.path,
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
        return (this._db.prepare('SELECT * FROM collections').all() as any[]).map(row => ({
            name: row.name,
            path: row.path,
            pattern: row.pattern,
            ignore: JSON.parse(row.ignore_json),
            context: row.context,
        }));
    }

    /** Index all (or specific) collections. Incremental. */
    async indexCollections(options: {
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
        return this._db.prepare('SELECT * FROM path_contexts').all() as any[];
    }

    stats(): Record<string, any> {
        return {
            collections: (this._db.prepare('SELECT COUNT(*) as c FROM collections').get() as any).c,
            documents: (this._db.prepare('SELECT COUNT(DISTINCT file_path) as c FROM doc_chunks').get() as any).c,
            chunks: (this._db.prepare('SELECT COUNT(*) as c FROM doc_chunks').get() as any).c,
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

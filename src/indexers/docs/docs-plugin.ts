/**
 * BrainBank — Docs Module
 * 
 * Index any folder of markdown/text files (notes, docs, wikis).
 * Heading-aware smart chunking inspired by qmd.
 * 
 *   import { docs } from 'brainbank/docs';
 *   brain.use(docs());
 */

import type { Indexer, IndexerContext } from '../base.ts';
import type { HNSWIndex } from '../../providers/vector/hnsw.ts';
import type { Database } from '../../db/database.ts';
import type { EmbeddingProvider, DocumentCollection, SearchResult } from '../../types.ts';
import { DocsIndexer } from './docs-indexer.ts';

class DocsPlugin implements Indexer {
    readonly name = 'docs';
    hnsw!: HNSWIndex;
    indexer!: DocsIndexer;
    vecCache = new Map<number, Float32Array>();
    private _db!: Database;
    private _embedding!: EmbeddingProvider;

    async initialize(ctx: IndexerContext): Promise<void> {
        this._db = ctx.db;
        this._embedding = ctx.embedding;
        this.hnsw = await ctx.createHnsw();
        ctx.loadVectors('doc_vectors', 'chunk_id', this.hnsw, this.vecCache);
        this.indexer = new DocsIndexer(ctx.db, ctx.embedding, this.hnsw, this.vecCache);
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

    /** Search documents only. */
    async search(query: string, options?: {
        collection?: string;
        k?: number;
        minScore?: number;
    }): Promise<SearchResult[]> {
        const k = options?.k ?? 8;
        const queryVec = await this._embedding.embed(query);

        // Over-fetch from shared HNSW when filtering by collection
        // (same pattern as collection.ts ratio scaling)
        let searchK = k;
        if (options?.collection && this.hnsw.size > 0) {
            const collectionCount = (this._db.prepare(
                'SELECT COUNT(*) as c FROM doc_chunks WHERE collection = ?'
            ).get(options.collection) as any)?.c ?? 0;
            const totalChunks = (this._db.prepare(
                'SELECT COUNT(*) as c FROM doc_chunks'
            ).get() as any)?.c ?? 1;
            const ratio = collectionCount > 0
                ? Math.max(3, Math.min(50, Math.ceil(totalChunks / collectionCount)))
                : 3;
            searchK = Math.min(k * ratio, this.hnsw.size);
        }

        const hits = this.hnsw.search(queryVec, searchK);

        const results: SearchResult[] = [];
        for (const hit of hits) {
            if (options?.minScore && hit.score < options.minScore) continue;

            const chunk = this._db.prepare(
                'SELECT * FROM doc_chunks WHERE id = ?'
            ).get(hit.id) as any;

            if (!chunk) continue;
            if (options?.collection && chunk.collection !== options.collection) continue;

            const ctx = this._getDocContext(chunk.collection, chunk.file_path);

            results.push({
                type: 'document',
                score: hit.score,
                filePath: chunk.file_path,
                content: chunk.content,
                context: ctx,
                metadata: {
                    collection: chunk.collection,
                    title: chunk.title,
                    seq: chunk.seq,
                },
            });

            // Stop once we have enough results
            if (results.length >= k) break;
        }

        return results;
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

    /** Resolve context for a document (checks path_contexts tree → collection context). */
    private _getDocContext(collection: string, filePath: string): string | undefined {
        const parts = filePath.split('/');
        for (let i = parts.length; i >= 0; i--) {
            const checkPath = i === 0 ? '/' : '/' + parts.slice(0, i).join('/');
            const ctx = this._db.prepare(
                'SELECT context FROM path_contexts WHERE collection = ? AND path = ?'
            ).get(collection, checkPath) as any;
            if (ctx) return ctx.context;
        }

        const coll = this._db.prepare(
            'SELECT context FROM collections WHERE name = ?'
        ).get(collection) as any;
        return coll?.context ?? undefined;
    }
}

/** Create a document collections plugin. */
export function docs(): Indexer {
    return new DocsPlugin();
}

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
import { runPluginMigrations, sanitizeFTS, normalizeBM25 } from 'brainbank';

import * as path from 'node:path';
import { DocsIndexer } from './docs-indexer.js';
import { DocsVectorSearch } from './docs-vector-search.js';
import { DocumentSearch } from './document-search.js';
import { DOCS_SCHEMA_VERSION, DOCS_MIGRATIONS } from './docs-schema.js';

type Database = PluginContext['db'];

/** Check if an error is an FTS5 query syntax error (expected, safe to ignore). */
function isFTSError(e: unknown): boolean {
    return e instanceof Error && /fts5|syntax error|parse error/i.test(e.message);
}

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
        runPluginMigrations(ctx.db, 'docs', DOCS_SCHEMA_VERSION, DOCS_MIGRATIONS);
        const embedding = this.opts.embeddingProvider ?? ctx.embedding;

        // Use shared HNSW so docs participates in CompositeVectorSearch
        const shared = await ctx.getOrCreateSharedHnsw('docs', undefined, embedding.dims);
        this.hnsw = shared.hnsw;
        this.vecCache = shared.vecCache;

        if (shared.isNew) {
            ctx.loadVectors('doc_vectors', 'chunk_id', this.hnsw, this.vecCache);
        }

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

    /** VectorSearchPlugin — create domain vector search strategy for CompositeVectorSearch. */
    createVectorSearch(): DocsVectorSearch {
        return new DocsVectorSearch({
            db: this._db,
            hnsw: this.hnsw,
        });
    }

    /** BM25SearchPlugin — FTS5 keyword search across doc chunks. */
    searchBM25(query: string, k: number, minScore?: number): SearchResult[] {
        const ftsQuery = this._buildDocsFTS(query);
        if (!ftsQuery) return [];

        const threshold = minScore ?? 0;

        try {
            const rows = this._db.prepare(`
                SELECT d.*, bm25(fts_docs, 10.0, 2.0, 5.0, 1.0) AS bm25_score
                FROM fts_docs f
                JOIN doc_chunks d ON d.id = f.rowid
                WHERE fts_docs MATCH ?
                ORDER BY bm25_score ASC
                LIMIT ?
            `).all(ftsQuery, k * 2) as (Record<string, unknown> & { bm25_score: number })[];

            return rows
                .map(r => ({
                    type: 'document' as const,
                    score: normalizeBM25(r.bm25_score),
                    filePath: r.file_path as string,
                    content: r.content as string,
                    context: this._getDocContext(r.collection as string, r.file_path as string),
                    metadata: {
                        collection: r.collection as string,
                        title: r.title as string,
                        seq: r.seq as number,
                        chunkId: r.id as number,
                        searchType: 'bm25',
                    },
                }))
                .filter(r => r.score >= threshold)
                .slice(0, k);
        } catch (e) {
            if (!isFTSError(e)) throw e;
            return [];
        }
    }

    /** Rebuild the FTS5 index from the content table. */
    rebuildFTS(): void {
        try {
            this._db.prepare("INSERT INTO fts_docs(fts_docs) VALUES('rebuild')").run();
        } catch { /* non-fatal */ }
    }

    /** ContextFormatterPlugin — format document results for LLM context. */
    formatContext(results: SearchResult[], parts: string[]): void {
        const docHits = results.filter(r => r.type === 'document');
        if (docHits.length === 0) return;

        parts.push('## Documents\n');
        for (const r of docHits) {
            const meta = r.metadata as Record<string, unknown> | undefined;
            const title = meta?.title as string | undefined;
            const collection = meta?.collection as string | undefined;

            const header = title
                ? `**${title}** (${collection ?? 'docs'})`
                : `${r.filePath ?? 'document'} (${collection ?? 'docs'})`;

            parts.push(`### ${header}`);
            parts.push(`Score: ${Math.round(r.score * 100)}%`);
            parts.push('');
            parts.push(r.content);
            parts.push('');
        }
    }

    /** SearchablePlugin — direct hybrid search with per-collection filtering. */
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

    /** Build OR-mode FTS5 query for natural language doc search. */
    private _buildDocsFTS(query: string): string {
        const fts = sanitizeFTS(query);
        if (!fts) return '';
        return fts;
    }

    /** Resolve context for a document (checks path_contexts tree → collection context). */
    private _getDocContext(collection: string, filePath: string): string | undefined {
        const parts = filePath.split('/');
        for (let i = parts.length; i >= 0; i--) {
            const checkPath = i === 0 ? '/' : '/' + parts.slice(0, i).join('/');
            const ctx = this._db.prepare(
                'SELECT context FROM path_contexts WHERE collection = ? AND path = ?'
            ).get(collection, checkPath) as { context: string } | undefined;
            if (ctx) return ctx.context;
        }

        const coll = this._db.prepare(
            'SELECT context FROM collections WHERE name = ?'
        ).get(collection) as { context: string | null } | undefined;
        return coll?.context ?? undefined;
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

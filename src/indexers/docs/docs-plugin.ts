/**
 * BrainBank — Docs Module
 * 
 * Index any folder of markdown/text files (notes, docs, wikis).
 * Heading-aware smart chunking inspired by qmd.
 * 
 *   import { docs } from 'brainbank/docs';
 *   brain.use(docs());
 */

import type { Indexer, IndexerContext } from '@/indexers/base.ts';
import type { HNSWIndex } from '@/providers/vector/hnsw-index.ts';
import type { Database } from '@/db/database.ts';
import type { EmbeddingProvider, DocumentCollection, SearchResult } from '@/types.ts';
import { reciprocalRankFusion } from '@/lib/rrf.ts';
import { sanitizeFTS, normalizeBM25 } from '@/lib/fts.ts';
import { DocsIndexer } from './docs-indexer.ts';
import type { ChunkEnrichment } from './chunk-enrichment.ts';

export type { ChunkEnrichment, ChunkContext } from './chunk-enrichment.ts';
export { noneEnrichment, summaryEnrichment } from './chunk-enrichment.ts';

/** Options for the docs plugin. */
export interface DocsOptions {
    /** Chunk enrichment strategy for embeddings. Default: noneEnrichment() */
    enrichment?: ChunkEnrichment;
}

class DocsPlugin implements Indexer {
    readonly name = 'docs';
    hnsw!: HNSWIndex;
    indexer!: DocsIndexer;
    vecCache = new Map<number, Float32Array>();
    private _db!: Database;
    private _embedding!: EmbeddingProvider;
    private _enrichment?: ChunkEnrichment;

    constructor(options?: DocsOptions) {
        this._enrichment = options?.enrichment;
    }

    async initialize(ctx: IndexerContext): Promise<void> {
        this._db = ctx.db;
        this._embedding = ctx.embedding;
        this.hnsw = await ctx.createHnsw();
        ctx.loadVectors('doc_vectors', 'chunk_id', this.hnsw, this.vecCache);
        this.indexer = new DocsIndexer(ctx.db, ctx.embedding, this.hnsw, this.vecCache, this._enrichment);
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
        const k = options?.k ?? 8;
        const mode = options?.mode ?? 'hybrid';

        if (mode === 'keyword') return this._dedup(this._searchBM25(query, k * 2, options?.minScore ?? 0, options?.collection), k);
        if (mode === 'vector') return this._dedup(await this._searchVector(query, k * 2, options?.minScore ?? 0, options?.collection), k);

        // Hybrid: over-fetch from both, fuse with RRF, then dedup by file
        const fetchK = k * 2;
        const [vecHits, bm25Hits] = await Promise.all([
            this._searchVector(query, fetchK, 0, options?.collection),
            Promise.resolve(this._searchBM25(query, fetchK, 0, options?.collection)),
        ]);

        if (vecHits.length === 0 && bm25Hits.length === 0) return [];
        if (bm25Hits.length === 0) return this._dedup(vecHits.filter(h => h.score >= (options?.minScore ?? 0)), k);
        if (vecHits.length === 0) return this._dedup(bm25Hits.filter(h => h.score >= (options?.minScore ?? 0)), k);

        const fused = reciprocalRankFusion([vecHits, bm25Hits]);

        // Map fused results back to doc SearchResults
        const allById = new Map<number, SearchResult>();
        for (const h of [...vecHits, ...bm25Hits]) {
            const id = (h.metadata as any)?.chunkId;
            if (id != null) allById.set(id, h);
        }

        const results: SearchResult[] = [];
        for (const r of fused) {
            const chunkId = (r.metadata as any)?.chunkId;
            const original = allById.get(chunkId);
            if (!original) continue;
            const merged = { ...original, score: r.score };
            if (merged.score >= (options?.minScore ?? 0)) results.push(merged);
        }

        return this._dedup(results, k);
    }

    /** Deduplicate results by file path — keep best-scoring chunk per file. */
    private _dedup(results: SearchResult[], k: number): SearchResult[] {
        const seen = new Map<string, SearchResult>();
        for (const r of results) {
            const key = r.filePath ?? '';
            if (!seen.has(key) || (seen.get(key)!.score < r.score)) {
                seen.set(key, r);
            }
        }
        return [...seen.values()]
            .sort((a, b) => b.score - a.score)
            .slice(0, k);
    }

    /** Vector-only search via HNSW. */
    private async _searchVector(query: string, k: number, minScore: number, collection?: string): Promise<SearchResult[]> {
        if (this.hnsw.size === 0) return [];
        const queryVec = await this._embedding.embed(query);

        let searchK = k;
        if (collection && this.hnsw.size > 0) {
            const collectionCount = (this._db.prepare(
                'SELECT COUNT(*) as c FROM doc_chunks WHERE collection = ?'
            ).get(collection) as any)?.c ?? 0;
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
            if (minScore && hit.score < minScore) continue;
            const chunk = this._db.prepare('SELECT * FROM doc_chunks WHERE id = ?').get(hit.id) as any;
            if (!chunk) continue;
            if (collection && chunk.collection !== collection) continue;

            results.push({
                type: 'document',
                score: hit.score,
                filePath: chunk.file_path,
                content: chunk.content,
                context: this._getDocContext(chunk.collection, chunk.file_path),
                metadata: {
                    collection: chunk.collection,
                    title: chunk.title,
                    seq: chunk.seq,
                    chunkId: chunk.id,
                },
            });

            if (results.length >= k) break;
        }

        return results;
    }

    /** BM25 keyword search via FTS5 (OR-mode for natural language). */
    private _searchBM25(query: string, k: number, minScore: number, collection?: string): SearchResult[] {
        const ftsQuery = this._buildDocsFTS(query);
        if (!ftsQuery) return [];

        try {
            const collectionFilter = collection ? 'AND d.collection = ?' : '';
            const params: any[] = [ftsQuery];
            if (collection) params.push(collection);
            params.push(k * 2);

            const rows = this._db.prepare(`
                SELECT d.*, bm25(fts_docs, 10.0, 2.0, 5.0, 1.0) AS bm25_score
                FROM fts_docs f
                JOIN doc_chunks d ON d.id = f.rowid
                WHERE fts_docs MATCH ? ${collectionFilter}
                ORDER BY bm25_score ASC
                LIMIT ?
            `).all(...params) as any[];

            return rows
                .map(r => ({
                    type: 'document' as const,
                    score: normalizeBM25(r.bm25_score),
                    filePath: r.file_path,
                    content: r.content,
                    context: this._getDocContext(r.collection, r.file_path),
                    metadata: {
                        collection: r.collection,
                        title: r.title,
                        seq: r.seq,
                        chunkId: r.id,
                    },
                }))
                .filter(r => r.score >= minScore)
                .slice(0, k);
        } catch {
            return [];
        }
    }

    /** Build OR-mode FTS5 query for natural language doc search. */
    private _buildDocsFTS(query: string): string {
        const STOP_WORDS = new Set([
            'the', 'is', 'at', 'which', 'on', 'a', 'an', 'and', 'or', 'but',
            'in', 'with', 'to', 'for', 'of', 'by', 'from', 'as', 'it', 'its',
            'this', 'that', 'be', 'are', 'was', 'were', 'been', 'has', 'have',
            'had', 'do', 'does', 'did', 'can', 'could', 'will', 'would', 'how',
            'what', 'when', 'where', 'who', 'why', 'not', 'no', 'so', 'if',
        ]);

        const clean = query
            .replace(/[{}[\]()^~*:"]/g, ' ')
            .replace(/\bAND\b|\bOR\b|\bNOT\b|\bNEAR\b/gi, '')
            .replace(/[_\-./\\]/g, ' ')
            .trim();

        const words = clean.split(/\s+/)
            .filter(w => w.length >= 3 && !STOP_WORDS.has(w.toLowerCase()));

        if (words.length === 0) return '';
        return words.map(w => `"${w}"`).join(' OR ');
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
export function docs(options?: DocsOptions): Indexer {
    return new DocsPlugin(options);
}

/**
 * BrainBank — Collection
 * 
 * Universal key-value store with vector + BM25 hybrid search.
 * The foundation primitive — store anything, search semantically.
 * 
 *   const errors = brain.collection('debug_errors');
 *   await errors.add('Fixed null check in api handler', { file: 'api.ts' });
 *   const hits = await errors.search('null pointer');
 */

import type { Database } from './database.ts';
import type { EmbeddingProvider, Reranker } from '../types.ts';
import type { HNSWIndex } from '../vector/hnsw.ts';
import { reciprocalRankFusion } from '../query/rrf.ts';
import { sanitizeFTS, normalizeBM25 } from '../query/fts-utils.ts';

export interface CollectionItem {
    id: number;
    collection: string;
    content: string;
    metadata: Record<string, any>;
    tags: string[];
    createdAt: number;
    expiresAt?: number;
    score?: number;
}

export interface CollectionSearchOptions {
    /** Max results. Default: 5 */
    k?: number;
    /** Search mode. Default: 'hybrid' */
    mode?: 'hybrid' | 'vector' | 'keyword';
    /** Minimum score threshold. Default: 0.15 */
    minScore?: number;
    /** Filter by tags (item must have ALL specified tags). */
    tags?: string[];
}

export interface CollectionAddOptions {
    /** Metadata key-value pairs. */
    metadata?: Record<string, any>;
    /** Tags for filtering. */
    tags?: string[];
    /** Time-to-live duration string (e.g. '7d', '24h', '30m'). */
    ttl?: string;
}

export class Collection {
    constructor(
        private _name: string,
        private _db: Database,
        private _embedding: EmbeddingProvider,
        private _hnsw: HNSWIndex,
        private _vecs: Map<number, Float32Array>,
        private _reranker?: Reranker,
    ) {}

    /** Collection name. */
    get name(): string { return this._name; }

    /** Add an item. Returns its ID. */
    async add(content: string, options: CollectionAddOptions | Record<string, any> = {}): Promise<number> {
        // Support legacy signature: add(content, metadata)
        const opts = 'tags' in options || 'ttl' in options || 'metadata' in options
            ? options as CollectionAddOptions
            : { metadata: options as Record<string, any> };

        const metadata = opts.metadata ?? {};
        const tags = opts.tags ?? [];
        const expiresAt = opts.ttl ? Math.floor(Date.now() / 1000) + parseDuration(opts.ttl) : null;

        const result = this._db.prepare(
            'INSERT INTO kv_data (collection, content, meta_json, tags_json, expires_at) VALUES (?, ?, ?, ?, ?)'
        ).run(this._name, content, JSON.stringify(metadata), JSON.stringify(tags), expiresAt);

        const id = Number(result.lastInsertRowid);

        const vec = await this._embedding.embed(content);
        this._db.prepare(
            'INSERT INTO kv_vectors (data_id, embedding) VALUES (?, ?)'
        ).run(id, Buffer.from(vec.buffer));

        this._hnsw.add(vec, id);
        this._vecs.set(id, vec);

        return id;
    }

    /** Add multiple items. Returns their IDs. */
    async addMany(items: { content: string; metadata?: Record<string, any>; tags?: string[]; ttl?: string }[]): Promise<number[]> {
        const ids: number[] = [];
        for (const item of items) {
            ids.push(await this.add(item.content, {
                metadata: item.metadata,
                tags: item.tags,
                ttl: item.ttl,
            }));
        }
        return ids;
    }

    /** Search this collection. */
    async search(query: string, options: CollectionSearchOptions = {}): Promise<CollectionItem[]> {
        const { k = 5, mode = 'hybrid', minScore = 0.15, tags } = options;

        // Auto-prune expired items before search
        this._pruneExpired();

        if (mode === 'keyword') return this._filterByTags(this._searchBM25(query, k, minScore), tags);
        if (mode === 'vector') return this._filterByTags(await this._searchVector(query, k, minScore), tags);

        // Hybrid: vector + BM25 → RRF
        const [vectorHits, bm25Hits] = await Promise.all([
            this._searchVector(query, k, 0),
            Promise.resolve(this._searchBM25(query, k, 0)),
        ]);

        const fused = reciprocalRankFusion([
            vectorHits.map(h => ({ type: 'document' as const, score: h.score ?? 0, content: h.content, metadata: { id: h.id } })),
            bm25Hits.map(h => ({ type: 'document' as const, score: h.score ?? 0, content: h.content, metadata: { id: h.id } })),
        ]);

        const allById = new Map<number, CollectionItem>();
        for (const h of [...vectorHits, ...bm25Hits]) allById.set(h.id, h);

        const results: CollectionItem[] = [];
        for (const r of fused) {
            const item = allById.get(r.metadata.id);
            if (!item) continue;
            const scored = { ...item, score: r.score };
            if (scored.score >= minScore) results.push(scored);
            if (results.length >= k) break;
        }

        // Apply re-ranking if available
        if (this._reranker && results.length > 1) {
            const documents = results.map(r => r.content);
            const scores = await this._reranker.rank(query, documents);
            const blended = results.map((r, i) => ({
                ...r,
                score: 0.6 * (r.score ?? 0) + 0.4 * (scores[i] ?? 0),
            }));
            return this._filterByTags(
                blended.sort((a, b) => (b.score ?? 0) - (a.score ?? 0)),
                tags,
            );
        }

        return this._filterByTags(results, tags);
    }

    /** List items (newest first). */
    list(options: { limit?: number; offset?: number; tags?: string[] } = {}): CollectionItem[] {
        const { limit = 20, offset = 0, tags } = options;

        // Auto-prune expired items
        this._pruneExpired();

        const rows = this._db.prepare(
            'SELECT * FROM kv_data WHERE collection = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?'
        ).all(this._name, Math.floor(Date.now() / 1000), limit, offset) as any[];
        return this._filterByTags(rows.map(r => this._rowToItem(r)), tags);
    }

    /** Count items in this collection. */
    count(): number {
        return (this._db.prepare(
            'SELECT COUNT(*) as c FROM kv_data WHERE collection = ?'
        ).get(this._name) as any).c;
    }

    /** Keep only the N most recent items, remove the rest. */
    async trim(options: { keep: number }): Promise<{ removed: number }> {
        const before = this.count();
        if (before <= options.keep) return { removed: 0 };

        // Get IDs to remove (oldest first, beyond the keep window)
        const toRemove = this._db.prepare(`
            SELECT id FROM kv_data 
            WHERE collection = ? 
            ORDER BY created_at DESC, id DESC 
            LIMIT -1 OFFSET ?
        `).all(this._name, options.keep) as any[];

        for (const row of toRemove) {
            this._removeById(row.id);
        }

        return { removed: toRemove.length };
    }

    /** Remove items older than a duration string (e.g. '30d', '12h'). */
    async prune(options: { olderThan: string }): Promise<{ removed: number }> {
        const seconds = parseDuration(options.olderThan);
        const cutoff = Math.floor(Date.now() / 1000) - seconds;

        const toRemove = this._db.prepare(
            'SELECT id FROM kv_data WHERE collection = ? AND created_at < ?'
        ).all(this._name, cutoff) as any[];

        for (const row of toRemove) {
            this._removeById(row.id);
        }

        return { removed: toRemove.length };
    }

    /** Remove a specific item by ID. */
    remove(id: number): void {
        this._removeById(id);
    }

    /** Clear all items in this collection. */
    clear(): void {
        const rows = this._db.prepare(
            'SELECT id FROM kv_data WHERE collection = ?'
        ).all(this._name) as any[];

        for (const row of rows) {
            this._removeById(row.id);
        }
    }

    // ── Private ──────────────────────────────────────

    private _removeById(id: number): void {
        // Remove from HNSW + cache
        this._vecs.delete(id);
        // Remove from DB (cascades to kv_vectors, FTS trigger handles fts_kv)
        this._db.prepare('DELETE FROM kv_data WHERE id = ?').run(id);
    }

    private async _searchVector(query: string, k: number, minScore: number): Promise<CollectionItem[]> {
        if (this._hnsw.size === 0) return [];

        const queryVec = await this._embedding.embed(query);
        // Search across all collections in HNSW, then filter
        const hits = this._hnsw.search(queryVec, k * 3);

        const ids = hits.map(h => h.id);
        if (ids.length === 0) return [];

        const scoreMap = new Map(hits.map(h => [h.id, h.score]));
        const placeholders = ids.map(() => '?').join(',');

        const rows = this._db.prepare(
            `SELECT * FROM kv_data WHERE id IN (${placeholders}) AND collection = ?`
        ).all(...ids, this._name) as any[];

        return rows
            .map(r => ({ ...this._rowToItem(r), score: scoreMap.get(r.id) ?? 0 }))
            .filter(r => r.score >= minScore)
            .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
            .slice(0, k);
    }

    private _searchBM25(query: string, k: number, minScore: number): CollectionItem[] {
        const ftsQuery = sanitizeFTS(query);
        if (!ftsQuery) return [];

        try {
            const rows = this._db.prepare(`
                SELECT d.*, bm25(fts_kv, 5.0, 1.0) AS score
                FROM fts_kv f
                JOIN kv_data d ON d.id = f.rowid
                WHERE fts_kv MATCH ? AND d.collection = ?
                ORDER BY score ASC
                LIMIT ?
            `).all(ftsQuery, this._name, k) as any[];

            return rows
                .map(r => ({
                    ...this._rowToItem(r),
                    score: normalizeBM25(r.score),
                }))
                .filter(r => (r.score ?? 0) >= minScore);
        } catch {
            return [];
        }
    }

    private _rowToItem(r: any): CollectionItem {
        return {
            id: r.id,
            collection: r.collection,
            content: r.content,
            metadata: JSON.parse(r.meta_json || '{}'),
            tags: JSON.parse(r.tags_json || '[]'),
            createdAt: r.created_at,
            expiresAt: r.expires_at ?? undefined,
        };
    }

    /** Filter results by tags (item must have ALL specified tags). */
    private _filterByTags(items: CollectionItem[], tags?: string[]): CollectionItem[] {
        if (!tags || tags.length === 0) return items;
        return items.filter(item =>
            tags.every(t => item.tags.includes(t))
        );
    }

    /** Remove expired items (TTL). Called automatically on search/list. */
    private _pruneExpired(): void {
        const now = Math.floor(Date.now() / 1000);
        const expired = this._db.prepare(
            'SELECT id FROM kv_data WHERE collection = ? AND expires_at IS NOT NULL AND expires_at <= ?'
        ).all(this._name, now) as any[];

        for (const row of expired) {
            this._removeById(row.id);
        }
    }
}

/** Parse a duration string like '30d', '12h', '5m' to seconds. */
function parseDuration(s: string): number {
    const match = s.match(/^(\d+)([dhms])$/);
    if (!match) throw new Error(`Invalid duration: "${s}". Use format like '30d', '12h', '5m'.`);

    const n = parseInt(match[1], 10);
    switch (match[2]) {
        case 'd': return n * 86400;
        case 'h': return n * 3600;
        case 'm': return n * 60;
        case 's': return n;
        default: return n;
    }
}

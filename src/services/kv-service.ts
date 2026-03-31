/**
 * BrainBank — KV Service
 *
 * Owns the shared HNSW index and vector cache for KV collections.
 * Provides collection creation, listing, and deletion.
 * Extracted from BrainBank to separate infrastructure from facade.
 */

import type { Database } from '@/db/database.ts';
import type { HNSWIndex } from '@/providers/vector/hnsw-index.ts';
import type { EmbeddingProvider, Reranker } from '@/types.ts';
import { Collection } from './collection.ts';

export class KVService {
    private _collections = new Map<string, Collection>();

    constructor(
        private _db: Database,
        private _embedding: EmbeddingProvider,
        private _hnsw: HNSWIndex,
        private _vecs: Map<number, Float32Array>,
        private _reranker?: Reranker,
    ) {}

    /** Get or create a named collection. */
    collection(name: string): Collection {
        if (this._collections.has(name)) return this._collections.get(name)!;
        const coll = new Collection(name, this._db, this._embedding, this._hnsw, this._vecs, this._reranker);
        this._collections.set(name, coll);
        return coll;
    }

    /** List all collection names that have data. */
    listNames(): string[] {
        return (this._db.prepare('SELECT DISTINCT collection FROM kv_data ORDER BY collection').all() as { collection: string }[])
            .map(r => r.collection);
    }

    /** Delete a collection's data and evict from cache. Removes vectors from HNSW to prevent ghost entries. */
    delete(name: string): void {
        const ids = this._db.prepare(
            'SELECT id FROM kv_data WHERE collection = ?'
        ).all(name) as { id: number }[];

        for (const { id } of ids) {
            this._hnsw.remove(id);
            this._vecs.delete(id);
        }

        this._db.prepare('DELETE FROM kv_data WHERE collection = ?').run(name);
        this._collections.delete(name);
    }

    /** Access the shared HNSW index (used by reembed). */
    get hnsw(): HNSWIndex     { return this._hnsw; }

    /** Access the shared vector cache. @internal */
    get vecs(): Map<number, Float32Array> { return this._vecs; }

    /** Clear all cached collections and vectors. */
    clear(): void {
        this._collections.clear();
        this._vecs.clear();
    }
}

/**
 * BrainBank — HNSW Vector Index
 * 
 * Wraps hnswlib-node for O(log n) approximate nearest neighbor search.
 * M=16 connections, ef=200 construction, ef=50 search by default.
 * 150x faster than brute force at 1M vectors.
 */

import type { VectorIndex, SearchHit } from '../../types.ts';

export class HNSWIndex implements VectorIndex {
    private _index: any = null;
    private _lib: any = null;
    private _ids = new Set<number>();

    constructor(
        private _dims: number,
        private _maxElements: number = 2_000_000,
        private _M: number = 16,
        private _efConstruction: number = 200,
        private _efSearch: number = 50,
    ) {}

    /**
     * Initialize the HNSW index.
     * Must be called before add/search.
     */
    async init(): Promise<this> {
        this._lib = await import('hnswlib-node');
        this._createIndex();
        return this;
    }

    /**
     * Reinitialize the index in-place, clearing all vectors.
     * Required after reembed or full re-index to avoid duplicate IDs.
     * init() must have been called first.
     */
    reinit(): void {
        if (!this._lib) throw new Error('HNSW not initialized — call init() first');
        this._createIndex();
    }

    private _createIndex(): void {
        const HNSW = this._lib.default?.HierarchicalNSW ?? this._lib.HierarchicalNSW;
        this._index = new HNSW('cosine', this._dims);
        this._index.initIndex(this._maxElements, this._M, this._efConstruction);
        this._index.setEf(this._efSearch);
        this._ids = new Set();
    }

    /** Maximum capacity of this index. */
    get maxElements(): number { return this._maxElements; }

    /**
     * Add a vector with an integer ID.
     * The vector should be pre-normalized for cosine distance.
     */
    add(vector: Float32Array, id: number): void {
        if (!this._index) throw new Error('HNSW index not initialized — call init() first');
        if (this._ids.has(id)) return; // idempotent: skip duplicates
        if (this._ids.size >= this._maxElements) {
            throw new Error(
                `HNSW index full (${this._maxElements} elements). ` +
                `Increase maxElements in config or prune old data.`
            );
        }
        this._index.addPoint(Array.from(vector), id);
        this._ids.add(id);
    }

    /**
     * Mark a vector as deleted so it no longer appears in searches.
     * Uses hnswlib-node markDelete under the hood.
     * Safe to call with an ID that doesn't exist.
     */
    remove(id: number): void {
        if (!this._index || this._ids.size === 0) return;
        if (!this._ids.has(id)) return;
        try {
            this._index.markDelete(id);
            this._ids.delete(id);
        } catch {
            // ID not found — ignore silently
        }
    }

    /**
     * Search for the k nearest neighbors.
     * Returns results sorted by score (highest first).
     * Score is 1 - cosine_distance (1.0 = identical).
     */
    search(query: Float32Array, k: number): SearchHit[] {
        if (!this._index || this._ids.size === 0) return [];

        const actualK = Math.min(k, this._ids.size);
        const result = this._index.searchKnn(Array.from(query), actualK);

        return result.neighbors.map((id: number, i: number) => ({
            id,
            score: 1 - result.distances[i],
        }));
    }

    /** Number of vectors in the index. */
    get size(): number {
        return this._ids.size;
    }
}

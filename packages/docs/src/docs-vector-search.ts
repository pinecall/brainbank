/**
 * @brainbank/docs — Docs Vector Search
 *
 * Pure vector search for doc_chunks via HNSW.
 * Implements DomainVectorSearch so docs participate in CompositeVectorSearch
 * alongside code and git — no internal RRF, no dedup.
 */

import type { SearchResult } from 'brainbank';

/** Typed row shape for doc_chunks table. */
export interface DocChunkRow {
    id: number;
    collection: string;
    file_path: string;
    title: string;
    content: string;
    seq: number;
    pos: number;
    content_hash: string;
}

export interface DocsVectorConfig {
    db: { prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown } };
    hnsw: { size: number; search(vec: Float32Array, k: number): { id: number; score: number }[] };
}

export class DocsVectorSearch {
    constructor(private _c: DocsVectorConfig) {}

    /** Search doc_chunks by vector similarity. Pure HNSW — no RRF, no dedup. */
    search(
        queryVec: Float32Array, k: number, minScore: number,
    ): SearchResult[] {
        const { hnsw, db } = this._c;
        if (hnsw.size === 0) return [];

        const hits = hnsw.search(queryVec, k * 2);
        if (hits.length === 0) return [];

        const ids = hits.map(h => h.id);
        const scoreMap = new Map(hits.map(h => [h.id, h.score]));
        const placeholders = ids.map(() => '?').join(',');
        const rows = db.prepare(
            `SELECT * FROM doc_chunks WHERE id IN (${placeholders})`
        ).all(...ids) as DocChunkRow[];

        const results: SearchResult[] = [];
        for (const r of rows) {
            const score = scoreMap.get(r.id) ?? 0;
            if (score >= minScore) {
                results.push({
                    type: 'document',
                    score,
                    filePath: r.file_path,
                    content: r.content,
                    context: this._getDocContext(r.collection, r.file_path),
                    metadata: {
                        collection: r.collection,
                        title: r.title,
                        seq: r.seq,
                        chunkId: r.id,
                    },
                });
            }
        }
        return results;
    }

    /** Resolve context for a document (checks path_contexts tree → collection context). */
    private _getDocContext(collection: string, filePath: string): string | undefined {
        const parts = filePath.split('/');
        for (let i = parts.length; i >= 0; i--) {
            const checkPath = i === 0 ? '/' : '/' + parts.slice(0, i).join('/');
            const ctx = this._c.db.prepare(
                'SELECT context FROM path_contexts WHERE collection = ? AND path = ?'
            ).get(collection, checkPath) as { context: string } | undefined;
            if (ctx) return ctx.context;
        }

        const coll = this._c.db.prepare(
            'SELECT context FROM collections WHERE name = ?'
        ).get(collection) as { context: string | null } | undefined;
        return coll?.context ?? undefined;
    }
}

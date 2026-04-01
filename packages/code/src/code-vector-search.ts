/**
 * @brainbank/code — Code Vector Search
 *
 * Searches code_chunks via HNSW with optional MMR diversification.
 * Moved from core — domain-specific strategy for CompositeVectorSearch.
 */

import type { SearchResult } from 'brainbank';
import { searchMMR } from 'brainbank';

/** Typed row shape for code_chunks table. */
export interface CodeChunkRow {
    id: number;
    file_path: string;
    chunk_type: string;
    name: string | null;
    start_line: number;
    end_line: number;
    content: string;
    language: string;
    file_hash: string | null;
    indexed_at: number;
}

export interface CodeVectorConfig {
    db: { prepare(sql: string): { all(...params: unknown[]): unknown[] } };
    hnsw: { size: number; search(vec: Float32Array, k: number): { id: number; score: number }[] };
    vecs: Map<number, Float32Array>;
}

export class CodeVectorSearch {
    constructor(private _c: CodeVectorConfig) {}

    /** Search code_chunks by vector similarity. */
    search(
        queryVec: Float32Array, k: number, minScore: number,
        useMMR: boolean, mmrLambda: number,
    ): SearchResult[] {
        const { hnsw, vecs, db } = this._c;
        if (hnsw.size === 0) return [];

        const hits = useMMR
            ? searchMMR(hnsw as Parameters<typeof searchMMR>[0], queryVec, vecs, k, mmrLambda)
            : hnsw.search(queryVec, k);
        if (hits.length === 0) return [];

        const ids = hits.map(h => h.id);
        const scoreMap = new Map(hits.map(h => [h.id, h.score]));
        const placeholders = ids.map(() => '?').join(',');
        const rows = db.prepare(
            `SELECT * FROM code_chunks WHERE id IN (${placeholders})`
        ).all(...ids) as CodeChunkRow[];

        const results: SearchResult[] = [];
        for (const r of rows) {
            const score = scoreMap.get(r.id) ?? 0;
            if (score >= minScore) {
                results.push({
                    type: 'code', score, filePath: r.file_path, content: r.content,
                    metadata: {
                        id: r.id,
                        chunkType: r.chunk_type, name: r.name ?? undefined,
                        startLine: r.start_line, endLine: r.end_line, language: r.language,
                    },
                });
            }
        }
        return results;
    }
}

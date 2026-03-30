/**
 * BrainBank — Code Vector Search
 *
 * Searches code_chunks via HNSW with optional MMR diversification.
 * One of three domain-specific vector strategies composed by CompositeVectorSearch.
 */

import type { Database } from '@/db/database.ts';
import type { CodeChunkRow } from '@/db/rows.ts';
import type { HNSWIndex } from '@/providers/vector/hnsw-index.ts';
import type { SearchResult } from '@/types.ts';
import { searchMMR } from './mmr.ts';

export interface CodeVectorConfig {
    db: Database;
    hnsw: HNSWIndex;
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
            ? searchMMR(hnsw, queryVec, vecs, k, mmrLambda)
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

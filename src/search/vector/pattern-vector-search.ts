/**
 * BrainBank — Pattern Vector Search
 *
 * Searches memory_patterns via HNSW with optional MMR diversification.
 * One of three domain-specific vector strategies composed by CompositeVectorSearch.
 */

import type { Database } from '@/db/database.ts';
import type { MemoryPatternRow } from '@/db/rows.ts';
import type { HNSWIndex } from '@/providers/vector/hnsw-index.ts';
import type { SearchResult } from '@/types.ts';
import { searchMMR } from './mmr.ts';

export interface PatternVectorConfig {
    db: Database;
    hnsw: HNSWIndex;
    vecs: Map<number, Float32Array>;
}

export class PatternVectorSearch {
    constructor(private _c: PatternVectorConfig) {}

    /** Search memory_patterns by vector similarity. */
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
            `SELECT * FROM memory_patterns WHERE id IN (${placeholders}) AND success_rate >= 0.5`
        ).all(...ids) as MemoryPatternRow[];

        const results: SearchResult[] = [];
        for (const r of rows) {
            const score = scoreMap.get(r.id) ?? 0;
            if (score >= minScore) {
                results.push({
                    type: 'pattern', score, content: r.approach,
                    metadata: {
                        taskType: r.task_type, task: r.task,
                        outcome: r.outcome, successRate: r.success_rate, critique: r.critique,
                    },
                });
            }
        }
        return results;
    }
}

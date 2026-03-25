/**
 * BrainBank — Pattern Store (Agent Memory)
 * 
 * Stores what the agent learned from past tasks.
 * Each pattern records task, approach, and success rate.
 * Searchable by semantic similarity via HNSW.
 */

import type { Database } from '@/db/database.ts';
import type { EmbeddingProvider, LearningPattern } from '@/types.ts';
import type { HNSWIndex } from '@/providers/vector/hnsw-index.ts';

export interface PatternStoreDeps {
    db: Database;
    hnsw: HNSWIndex;
    vectorCache: Map<number, Float32Array>;
    embedding: EmbeddingProvider;
}

export class PatternStore {
    private _deps: PatternStoreDeps;

    constructor(deps: PatternStoreDeps) {
        this._deps = deps;
    }

    /**
     * Store a learned pattern.
     * Returns the pattern ID.
     */
    async learn(pattern: LearningPattern): Promise<number> {
        const result = this._deps.db.prepare(`
            INSERT INTO memory_patterns (task_type, task, approach, outcome, success_rate, critique, tokens_used, latency_ms)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            pattern.taskType,
            pattern.task,
            pattern.approach,
            pattern.outcome ?? null,
            pattern.successRate,
            pattern.critique ?? null,
            pattern.tokensUsed ?? null,
            pattern.latencyMs ?? null,
        );

        const id = Number(result.lastInsertRowid);

        // Embed and store vector
        const text = `${pattern.taskType} ${pattern.task} ${pattern.approach}`;
        const vec = await this._deps.embedding.embed(text);

        this._deps.db.prepare(
            'INSERT INTO memory_vectors (pattern_id, embedding) VALUES (?, ?)'
        ).run(id, Buffer.from(vec.buffer));

        this._deps.hnsw.add(vec, id);
        this._deps.vectorCache.set(id, vec);

        return id;
    }

    /**
     * Search for similar successful patterns.
     * Filters by minimum success rate.
     */
    async search(query: string, k: number = 4, minSuccess: number = 0.5): Promise<(LearningPattern & { score: number })[]> {
        if (this._deps.hnsw.size === 0) return [];

        const vec = await this._deps.embedding.embed(query);
        const hits = this._deps.hnsw.search(vec, k * 2);

        if (hits.length === 0) return [];

        const ids = hits.map(h => h.id);
        const scoreMap = new Map(hits.map(h => [h.id, h.score]));

        const placeholders = ids.map(() => '?').join(',');
        const rows = this._deps.db.prepare(
            `SELECT * FROM memory_patterns WHERE id IN (${placeholders}) AND success_rate >= ?`
        ).all(...ids, minSuccess) as any[];

        return rows
            .map(r => ({
                id: r.id,
                taskType: r.task_type,
                task: r.task,
                approach: r.approach,
                outcome: r.outcome,
                successRate: r.success_rate,
                critique: r.critique,
                tokensUsed: r.tokens_used,
                latencyMs: r.latency_ms,
                score: scoreMap.get(r.id) ?? 0,
            }))
            .sort((a, b) => b.score - a.score)
            .slice(0, k);
    }

    /**
     * Get all patterns for a specific task type.
     */
    getByTaskType(taskType: string, limit: number = 20): LearningPattern[] {
        const rows = this._deps.db.prepare(
            `SELECT * FROM memory_patterns WHERE task_type = ? ORDER BY success_rate DESC LIMIT ?`
        ).all(taskType, limit) as any[];

        return rows.map(r => ({
            id: r.id,
            taskType: r.task_type,
            task: r.task,
            approach: r.approach,
            outcome: r.outcome,
            successRate: r.success_rate,
            critique: r.critique,
            tokensUsed: r.tokens_used,
            latencyMs: r.latency_ms,
        }));
    }

    /** Total number of stored patterns. */
    get count(): number {
        return (this._deps.db.prepare('SELECT COUNT(*) as c FROM memory_patterns').get() as any).c;
    }
}

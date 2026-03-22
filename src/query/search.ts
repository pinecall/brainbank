/**
 * BrainBank — Unified Search
 * 
 * Searches across all three indices (code, git, memory)
 * and returns typed results sorted by relevance.
 */

import type { Database } from '../storage/database.ts';
import type { EmbeddingProvider, Reranker, SearchResult } from '../types.ts';
import type { HNSWIndex } from '../vector/hnsw.ts';
import { searchMMR } from '../vector/mmr.ts';

export interface SearchDeps {
    db: Database;
    codeHnsw: HNSWIndex;
    gitHnsw: HNSWIndex;
    memHnsw: HNSWIndex;
    codeVecs: Map<number, Float32Array>;
    gitVecs: Map<number, Float32Array>;
    memVecs: Map<number, Float32Array>;
    embedding: EmbeddingProvider;
    reranker?: Reranker;
}

export interface SearchOptions {
    /** Max code results. Default: 6 */
    codeK?: number;
    /** Max git results. Default: 5 */
    gitK?: number;
    /** Max memory results. Default: 4 */
    memoryK?: number;
    /** Minimum similarity score. Default: 0.25 */
    minScore?: number;
    /** Use MMR for diversity. Default: true */
    useMMR?: boolean;
    /** MMR lambda. Default: 0.7 */
    mmrLambda?: number;
}

export class UnifiedSearch {
    private _deps: SearchDeps;

    constructor(deps: SearchDeps) {
        this._deps = deps;
    }

    /**
     * Search across all indices.
     * Returns combined results sorted by score.
     */
    async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
        const {
            codeK = 6,
            gitK = 5,
            memoryK = 4,
            minScore = 0.25,
            useMMR = true,
            mmrLambda = 0.7,
        } = options;

        const queryVec = await this._deps.embedding.embed(query);
        const results: SearchResult[] = [];

        // ── Code search ────────────────────────────
        if (this._deps.codeHnsw && this._deps.codeHnsw.size > 0) {
            const hits = useMMR
                ? searchMMR(this._deps.codeHnsw, queryVec, this._deps.codeVecs, codeK, mmrLambda)
                : this._deps.codeHnsw.search(queryVec, codeK);

            if (hits.length > 0) {
                const ids = hits.map(h => h.id);
                const scoreMap = new Map(hits.map(h => [h.id, h.score]));
                const placeholders = ids.map(() => '?').join(',');

                const rows = this._deps.db.prepare(
                    `SELECT * FROM code_chunks WHERE id IN (${placeholders})`
                ).all(...ids) as any[];

                for (const r of rows) {
                    const score = scoreMap.get(r.id) ?? 0;
                    if (score >= minScore) {
                        results.push({
                            type: 'code',
                            score,
                            filePath: r.file_path,
                            content: r.content,
                            metadata: {
                                chunkType: r.chunk_type,
                                name: r.name,
                                startLine: r.start_line,
                                endLine: r.end_line,
                                language: r.language,
                            },
                        });
                    }
                }
            }
        }

        // ── Git search ─────────────────────────────
        if (this._deps.gitHnsw && this._deps.gitHnsw.size > 0) {
            const hits = this._deps.gitHnsw.search(queryVec, gitK * 2);

            if (hits.length > 0) {
                const ids = hits.map(h => h.id);
                const scoreMap = new Map(hits.map(h => [h.id, h.score]));
                const placeholders = ids.map(() => '?').join(',');

                const rows = this._deps.db.prepare(
                    `SELECT * FROM git_commits WHERE id IN (${placeholders}) AND is_merge = 0`
                ).all(...ids) as any[];

                for (const r of rows) {
                    const score = scoreMap.get(r.id) ?? 0;
                    if (score >= minScore) {
                        results.push({
                            type: 'commit',
                            score,
                            content: r.message,
                            metadata: {
                                hash: r.hash,
                                shortHash: r.short_hash,
                                author: r.author,
                                date: r.date,
                                files: JSON.parse(r.files_json ?? '[]'),
                                additions: r.additions,
                                deletions: r.deletions,
                                diff: r.diff,
                            },
                        });
                    }
                }
            }
        }

        // ── Memory search ──────────────────────────
        if (this._deps.memHnsw && this._deps.memHnsw.size > 0) {
            const hits = useMMR
                ? searchMMR(this._deps.memHnsw, queryVec, this._deps.memVecs, memoryK, mmrLambda)
                : this._deps.memHnsw.search(queryVec, memoryK);

            if (hits.length > 0) {
                const ids = hits.map(h => h.id);
                const scoreMap = new Map(hits.map(h => [h.id, h.score]));
                const placeholders = ids.map(() => '?').join(',');

                const rows = this._deps.db.prepare(
                    `SELECT * FROM memory_patterns WHERE id IN (${placeholders}) AND success_rate >= 0.5`
                ).all(...ids) as any[];

                for (const r of rows) {
                    const score = scoreMap.get(r.id) ?? 0;
                    if (score >= minScore) {
                        results.push({
                            type: 'pattern',
                            score,
                            content: r.approach,
                            metadata: {
                                taskType: r.task_type,
                                task: r.task,
                                outcome: r.outcome,
                                successRate: r.success_rate,
                                critique: r.critique,
                            },
                        });
                    }
                }
            }
        }

        // Sort by score descending
        results.sort((a, b) => b.score - a.score);

        // Apply re-ranking if available
        if (this._deps.reranker && results.length > 1) {
            return this._rerank(query, results);
        }

        return results;
    }

    /** Re-rank results by blending original score with reranker score. */
    private async _rerank(query: string, results: SearchResult[]): Promise<SearchResult[]> {
        const reranker = this._deps.reranker!;
        const documents = results.map(r => r.content);
        const scores = await reranker.rank(query, documents);

        // Blend: 60% original, 40% reranker
        const blended = results.map((r, i) => ({
            ...r,
            score: 0.6 * r.score + 0.4 * (scores[i] ?? 0),
        }));

        return blended.sort((a, b) => b.score - a.score);
    }
}

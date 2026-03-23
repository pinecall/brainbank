/**
 * BrainBank — Multi-Index Search
 * 
 * Searches across all three indices (code, git, learning patterns)
 * and returns typed results sorted by relevance.
 */

import type { Database } from '../core/database.ts';
import type { EmbeddingProvider, Reranker, SearchResult } from '../types.ts';
import type { HNSWIndex } from '../vector/hnsw.ts';
import { searchMMR } from '../vector/mmr.ts';

export interface SearchConfig {
    db: Database;
    codeHnsw?: HNSWIndex;
    gitHnsw?: HNSWIndex;
    patternHnsw?: HNSWIndex;
    codeVecs: Map<number, Float32Array>;
    gitVecs: Map<number, Float32Array>;
    patternVecs: Map<number, Float32Array>;
    embedding: EmbeddingProvider;
    reranker?: Reranker;
}

export interface SearchOptions {
    /** Max code results. Default: 6 */
    codeK?: number;
    /** Max git results. Default: 5 */
    gitK?: number;
    /** Max pattern results. Default: 4 */
    patternK?: number;
    /** Minimum similarity score. Default: 0.25 */
    minScore?: number;
    /** Use MMR for diversity. Default: true */
    useMMR?: boolean;
    /** MMR lambda. Default: 0.7 */
    mmrLambda?: number;
}

export class MultiIndexSearch {
    private _config: SearchConfig;

    constructor(config: SearchConfig) {
        this._config = config;
    }

    /**
     * Search across all indices.
     * Returns combined results sorted by score.
     */
    async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
        const {
            codeK = 6,
            gitK = 5,
            patternK = 4,
            minScore = 0.25,
            useMMR = true,
            mmrLambda = 0.7,
        } = options;

        const queryVec = await this._config.embedding.embed(query);
        const results: SearchResult[] = [];

        // ── Code search ────────────────────────────
        if (this._config.codeHnsw && this._config.codeHnsw.size > 0) {
            const hits = useMMR
                ? searchMMR(this._config.codeHnsw, queryVec, this._config.codeVecs, codeK, mmrLambda)
                : this._config.codeHnsw.search(queryVec, codeK);

            if (hits.length > 0) {
                const ids = hits.map(h => h.id);
                const scoreMap = new Map(hits.map(h => [h.id, h.score]));
                const placeholders = ids.map(() => '?').join(',');

                const rows = this._config.db.prepare(
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
        if (this._config.gitHnsw && this._config.gitHnsw.size > 0) {
            const hits = this._config.gitHnsw.search(queryVec, gitK * 2);

            if (hits.length > 0) {
                const ids = hits.map(h => h.id);
                const scoreMap = new Map(hits.map(h => [h.id, h.score]));
                const placeholders = ids.map(() => '?').join(',');

                const rows = this._config.db.prepare(
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

        // ── Pattern search ──────────────────────────
        if (this._config.patternHnsw && this._config.patternHnsw.size > 0) {
            const hits = useMMR
                ? searchMMR(this._config.patternHnsw, queryVec, this._config.patternVecs, patternK, mmrLambda)
                : this._config.patternHnsw.search(queryVec, patternK);

            if (hits.length > 0) {
                const ids = hits.map(h => h.id);
                const scoreMap = new Map(hits.map(h => [h.id, h.score]));
                const placeholders = ids.map(() => '?').join(',');

                const rows = this._config.db.prepare(
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
        if (this._config.reranker && results.length > 1) {
            return this._rerank(query, results);
        }

        return results;
    }

    /**
     * Re-rank results using position-aware blending.
     * 
     * Top 1-3:  75% retrieval / 25% reranker (preserves exact matches)
     * Top 4-10: 60% retrieval / 40% reranker
     * Top 11+:  40% retrieval / 60% reranker (trust reranker more)
     */
    private async _rerank(query: string, results: SearchResult[]): Promise<SearchResult[]> {
        const reranker = this._config.reranker!;
        const documents = results.map(r => r.content);
        const scores = await reranker.rank(query, documents);

        const blended = results.map((r, i) => {
            const pos = i + 1;
            const rrfWeight = pos <= 3 ? 0.75 : pos <= 10 ? 0.60 : 0.40;
            return {
                ...r,
                score: rrfWeight * r.score + (1 - rrfWeight) * (scores[i] ?? 0),
            };
        });

        return blended.sort((a, b) => b.score - a.score);
    }
}

/**
 * BrainBank — Vector Search Strategy
 * 
 * Searches across code, git, and memory pattern HNSW indices.
 * Returns typed results sorted by relevance.
 */

import type { Database } from '@/db/database.ts';
import type { EmbeddingProvider, Reranker, SearchResult } from '@/types.ts';
import type { HNSWIndex } from '@/providers/vector/hnsw-index.ts';
import type { SearchStrategy, SearchOptions } from '@/search/types.ts';
import { searchMMR } from './mmr.ts';
import { rerank } from './rerank.ts';

export interface VectorSearchConfig {
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

export class VectorSearch implements SearchStrategy {
    private _config: VectorSearchConfig;

    constructor(config: VectorSearchConfig) {
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
            return rerank(query, results, this._config.reranker);
        }

        return results;
    }
}

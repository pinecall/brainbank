/**
 * @brainbank/code — Code Vector Search (File-Level + BM25 Fusion)
 *
 * Two-tier hybrid search:
 * 1. HNSW finds relevant FILES by vector similarity
 * 2. BM25 finds relevant CHUNKS by keyword match
 * 3. RRF fuses both rankings for best-of-both-worlds
 * 4. Returns code_chunks from matched files
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

/** RRF constant — standard value from literature. */
const RRF_K = 60;

export class CodeVectorSearch {
    constructor(private _c: CodeVectorConfig) {}

    /**
     * Hybrid search: file-level vectors + chunk-level BM25, fused by RRF.
     * Returns chunks ranked by combined relevance.
     */
    search(
        queryVec: Float32Array, k: number, minScore: number,
        useMMR: boolean, mmrLambda: number,
        queryText?: string,
    ): SearchResult[] {
        const { hnsw, vecs, db } = this._c;

        // ── Tier 1: Vector search → candidate files ──────────────
        const vectorFileScores = new Map<string, number>();
        if (hnsw.size > 0) {
            // Always use raw HNSW (no MMR) for file-level retrieval.
            // MMR diversity penalty destroys results when similar files ARE the target
            // (e.g. jwt.strategy.ts, jwt-auth.guard.ts get killed by jwt.service.ts similarity)
            const fileK = Math.min(k * 3, hnsw.size);
            const fileHits = hnsw.search(queryVec, fileK);

            if (fileHits.length > 0) {
                const ids = fileHits.filter(h => h.score >= minScore).map(h => h.id);
                if (ids.length > 0) {
                    const ph = ids.map(() => '?').join(',');
                    const rows = db.prepare(
                        `SELECT rowid, file_path FROM indexed_files WHERE rowid IN (${ph})`
                    ).all(...ids) as { rowid: number; file_path: string }[];

                    const idToScore = new Map(fileHits.map(h => [h.id, h.score]));
                    for (const row of rows) {
                        vectorFileScores.set(row.file_path, idToScore.get(row.rowid) ?? 0);
                    }
                }
            }
        }

        // ── Tier 2: BM25 search → candidate chunks ──────────────
        const bm25ChunkScores = new Map<number, number>();
        const bm25FilePaths = new Set<string>();

        if (queryText) {
            const ftsQuery = this._buildFtsQuery(queryText);
            if (ftsQuery) {
                try {
                    const bm25Rows = db.prepare(`
                        SELECT c.id, c.file_path, bm25(fts_code, 5.0, 3.0, 1.0) AS score
                        FROM fts_code f
                        JOIN code_chunks c ON c.id = f.rowid
                        WHERE fts_code MATCH ?
                        ORDER BY score ASC
                        LIMIT ?
                    `).all(ftsQuery, k * 5) as { id: number; file_path: string; score: number }[];

                    for (const row of bm25Rows) {
                        // Normalize BM25 score to 0-1 range
                        const norm = Math.min(1, -row.score / 20);
                        bm25ChunkScores.set(row.id, norm);
                        bm25FilePaths.add(row.file_path);
                    }
                } catch { /* FTS parse error — skip BM25 */ }
            }
        }

        // ── Collect all candidate file paths ──────────────────────
        const allFiles = new Set([...vectorFileScores.keys(), ...bm25FilePaths]);
        if (allFiles.size === 0) return [];

        // ── Fetch all chunks from candidate files ─────────────────
        const filePaths = [...allFiles];
        const ph = filePaths.map(() => '?').join(',');
        const allChunks = db.prepare(
            `SELECT * FROM code_chunks WHERE file_path IN (${ph})
             ORDER BY file_path, start_line`
        ).all(...filePaths) as CodeChunkRow[];

        // ── RRF fusion: combine vector file rank + BM25 chunk rank ─
        // Rank files by vector score
        const vectorRanked = [...vectorFileScores.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([fp], i) => [fp, i + 1] as const);
        const vectorRankMap = new Map(vectorRanked);

        // Rank chunks by BM25 score
        const bm25Ranked = [...bm25ChunkScores.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([id], i) => [id, i + 1] as const);
        const bm25RankMap = new Map(bm25Ranked);

        const results: SearchResult[] = [];
        for (const chunk of allChunks) {
            // RRF: 1/(k + rank) from each source, vector weighted 2x
            const vecRank = vectorRankMap.get(chunk.file_path);
            const bm25Rank = bm25RankMap.get(chunk.id);

            // Skip BM25-only results — files must have vector match to appear
            if (!vecRank) continue;

            const vecRRF = 2 / (RRF_K + vecRank);
            const bm25RRF = bm25Rank ? 1 / (RRF_K + bm25Rank) : 0;
            const rrfScore = vecRRF + bm25RRF;

            if (rrfScore <= 0) continue;

            // Display score: vector cosine (stable, meaningful %)
            const displayScore = vectorFileScores.get(chunk.file_path) ?? 0;

            results.push({
                type: 'code',
                score: displayScore,
                filePath: chunk.file_path,
                content: chunk.content,
                metadata: {
                    id: chunk.id,
                    chunkType: chunk.chunk_type,
                    name: chunk.name ?? undefined,
                    startLine: chunk.start_line,
                    endLine: chunk.end_line,
                    language: chunk.language,
                    rrfScore,
                },
            });
        }

        // Sort by RRF score (not display score) for ranking
        results.sort((a, b) => {
            const rrfA = (a.metadata?.rrfScore as number) ?? 0;
            const rrfB = (b.metadata?.rrfScore as number) ?? 0;
            if (rrfB !== rrfA) return rrfB - rrfA;
            return (a.metadata?.startLine as number ?? 0) - (b.metadata?.startLine as number ?? 0);
        });

        return results.slice(0, k * 3);
    }

    /** Build a valid FTS5 query from natural language. */
    private _buildFtsQuery(query: string): string {
        const words = query
            .replace(/[^\w\s]/g, ' ')
            .split(/\s+/)
            .filter(w => w.length > 2)
            .map(w => `"${w}"`);
        return words.length > 0 ? words.join(' OR ') : '';
    }
}

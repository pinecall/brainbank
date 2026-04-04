/**
 * @brainbank/code — Code Vector Search (File-Level Results)
 *
 * Dual-level hybrid search with file-level output:
 * 1. HNSW finds relevant CHUNKS + FILE SYNOPSES by vector similarity
 * 2. Synopsis hits (file-level) and chunk hits (function-level) are aggregated separately
 * 3. Files matching at BOTH levels get a cross-level boost; chunk-only hits are penalized
 * 4. BM25 finds relevant chunks by keyword match → aggregated to file level
 * 5. RRF fuses all rankings at the FILE level
 * 6. Returns ONE result per file with full content (zero truncation)
 *
 * V5: Chunk-level HNSW with contextual headers + file synopsis vectors.
 * Cross-level scoring eliminates false positives that match only at one level.
 */

import type { SearchResult } from 'brainbank';

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

/** Cross-level boost when a file matches at both synopsis AND chunk level. */
const CROSS_LEVEL_BOOST = 1.4;

/** Penalty when a file matches chunks but NOT the synopsis. */
const CHUNK_ONLY_PENALTY = 0.7;

/**
 * Minimum density ratio below which files are heavily penalized.
 * Files with matchedChunks/totalChunks below this get a sqrt-damped score.
 * For example, 1/15 = 0.067 → sqrt(0.067) = 0.26 → 74% penalty on final score.
 */
const DENSITY_EXPONENT = 0.5;

export class CodeVectorSearch {
    constructor(private _c: CodeVectorConfig) {}

    /**
     * Dual-level hybrid search: synopsis + chunk vectors + BM25.
     * Cross-level scoring: files matching at both levels get boosted,
     * chunk-only matches get penalized (likely noise).
     */
    search(
        queryVec: Float32Array, k: number, minScore: number,
        useMMR: boolean, mmrLambda: number,
        queryText?: string,
    ): SearchResult[] {
        const { hnsw, vecs, db } = this._c;

        // ── Tier 1: Vector search → split into synopsis and chunk hits ──
        const synopsisFileScores = new Map<string, number>();
        const chunkFileScores = new Map<string, number>();
        /** Track the number of matching chunks per file for density scoring. */
        const matchedChunkCount = new Map<string, number>();

        if (hnsw.size > 0) {
            const searchK = Math.min(k * 6, hnsw.size);
            const allHits = hnsw.search(queryVec, searchK);

            if (allHits.length > 0) {
                const ids = allHits.filter(h => h.score >= minScore).map(h => h.id);
                if (ids.length > 0) {
                    const ph = ids.map(() => '?').join(',');
                    const rows = db.prepare(
                        `SELECT id, file_path, chunk_type FROM code_chunks WHERE id IN (${ph})`
                    ).all(...ids) as { id: number; file_path: string; chunk_type: string }[];

                    const idToScore = new Map(allHits.map(h => [h.id, h.score]));
                    for (const row of rows) {
                        const score = idToScore.get(row.id) ?? 0;
                        if (row.chunk_type === 'synopsis') {
                            // Synopsis hit → file-level match
                            const current = synopsisFileScores.get(row.file_path) ?? 0;
                            if (score > current) synopsisFileScores.set(row.file_path, score);
                        } else {
                            // Regular chunk hit → function-level match
                            const current = chunkFileScores.get(row.file_path) ?? 0;
                            if (score > current) chunkFileScores.set(row.file_path, score);
                            // Count distinct matched chunks per file
                            matchedChunkCount.set(row.file_path, (matchedChunkCount.get(row.file_path) ?? 0) + 1);
                        }
                    }
                }
            }
        }

        // Merge vector scores with cross-level scoring
        const vectorFileScores = new Map<string, number>();
        const allVectorFiles = new Set([...synopsisFileScores.keys(), ...chunkFileScores.keys()]);

        for (const fp of allVectorFiles) {
            const synScore = synopsisFileScores.get(fp);
            const chunkScore = chunkFileScores.get(fp);

            if (synScore !== undefined && chunkScore !== undefined) {
                // Both levels match → high confidence, boost
                vectorFileScores.set(fp, Math.max(synScore, chunkScore) * CROSS_LEVEL_BOOST);
            } else if (chunkScore !== undefined) {
                // Only chunk matches, no synopsis → might be noise, penalize
                vectorFileScores.set(fp, chunkScore * CHUNK_ONLY_PENALTY);
            } else if (synScore !== undefined) {
                // Only synopsis matches → broad relevance, keep as-is
                vectorFileScores.set(fp, synScore);
            }
        }

        // ── Tier 2: BM25 → chunk scores aggregated to file level ──
        const bm25FileScores = new Map<string, number>();

        if (queryText) {
            const ftsQuery = this._buildFtsQuery(queryText);
            if (ftsQuery) {
                try {
                    const bm25Rows = db.prepare(`
                        SELECT c.file_path, bm25(fts_code, 5.0, 3.0, 1.0) AS score
                        FROM fts_code f
                        JOIN code_chunks c ON c.id = f.rowid
                        WHERE fts_code MATCH ?
                          AND c.chunk_type != 'synopsis'
                        ORDER BY score ASC
                        LIMIT ?
                    `).all(ftsQuery, k * 5) as { file_path: string; score: number }[];

                    // Aggregate: best BM25 score per file
                    for (const row of bm25Rows) {
                        const norm = Math.min(1, -row.score / 20);
                        const current = bm25FileScores.get(row.file_path) ?? 0;
                        if (norm > current) bm25FileScores.set(row.file_path, norm);
                    }
                } catch { /* FTS parse error — skip BM25 */ }
            }
        }

        // ── Union ALL candidates from both sources ───────────────
        const allCandidateFiles = new Set([
            ...vectorFileScores.keys(),
            ...bm25FileScores.keys(),
        ]);

        if (allCandidateFiles.size === 0) return [];

        // ── Chunk density: count total chunks per candidate file ──
        const candidateList = [...allCandidateFiles];
        const cph = candidateList.map(() => '?').join(',');
        const totalChunkRows = db.prepare(
            `SELECT file_path, COUNT(*) AS cnt
             FROM code_chunks
             WHERE file_path IN (${cph}) AND chunk_type != 'synopsis'
             GROUP BY file_path`
        ).all(...candidateList) as { file_path: string; cnt: number }[];
        const totalChunksByFile = new Map(totalChunkRows.map(r => [r.file_path, r.cnt]));

        // ── RRF fusion at FILE level ─────────────────────────────
        const vectorRanked = [...vectorFileScores.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([fp], i) => [fp, i + 1] as const);
        const vectorRankMap = new Map(vectorRanked);

        const bm25Ranked = [...bm25FileScores.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([fp], i) => [fp, i + 1] as const);
        const bm25RankMap = new Map(bm25Ranked);

        // Score each file with balanced RRF — both sources contribute equally
        const fileRRF: { filePath: string; rrfScore: number }[] = [];
        for (const filePath of allCandidateFiles) {
            const vecRank = vectorRankMap.get(filePath) ?? (vectorFileScores.size + RRF_K);
            const bm25Rank = bm25RankMap.get(filePath) ?? (bm25FileScores.size + RRF_K);

            const vecRRF = 1 / (RRF_K + vecRank);
            const bm25RRF = 1 / (RRF_K + bm25Rank);
            let rrfScore = vecRRF + bm25RRF;

            // ── Chunk density adjustment ─────────────────────────
            // If only 1 out of 15 chunks in a file matched, the file is mostly
            // irrelevant noise. Apply sqrt(matched/total) as a damping factor.
            // Examples:
            //   1/15 = 0.067 → sqrt(0.067) = 0.26 → ~74% penalty
            //   3/5  = 0.60  → sqrt(0.60)  = 0.77 → ~23% penalty
            //   5/5  = 1.00  → sqrt(1.00)  = 1.00 → no penalty
            const matched = matchedChunkCount.get(filePath) ?? 0;
            const total = totalChunksByFile.get(filePath) ?? 1;
            if (total > 1 && matched > 0) {
                const density = matched / total;
                rrfScore *= Math.pow(density, DENSITY_EXPONENT);
            }

            fileRRF.push({ filePath, rrfScore });
        }

        // Sort files by adjusted RRF score
        fileRRF.sort((a, b) => b.rrfScore - a.rrfScore);

        // ── Build file-level results — ZERO truncation ───────────
        const topFiles = fileRRF.slice(0, k);
        const filePaths = topFiles.map(f => f.filePath);
        const ph = filePaths.map(() => '?').join(',');

        const allChunks = filePaths.length > 0
            ? db.prepare(
                `SELECT * FROM code_chunks WHERE file_path IN (${ph})
                 ORDER BY file_path, start_line`
            ).all(...filePaths) as CodeChunkRow[]
            : [];

        // Group chunks by file path
        const chunksByFile = new Map<string, CodeChunkRow[]>();
        for (const chunk of allChunks) {
            const list = chunksByFile.get(chunk.file_path) ?? [];
            list.push(chunk);
            chunksByFile.set(chunk.file_path, list);
        }

        // Build ONE SearchResult per file — full content, no truncation
        const results: SearchResult[] = [];
        for (const file of topFiles) {
            // Filter out synopsis chunks — they're for scoring, not for output
            const chunks = (chunksByFile.get(file.filePath) ?? [])
                .filter(c => c.chunk_type !== 'synopsis');
            if (chunks.length === 0) continue;

            // Build full file content from all code chunks (sorted by start_line)
            const content = this._buildFileContent(chunks);
            const language = chunks[0]?.language ?? '';
            const lastLine = Math.max(...chunks.map(c => c.end_line));

            // Collect code chunk IDs for call graph seeding (no synopsis)
            const chunkIds = chunks.map(c => c.id);

            results.push({
                type: 'code',
                score: file.rrfScore,
                filePath: file.filePath,
                content,
                metadata: {
                    id: chunkIds[0],
                    chunkIds,
                    chunkType: 'file',
                    name: file.filePath.split('/').pop() ?? '',
                    startLine: chunks[0]?.start_line ?? 1,
                    endLine: lastLine,
                    language,
                    rrfScore: file.rrfScore,
                },
            });
        }

        return results;
    }

    /** Concatenate chunk contents, deduplicating overlapping regions. No truncation. */
    private _buildFileContent(chunks: CodeChunkRow[]): string {
        const parts: string[] = [];
        let lastEndLine = 0;

        for (const chunk of chunks) {
            // Skip chunks fully contained within previous content
            if (chunk.end_line <= lastEndLine) continue;

            if (chunk.start_line <= lastEndLine && lastEndLine > 0) {
                // Partial overlap — trim lines already covered by previous chunks
                const linesToSkip = lastEndLine - chunk.start_line + 1;
                const lines = chunk.content.split('\n');
                if (linesToSkip < lines.length) {
                    parts.push(lines.slice(linesToSkip).join('\n'));
                }
            } else {
                // No overlap — add separator between non-adjacent chunks
                if (parts.length > 0 && chunk.start_line > lastEndLine + 1) {
                    parts.push('');
                }
                parts.push(chunk.content);
            }
            lastEndLine = chunk.end_line;
        }

        return parts.join('\n');
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

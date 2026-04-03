/**
 * @brainbank/code — Code Vector Search (File-Level Results)
 *
 * Two-tier hybrid search with file-level output:
 * 1. HNSW finds relevant FILES by vector similarity
 * 2. BM25 finds relevant CHUNKS by keyword match (boosts file ranking)
 * 3. RRF fuses both rankings at the FILE level
 * 4. Returns ONE result per file with full content
 *
 * AST chunks are used internally for BM25 ranking and call graph,
 * but are NOT the output unit — files are.
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

/** Max content chars per file result (~80 lines). */
const MAX_FILE_CONTENT = 3000;

export class CodeVectorSearch {
    constructor(private _c: CodeVectorConfig) {}

    /**
     * File-level hybrid search: HNSW vectors + BM25 chunk boost.
     * Returns one result per file, ranked by fused relevance.
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
            // Raw HNSW (no MMR) — diversity penalty kills similar files
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

        // ── Only keep files with vector match ────────────────────
        // BM25 only boosts ranking, doesn't add new files
        if (vectorFileScores.size === 0) return [];

        // ── RRF fusion at FILE level ─────────────────────────────
        const vectorRanked = [...vectorFileScores.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([fp], i) => [fp, i + 1] as const);
        const vectorRankMap = new Map(vectorRanked);

        const bm25Ranked = [...bm25FileScores.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([fp], i) => [fp, i + 1] as const);
        const bm25RankMap = new Map(bm25Ranked);

        // Score each file with weighted RRF
        const fileRRF: { filePath: string; rrfScore: number; vecScore: number }[] = [];
        for (const [filePath, vecScore] of vectorFileScores) {
            const vecRank = vectorRankMap.get(filePath) ?? 999;
            const bm25Rank = bm25RankMap.get(filePath);

            const vecRRF = 2 / (RRF_K + vecRank);
            const bm25RRF = bm25Rank ? 1 / (RRF_K + bm25Rank) : 0;
            const rrfScore = vecRRF + bm25RRF;

            fileRRF.push({ filePath, rrfScore, vecScore });
        }

        // Sort files by RRF score
        fileRRF.sort((a, b) => b.rrfScore - a.rrfScore);

        // ── Build file-level results ─────────────────────────────
        // For each top file, fetch its chunks and build content
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

        // Build ONE SearchResult per file
        const results: SearchResult[] = [];
        for (const file of topFiles) {
            const chunks = chunksByFile.get(file.filePath) ?? [];
            if (chunks.length === 0) continue;

            // Build file content from chunks (sorted by start_line)
            const content = this._buildFileContent(chunks);
            const language = chunks[0]?.language ?? '';
            const lastLine = Math.max(...chunks.map(c => c.end_line));

            // Collect ALL chunk IDs for call graph seeding
            const chunkIds = chunks.map(c => c.id);

            results.push({
                type: 'code',
                score: file.vecScore,
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

    /** Concatenate chunk contents, deduplicating overlapping regions. */
    private _buildFileContent(chunks: CodeChunkRow[]): string {
        const parts: string[] = [];
        let totalLen = 0;
        let lastEndLine = 0;

        for (const chunk of chunks) {
            // Skip chunks fully overlapping with previous content
            if (chunk.end_line <= lastEndLine) continue;

            if (totalLen + chunk.content.length > MAX_FILE_CONTENT) {
                const remaining = MAX_FILE_CONTENT - totalLen;
                if (remaining > 100) {
                    parts.push(chunk.content.slice(0, remaining) + '\n// ... truncated');
                }
                break;
            }

            // Add separator between non-adjacent chunks
            if (parts.length > 0 && chunk.start_line > lastEndLine + 1) {
                parts.push('');
            }
            parts.push(chunk.content);
            totalLen += chunk.content.length;
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

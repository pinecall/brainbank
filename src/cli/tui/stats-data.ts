/**
 * stats-data.ts — Pure data-fetching functions for the Stats TUI.
 *
 * Opens a read-only `node:sqlite` DatabaseSync connection and queries
 * code_chunks, code_imports, code_call_edges, code_symbols, embedding_meta.
 * Zero state, zero React — just data.
 */

import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ── Types ─────────────────────────────────────────────

export interface StatsOverview {
    files: number;
    chunks: number;
    symbols: number;
    callEdges: number;
    importEdges: number;
    hnswSize: number;
    dbSizeMB: number;
    embeddingModel: string;
    repoPath: string;
    plugins: string[];
    pruner: string;
    expander: string;
}

export interface LanguageStat {
    language: string;
    chunks: number;
    files: number;
    percent: number;
}

export interface DirectoryStat {
    dir: string;
    files: number;
    chunks: number;
    percent: number;
}

export interface FileStat {
    filePath: string;
    fileName: string;
    language: string;
    chunks: number;
    symbols: number;
    startLine: number;
    endLine: number;
}

export interface FileDetailInfo {
    filePath: string;
    language: string;
    chunks: number;
    symbols: SymbolInfo[];
    importsOut: string[];
    importsIn: string[];
    callEdgesOut: number;
    callEdgesIn: number;
}

export interface SymbolInfo {
    name: string;
    kind: string;
    line: number;
}

export interface ChunkInfo {
    id: number;
    chunkType: string;
    name: string | null;
    startLine: number;
    endLine: number;
    content: string;
    language: string;
    callsOut: string[];
    calledBy: string[];
}

export interface CallTreeNode {
    chunkId: number;
    symbol: string;
    filePath: string;
    children: CallTreeNode[];
}


// ── Data Access ───────────────────────────────────

/** Open a read-only node:sqlite connection. */
function openDb(dbPath: string): DatabaseSync {
    return new DatabaseSync(dbPath, { readOnly: true } as ConstructorParameters<typeof DatabaseSync>[1]);
}

/** Check if a table exists. */
function tableExists(db: DatabaseSync, name: string): boolean {
    const row = db.prepare(
        `SELECT 1 as found FROM sqlite_master WHERE type='table' AND name=?`
    ).get(name) as Record<string, unknown> | undefined;
    return !!row;
}

/** Safe count query. */
function countQuery(db: DatabaseSync, sql: string, ...params: (string | number | bigint | null | Uint8Array)[]): number {
    const row = db.prepare(sql).get(...params) as { c: number } | undefined;
    return row?.c ?? 0;
}


// ── Public API ────────────────────────────────────

export function fetchOverview(dbPath: string, repoPath: string, configPath: string): StatsOverview {
    const db = openDb(dbPath);
    try {
        const hasChunks = tableExists(db, 'code_chunks');

        const files = hasChunks ? countQuery(db, 'SELECT COUNT(DISTINCT file_path) as c FROM code_chunks') : 0;
        const chunks = hasChunks ? countQuery(db, 'SELECT COUNT(*) as c FROM code_chunks') : 0;
        const symbols = hasChunks ? countQuery(db, "SELECT COUNT(*) as c FROM code_chunks WHERE name IS NOT NULL AND name != ''") : 0;
        const callEdges = tableExists(db, 'code_call_edges') ? countQuery(db, 'SELECT COUNT(*) as c FROM code_call_edges') : 0;
        const importEdges = tableExists(db, 'code_imports') ? countQuery(db, 'SELECT COUNT(*) as c FROM code_imports') : 0;
        const hnswSize = tableExists(db, 'code_vectors') ? countQuery(db, 'SELECT COUNT(*) as c FROM code_vectors') : 0;

        // DB file size
        const stat = fs.statSync(dbPath);
        const dbSizeMB = Math.round(stat.size / 1048576 * 10) / 10;

        // Embedding model
        let embeddingModel = 'unknown';
        if (tableExists(db, 'embedding_meta')) {
            for (const key of ['provider_key', 'provider', 'model']) {
                const row = db.prepare(`SELECT value FROM embedding_meta WHERE key = ?`).get(key) as { value: string } | undefined;
                if (row) { embeddingModel = row.value; break; }
            }
        }

        // Config
        let plugins: string[] = ['code'];
        let pruner = 'none';
        let expander = 'none';
        try {
            const raw = fs.readFileSync(configPath, 'utf-8');
            const config = JSON.parse(raw) as Record<string, unknown>;
            if (Array.isArray(config.plugins)) plugins = config.plugins as string[];
            if (typeof config.pruner === 'string') pruner = config.pruner;
            if (typeof config.expander === 'string') expander = config.expander;
        } catch { /* no config */ }

        return { files, chunks, symbols, callEdges, importEdges, hnswSize, dbSizeMB, embeddingModel, repoPath, plugins, pruner, expander };
    } finally {
        db.close();
    }
}

export function fetchLanguageBreakdown(dbPath: string): LanguageStat[] {
    const db = openDb(dbPath);
    try {
        if (!tableExists(db, 'code_chunks')) return [];

        const rows = db.prepare(`
            SELECT language, COUNT(*) as chunks, COUNT(DISTINCT file_path) as files
            FROM code_chunks
            GROUP BY language
            ORDER BY chunks DESC
        `).all() as { language: string; chunks: number; files: number }[];

        const total = rows.reduce((sum, r) => sum + r.chunks, 0);
        return rows.map(r => ({
            language: r.language,
            chunks: r.chunks,
            files: r.files,
            percent: total > 0 ? Math.round(r.chunks / total * 1000) / 10 : 0,
        }));
    } finally {
        db.close();
    }
}

export function fetchDirectories(dbPath: string): DirectoryStat[] {
    const db = openDb(dbPath);
    try {
        if (!tableExists(db, 'code_chunks')) return [];

        const rows = db.prepare(`
            SELECT
                CASE
                    WHEN INSTR(file_path, '/') > 0 THEN SUBSTR(file_path, 1, INSTR(file_path, '/') - 1)
                    ELSE file_path
                END as dir,
                COUNT(DISTINCT file_path) as files,
                COUNT(*) as chunks
            FROM code_chunks
            GROUP BY dir
            ORDER BY chunks DESC
        `).all() as { dir: string; files: number; chunks: number }[];

        const total = rows.reduce((sum, r) => sum + r.chunks, 0);
        return rows.map(r => ({
            dir: r.dir,
            files: r.files,
            chunks: r.chunks,
            percent: total > 0 ? Math.round(r.chunks / total * 1000) / 10 : 0,
        }));
    } finally {
        db.close();
    }
}

export function fetchFilesInDir(dbPath: string, dir: string): FileStat[] {
    const db = openDb(dbPath);
    try {
        if (!tableExists(db, 'code_chunks')) return [];

        const rows = db.prepare(`
            SELECT
                file_path,
                language,
                COUNT(*) as chunks,
                COUNT(CASE WHEN name IS NOT NULL AND name != '' THEN 1 END) as symbols,
                MIN(start_line) as min_line,
                MAX(end_line) as max_line
            FROM code_chunks
            WHERE file_path LIKE ? || '%'
            GROUP BY file_path
            ORDER BY chunks DESC, file_path
        `).all(`${dir}/`) as { file_path: string; language: string; chunks: number; symbols: number; min_line: number; max_line: number }[];

        return rows.map(r => ({
            filePath: r.file_path,
            fileName: path.basename(r.file_path),
            language: r.language,
            chunks: r.chunks,
            symbols: r.symbols,
            startLine: r.min_line,
            endLine: r.max_line,
        }));
    } finally {
        db.close();
    }
}

export function fetchFileDetail(dbPath: string, filePath: string): FileDetailInfo {
    const db = openDb(dbPath);
    try {
        // Language + chunk count
        const meta = db.prepare(`
            SELECT language, COUNT(*) as chunks
            FROM code_chunks WHERE file_path = ?
        `).get(filePath) as { language: string; chunks: number } | undefined;

        // Symbols — extract named chunks as symbols
        const symbols = db.prepare(`
            SELECT name, chunk_type as kind, start_line as line
            FROM code_chunks
            WHERE file_path = ? AND name IS NOT NULL AND name != ''
            ORDER BY start_line
        `).all(filePath) as unknown as SymbolInfo[];

        // Imports out (this file imports...)
        let importsOut: string[] = [];
        if (tableExists(db, 'code_imports')) {
            importsOut = (db.prepare(`
                SELECT imports_path FROM code_imports WHERE file_path = ?
            `).all(filePath) as { imports_path: string }[]).map(r => r.imports_path);
        }

        // Imports in (who imports this file)
        let importsIn: string[] = [];
        if (tableExists(db, 'code_imports')) {
            const base = path.basename(filePath, path.extname(filePath));
            importsIn = (db.prepare(`
                SELECT file_path FROM code_imports WHERE imports_path LIKE ?
            `).all(`%${base}%`) as { file_path: string }[]).map(r => r.file_path);
        }

        // Call edges
        let callEdgesOut = 0;
        let callEdgesIn = 0;
        if (tableExists(db, 'code_call_edges')) {
            const chunkIds = (db.prepare(
                `SELECT id FROM code_chunks WHERE file_path = ?`
            ).all(filePath) as { id: number }[]).map(r => r.id);

            if (chunkIds.length > 0) {
                const ph = chunkIds.map(() => '?').join(',');
                callEdgesOut = countQuery(db, `SELECT COUNT(*) as c FROM code_call_edges WHERE caller_chunk_id IN (${ph})`, ...chunkIds);
                callEdgesIn = countQuery(db, `SELECT COUNT(*) as c FROM code_call_edges WHERE callee_chunk_id IN (${ph})`, ...chunkIds);
            }
        }

        return {
            filePath,
            language: meta?.language ?? 'unknown',
            chunks: meta?.chunks ?? 0,
            symbols,
            importsOut,
            importsIn,
            callEdgesOut,
            callEdgesIn,
        };
    } finally {
        db.close();
    }
}

export function fetchChunksForFile(dbPath: string, filePath: string): ChunkInfo[] {
    const db = openDb(dbPath);
    try {
        if (!tableExists(db, 'code_chunks')) return [];

        const rows = db.prepare(`
            SELECT id, chunk_type, name, start_line, end_line, content, language
            FROM code_chunks
            WHERE file_path = ?
            ORDER BY start_line
        `).all(filePath) as { id: number; chunk_type: string; name: string | null; start_line: number; end_line: number; content: string; language: string }[];

        const hasCallEdges = tableExists(db, 'code_call_edges');

        return rows.map(r => {
            let callsOut: string[] = [];
            let calledBy: string[] = [];

            if (hasCallEdges) {
                callsOut = (db.prepare(`
                    SELECT DISTINCT symbol_name FROM code_call_edges WHERE caller_chunk_id = ?
                `).all(r.id) as { symbol_name: string }[]).map(row => row.symbol_name);

                calledBy = (db.prepare(`
                    SELECT DISTINCT symbol_name FROM code_call_edges WHERE callee_chunk_id = ?
                `).all(r.id) as { symbol_name: string }[]).map(row => row.symbol_name);
            }

            return {
                id: r.id,
                chunkType: r.chunk_type,
                name: r.name,
                startLine: r.start_line,
                endLine: r.end_line,
                content: r.content,
                language: r.language,
                callsOut,
                calledBy,
            };
        });
    } finally {
        db.close();
    }
}

export function fetchCallTree(dbPath: string, chunkId: number, depth: number = 3): CallTreeNode {
    const db = openDb(dbPath);
    try {
        const chunk = db.prepare(`
            SELECT id, name, file_path FROM code_chunks WHERE id = ?
        `).get(chunkId) as { id: number; name: string | null; file_path: string } | undefined;

        if (!chunk) return { chunkId, symbol: '?', filePath: '?', children: [] };

        function expand(id: number, d: number, visited: Set<number>): CallTreeNode[] {
            if (d <= 0 || !tableExists(db, 'code_call_edges')) return [];

            const edges = db.prepare(`
                SELECT DISTINCT ce.callee_chunk_id, ce.symbol_name, cc.file_path
                FROM code_call_edges ce
                JOIN code_chunks cc ON cc.id = ce.callee_chunk_id
                WHERE ce.caller_chunk_id = ?
                ORDER BY ce.symbol_name
            `).all(id) as { callee_chunk_id: number; symbol_name: string; file_path: string }[];

            return edges
                .filter(e => !visited.has(e.callee_chunk_id))
                .map(e => {
                    visited.add(e.callee_chunk_id);
                    return {
                        chunkId: e.callee_chunk_id,
                        symbol: e.symbol_name,
                        filePath: e.file_path,
                        children: expand(e.callee_chunk_id, d - 1, visited),
                    };
                });
        }

        const visited = new Set([chunkId]);
        return {
            chunkId,
            symbol: chunk.name ?? 'anonymous',
            filePath: chunk.file_path,
            children: expand(chunkId, depth, visited),
        };
    } finally {
        db.close();
    }
}

/** Search for chunks by symbol name — used by call graph view. */
export function searchSymbols(dbPath: string, query: string, limit: number = 10): { id: number; name: string; filePath: string }[] {
    const db = openDb(dbPath);
    try {
        if (!tableExists(db, 'code_chunks')) return [];
        return (db.prepare(`
            SELECT id, name, file_path as filePath FROM code_chunks
            WHERE name LIKE ? AND name IS NOT NULL AND name != ''
            ORDER BY name LIMIT ?
        `).all(`%${query}%`, limit) as { id: number; name: string; filePath: string }[]);
    } finally {
        db.close();
    }
}

/** Search result for full-text search. */
export interface SearchResultItem {
    id: number;
    filePath: string;
    name: string | null;
    chunkType: string;
    startLine: number;
    endLine: number;
    language: string;
    matchContext: string;
}

/** Full-text search across chunk content, names, file paths. Returns matching chunks with context. */
export function searchChunks(dbPath: string, query: string, limit: number = 30): SearchResultItem[] {
    const db = openDb(dbPath);
    try {
        if (!tableExists(db, 'code_chunks')) return [];

        // Try FTS first (if fts_code exists)
        if (tableExists(db, 'fts_code')) {
            try {
                const rows = db.prepare(`
                    SELECT cc.id, cc.file_path, cc.name, cc.chunk_type, cc.start_line, cc.end_line, cc.language,
                           snippet(fts_code, 0, '>>>', '<<<', '...', 40) as match_ctx
                    FROM fts_code ft
                    JOIN code_chunks cc ON cc.id = ft.rowid
                    WHERE fts_code MATCH ?
                    ORDER BY rank
                    LIMIT ?
                `).all(query, limit) as unknown as { id: number; file_path: string; name: string | null; chunk_type: string; start_line: number; end_line: number; language: string; match_ctx: string }[];

                return rows.map(r => ({
                    id: r.id,
                    filePath: r.file_path,
                    name: r.name,
                    chunkType: r.chunk_type,
                    startLine: r.start_line,
                    endLine: r.end_line,
                    language: r.language,
                    matchContext: r.match_ctx,
                }));
            } catch {
                // FTS query parse error — fall through to LIKE
            }
        }

        // Fallback: LIKE search across name, file_path, content
        const rows = db.prepare(`
            SELECT id, file_path, name, chunk_type, start_line, end_line, language,
                   SUBSTR(content, MAX(1, INSTR(LOWER(content), LOWER(?)) - 40), 100) as match_ctx
            FROM code_chunks
            WHERE chunk_type != 'synopsis'
              AND (LOWER(name) LIKE LOWER(?) OR LOWER(file_path) LIKE LOWER(?) OR LOWER(content) LIKE LOWER(?))
            ORDER BY
                CASE WHEN LOWER(name) LIKE LOWER(?) THEN 0
                     WHEN LOWER(file_path) LIKE LOWER(?) THEN 1
                     ELSE 2 END,
                file_path, start_line
            LIMIT ?
        `).all(query, `%${query}%`, `%${query}%`, `%${query}%`, `%${query}%`, `%${query}%`, limit) as unknown as { id: number; file_path: string; name: string | null; chunk_type: string; start_line: number; end_line: number; language: string; match_ctx: string }[];

        return rows.map(r => ({
            id: r.id,
            filePath: r.file_path,
            name: r.name,
            chunkType: r.chunk_type,
            startLine: r.start_line,
            endLine: r.end_line,
            language: r.language,
            matchContext: r.match_ctx || '',
        }));
    } finally {
        db.close();
    }
}

/** Fetch a single chunk by ID. */
export function fetchChunkById(dbPath: string, chunkId: number): ChunkInfo | null {
    const db = openDb(dbPath);
    try {
        const r = db.prepare(`
            SELECT id, chunk_type, name, start_line, end_line, content, language
            FROM code_chunks WHERE id = ?
        `).get(chunkId) as { id: number; chunk_type: string; name: string | null; start_line: number; end_line: number; content: string; language: string } | undefined;

        if (!r) return null;

        let callsOut: string[] = [];
        let calledBy: string[] = [];
        if (tableExists(db, 'code_call_edges')) {
            callsOut = (db.prepare(`SELECT DISTINCT symbol_name FROM code_call_edges WHERE caller_chunk_id = ?`).all(r.id) as { symbol_name: string }[]).map(row => row.symbol_name);
            calledBy = (db.prepare(`SELECT DISTINCT symbol_name FROM code_call_edges WHERE callee_chunk_id = ?`).all(r.id) as { symbol_name: string }[]).map(row => row.symbol_name);
        }

        return {
            id: r.id,
            chunkType: r.chunk_type,
            name: r.name,
            startLine: r.start_line,
            endLine: r.end_line,
            content: r.content,
            language: r.language,
            callsOut,
            calledBy,
        };
    } finally {
        db.close();
    }
}


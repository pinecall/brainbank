/**
 * @brainbank/code — SQL Code Graph Provider
 *
 * Concrete implementation of CodeGraphProvider backed by SQLite.
 * Encapsulates all code_refs, code_imports, and code_chunks SQL queries.
 * Moved from core — domain-specific to code indexing.
 */

import { expandViaImportGraph, fetchBestChunks } from './import-graph.js';

/** Summary of a code chunk for graph expansion results. */
export interface CodeChunkSummary {
    filePath: string;
    content: string;
    name: string;
    chunkType: string;
    startLine: number;
    endLine: number;
    language: string;
}

/** Provider for code graph queries (call info, import graph, chunk lookup). */
export interface CodeGraphProvider {
    getCallInfo(chunkId: number, symbolName?: string): { calls: string[]; calledBy: string[] } | null;
    expandImportGraph(seedFiles: Set<string>): Set<string>;
    fetchBestChunks(filePaths: string[]): CodeChunkSummary[];
}

/** Minimal DB interface for queries. */
interface DbLike {
    prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown };
}

/** SQL-backed CodeGraphProvider — reads code_refs, code_imports, code_chunks. */
export class SqlCodeGraphProvider implements CodeGraphProvider {
    constructor(private _db: DbLike) {}

    /** Get call/called-by info for a code chunk. */
    getCallInfo(chunkId: number, symbolName?: string): { calls: string[]; calledBy: string[] } | null {
        try {
            const callRows = this._db.prepare(
                'SELECT DISTINCT symbol_name FROM code_refs WHERE chunk_id = ? LIMIT 5'
            ).all(chunkId) as { symbol_name: string }[];

            const callerRows = symbolName ? this._db.prepare(
                `SELECT DISTINCT cc.file_path, cc.name FROM code_refs cr
                 JOIN code_chunks cc ON cc.id = cr.chunk_id
                 WHERE cr.symbol_name = ? LIMIT 5`
            ).all(symbolName) as { file_path: string; name: string }[] : [];

            const calls = callRows.map(c => c.symbol_name);
            const calledBy = callerRows.map(c => c.name || c.file_path);

            return (calls.length > 0 || calledBy.length > 0) ? { calls, calledBy } : null;
        } catch {
            return null;
        }
    }

    /** 2-hop import graph expansion from seed files. */
    expandImportGraph(seedFiles: Set<string>): Set<string> {
        return expandViaImportGraph(this._db, seedFiles);
    }

    /** Fetch the most informative chunk per file (largest by line span). */
    fetchBestChunks(filePaths: string[]): CodeChunkSummary[] {
        return fetchBestChunks(this._db, filePaths);
    }
}

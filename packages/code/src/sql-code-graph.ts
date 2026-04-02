/**
 * @brainbank/code — SQL Code Graph Provider
 *
 * Concrete implementation of CodeGraphProvider backed by SQLite.
 * Encapsulates all code_refs, code_imports, and code_chunks SQL queries.
 * Moved from core — domain-specific to code indexing.
 */

import {
    expandViaImportGraph, fetchBestChunks, buildDependencyGraph, fetchCalledChunks, buildCallTree,
    type DependencyGraph, type DependencyNode, type DependencyEdge, type CalledChunk, type CallTreeNode,
} from './import-graph.js';

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

/** Provider for code graph queries (call info, import graph, chunk lookup, dependency graph). */
export interface CodeGraphProvider {
    getCallInfo(chunkId: number, symbolName?: string): { calls: string[]; calledBy: string[] } | null;
    expandImportGraph(seedFiles: Set<string>): Set<string>;
    buildDependencyGraph(seedFiles: Set<string>): DependencyGraph;
    fetchBestChunks(filePaths: string[]): CodeChunkSummary[];
    fetchCalledChunks(seedChunkIds: number[]): CalledChunk[];
    buildCallTree(seedChunkIds: number[]): CallTreeNode[];
    /** Fetch all sibling parts for a multi-part chunk (e.g. 'foo (part 2)' → all parts of foo). */
    fetchAdjacentParts(filePath: string, baseName: string): AdjacentPart[];
}

/** A sibling part of a multi-part chunk. */
export interface AdjacentPart {
    id: number;
    filePath: string;
    name: string;
    chunkType: string;
    startLine: number;
    endLine: number;
    language: string;
    content: string;
}

// Re-export graph types for consumers
export type { DependencyGraph, DependencyNode, DependencyEdge, CalledChunk, CallTreeNode };

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

    /** Legacy 2-hop import graph expansion from seed files. */
    expandImportGraph(seedFiles: Set<string>): Set<string> {
        return expandViaImportGraph(this._db, seedFiles);
    }

    /** Full bidirectional dependency graph from seed files. */
    buildDependencyGraph(seedFiles: Set<string>): DependencyGraph {
        return buildDependencyGraph(this._db, seedFiles);
    }

    /** Fetch the most informative chunk per file (largest by line span). */
    fetchBestChunks(filePaths: string[]): CodeChunkSummary[] {
        return fetchBestChunks(this._db, filePaths);
    }

    /** Fetch chunks called by seed chunks via code_call_edges. */
    fetchCalledChunks(seedChunkIds: number[]): CalledChunk[] {
        return fetchCalledChunks(this._db, seedChunkIds);
    }

    /** Build a recursive call tree from seed chunks. */
    buildCallTree(seedChunkIds: number[]): CallTreeNode[] {
        return buildCallTree(this._db, seedChunkIds);
    }

    /** Fetch all sibling parts for a multi-part chunk. */
    fetchAdjacentParts(filePath: string, baseName: string): AdjacentPart[] {
        try {
            const rows = this._db.prepare(
                `SELECT id, file_path AS filePath, name, chunk_type AS chunkType,
                        start_line AS startLine, end_line AS endLine, language, content
                 FROM code_chunks
                 WHERE file_path = ? AND name LIKE ? || ' (part %'
                 ORDER BY start_line`
            ).all(filePath, baseName) as AdjacentPart[];
            return rows;
        } catch {
            return [];
        }
    }
}

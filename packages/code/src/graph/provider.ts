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
} from './traversal.js';

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
    buildCallTree(seedChunkIds: number[], maxDepth?: number): CallTreeNode[];
    /** Fetch all sibling parts for a multi-part chunk (e.g. 'foo (part 2)' → all parts of foo). */
    fetchAdjacentParts(filePath: string, baseName: string): AdjacentPart[];
    /** Import neighbors + symbol-based cross-reference for unresolved workspace imports. */
    fetchImportNeighbors(seedFilePaths: string[]): string[];
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
    buildCallTree(seedChunkIds: number[], maxDepth?: number): CallTreeNode[] {
        return buildCallTree(this._db, seedChunkIds, maxDepth);
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

    /** Fetch all symbols for a set of file paths. Returns symbols grouped by file. */
    fetchSymbolsForFiles(filePaths: string[]): SymbolInfo[] {
        if (filePaths.length === 0) return [];
        try {
            const ph = filePaths.map(() => '?').join(',');
            return this._db.prepare(
                `SELECT file_path AS filePath, name, kind, line
                 FROM code_symbols
                 WHERE file_path IN (${ph})
                 ORDER BY file_path, line`
            ).all(...filePaths) as SymbolInfo[];
        } catch {
            return [];
        }
    }

    /**
     * Fetch lightweight chunk manifest for expansion candidates.
     * Returns chunks from files NOT in excludeFilePaths and NOT in excludeIds.
     *
     * When `priorityFilePaths` is provided (import graph neighbors), those
     * chunks appear first in the manifest (up to 5 per file) before the
     * general sample (3 per file). Total capped at 500 rows.
     *
     * @param excludeFilePaths File paths already in search results — skip entirely.
     * @param excludeIds       Chunk IDs already in search results — skip individually.
     * @param priorityFilePaths File paths from import graph — prioritized in manifest.
     */
    fetchChunkManifest(
        excludeFilePaths: string[],
        excludeIds: number[],
        priorityFilePaths: string[] = [],
    ): ChunkManifestItem[] {
        try {
            const params: (string | number)[] = [];
            const clauses: string[] = [];

            if (excludeFilePaths.length > 0) {
                const pathPh = excludeFilePaths.map(() => '?').join(',');
                clauses.push(`file_path NOT IN (${pathPh})`);
                params.push(...excludeFilePaths);
            }

            if (excludeIds.length > 0) {
                const idPh = excludeIds.map(() => '?').join(',');
                clauses.push(`id NOT IN (${idPh})`);
                params.push(...excludeIds);
            }

            const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

            // If we have priority file paths, fetch them first (up to 5 per file)
            const priorityItems: ChunkManifestItem[] = [];

            if (priorityFilePaths.length > 0) {
                const prioParams: (string | number)[] = [];
                const prioClauses: string[] = [];

                const prioPh = priorityFilePaths.map(() => '?').join(',');
                prioClauses.push(`file_path IN (${prioPh})`);
                prioParams.push(...priorityFilePaths);

                if (excludeIds.length > 0) {
                    const idPh = excludeIds.map(() => '?').join(',');
                    prioClauses.push(`id NOT IN (${idPh})`);
                    prioParams.push(...excludeIds);
                }

                const prioWhere = `WHERE ${prioClauses.join(' AND ')}`;

                const prioRows = this._db.prepare(
                    `SELECT id, filePath, name, chunkType, startLine, endLine
                     FROM (
                         SELECT id, file_path AS filePath, name, chunk_type AS chunkType,
                                start_line AS startLine, end_line AS endLine,
                                ROW_NUMBER() OVER (PARTITION BY file_path ORDER BY start_line) AS rn
                         FROM code_chunks
                         ${prioWhere}
                     )
                     WHERE rn <= 5
                     ORDER BY filePath, startLine
                     LIMIT 150`
                ).all(...prioParams) as ChunkManifestItem[];

                for (const row of prioRows) {
                    (row as ChunkManifestItem & { priority: boolean }).priority = true;
                    priorityItems.push(row);
                }
            }

            // General sample: 3 per file, excluding priority files too
            const generalClauses = [...clauses];
            const generalParams = [...params];
            if (priorityFilePaths.length > 0) {
                const prioPh = priorityFilePaths.map(() => '?').join(',');
                generalClauses.push(`file_path NOT IN (${prioPh})`);
                generalParams.push(...priorityFilePaths);
            }
            const generalWhere = generalClauses.length > 0 ? `WHERE ${generalClauses.join(' AND ')}` : '';

            const remaining = 500 - priorityItems.length;
            const generalItems = remaining > 0 ? this._db.prepare(
                `SELECT id, filePath, name, chunkType, startLine, endLine
                 FROM (
                     SELECT id, file_path AS filePath, name, chunk_type AS chunkType,
                            start_line AS startLine, end_line AS endLine,
                            ROW_NUMBER() OVER (PARTITION BY file_path ORDER BY start_line) AS rn
                     FROM code_chunks
                     ${generalWhere}
                 )
                 WHERE rn <= 3
                 ORDER BY filePath, startLine
                 LIMIT ?`
            ).all(...generalParams, remaining) as ChunkManifestItem[] : [];

            return [...priorityItems, ...generalItems];
        } catch {
            return [];
        }
    }

    /**
     * Multi-strategy import neighbor discovery.
     *
     * 1. **Hop 1** — Bidirectional resolved imports (direct neighbors).
     * 2. **Hop 2** — Downstream from hop-1 files (catches barrel re-exports).
     * 3. **Symbol hop** — For unresolved workspace imports (e.g. `@pinecall/mongo`),
     *    cross-reference `code_refs` (symbols the seed code calls) with
     *    `code_symbols` (where those symbols are defined) to discover files
     *    that define classes/interfaces the seed code uses.
     *
     * The symbol hop is critical for monorepos where workspace packages are
     * stored as unresolved imports (resolved=0) because the import resolver
     * can't follow package.json `main`/`exports` mappings.
     */
    fetchImportNeighbors(seedFilePaths: string[]): string[] {
        if (seedFilePaths.length === 0) return [];
        try {
            const seedSet = new Set(seedFilePaths);
            const neighbors = new Set<string>();

            // ── Hop 1: direct neighbors (bidirectional, resolved only) ──
            const ph1 = seedFilePaths.map(() => '?').join(',');

            const downstream1 = this._db.prepare(
                `SELECT DISTINCT imports_path FROM code_imports
                 WHERE file_path IN (${ph1}) AND resolved = 1`
            ).all(...seedFilePaths) as { imports_path: string }[];

            const upstream1 = this._db.prepare(
                `SELECT DISTINCT file_path FROM code_imports
                 WHERE imports_path IN (${ph1}) AND resolved = 1`
            ).all(...seedFilePaths) as { file_path: string }[];

            for (const row of downstream1) {
                if (!seedSet.has(row.imports_path)) neighbors.add(row.imports_path);
            }
            for (const row of upstream1) {
                if (!seedSet.has(row.file_path)) neighbors.add(row.file_path);
            }

            // ── Hop 2: downstream-only from hop-1 files ──
            const hop1Files = [...neighbors];
            if (hop1Files.length > 0 && hop1Files.length <= 50) {
                const ph2 = hop1Files.map(() => '?').join(',');
                const downstream2 = this._db.prepare(
                    `SELECT DISTINCT imports_path FROM code_imports
                     WHERE file_path IN (${ph2}) AND resolved = 1`
                ).all(...hop1Files) as { imports_path: string }[];

                for (const row of downstream2) {
                    if (!seedSet.has(row.imports_path)) neighbors.add(row.imports_path);
                }
            }

            // ── Symbol hop: content-based class/interface discovery ──
            // For unresolved workspace imports (e.g. `@pinecall/mongo`),
            // scan the raw content of seed chunks for class/interface/type names
            // that are defined elsewhere. This catches `PhoneNumber.find()`,
            // `ReceivedCall.all()`, etc. where the class names appear in code
            // but aren't tracked as explicit code_refs.
            try {
                // 1. Get concatenated content from seed file chunks
                const contentRows = this._db.prepare(
                    `SELECT content FROM code_chunks WHERE file_path IN (${ph1})`
                ).all(...seedFilePaths) as { content: string }[];
                const seedContent = contentRows.map(r => r.content).join('\n');

                if (seedContent.length > 0) {
                    // 2. Get class/interface/type symbols defined outside seed files
                    const candidateSymbols = this._db.prepare(
                        `SELECT DISTINCT name, file_path
                         FROM code_symbols
                         WHERE kind IN ('class', 'interface', 'type')
                           AND file_path NOT IN (${ph1})
                         ORDER BY name`
                    ).all(...seedFilePaths) as { name: string; file_path: string }[];

                    // 3. Check which symbol names appear in seed content (word boundary).
                    // Group candidates by name first so we add ALL defining files.
                    const nameToFiles = new Map<string, string[]>();
                    for (const sym of candidateSymbols) {
                        if (sym.name.length < 3) continue;
                        const list = nameToFiles.get(sym.name);
                        if (list) list.push(sym.file_path);
                        else nameToFiles.set(sym.name, [sym.file_path]);
                    }

                    for (const [name, files] of nameToFiles) {
                        // Skip overly generic names (e.g. LoaderData→29 files, Agent→19)
                        if (files.length > 5) continue;

                        // Regex word boundary — handles `PhoneNumber.find()` where
                        // indexOf would first hit `PhoneNumberData` and fail
                        const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
                        if (!re.test(seedContent)) continue;

                        for (const fp of files) {
                            if (!seedSet.has(fp)) neighbors.add(fp);
                        }
                    }
                }
            } catch {
                // Symbol tables may not exist in older schemas — fail silently
            }

            // Cap at 100 to keep manifest reasonable
            const result = [...neighbors];
            return result.length <= 100 ? result : result.slice(0, 100);
        } catch {
            return [];
        }
    }

    /** Fetch full chunk content by IDs. Used by the expander to resolve expansion IDs. */
    fetchChunksByIds(ids: number[]): ExpandedChunk[] {
        if (ids.length === 0) return [];
        try {
            const ph = ids.map(() => '?').join(',');
            return this._db.prepare(
                `SELECT id, file_path AS filePath, name, chunk_type AS chunkType,
                        start_line AS startLine, end_line AS endLine,
                        language, content
                 FROM code_chunks
                 WHERE id IN (${ph})`
            ).all(...ids) as ExpandedChunk[];
        } catch {
            return [];
        }
    }
}

/** Symbol info from code_symbols table. */
export interface SymbolInfo {
    filePath: string;
    name: string;
    kind: string;
    line: number;
}

/** Lightweight chunk descriptor for expander manifest. */
export interface ChunkManifestItem {
    id: number;
    filePath: string;
    name: string;
    chunkType: string;
    startLine: number;
    endLine: number;
}

/** Full chunk data returned when resolving expansion IDs. */
export interface ExpandedChunk {
    id: number;
    filePath: string;
    name: string;
    chunkType: string;
    startLine: number;
    endLine: number;
    language: string;
    content: string;
}

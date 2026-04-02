/**
 * @brainbank/code — Import Graph Traversal
 *
 * Bidirectional BFS traversal of the code_imports table to discover
 * related files. Builds a full dependency graph with depth, in/out
 * degree, and edge metadata.
 *
 * V2 improvements:
 * - Call graph fusion: follows code_refs → code_symbols edges to find
 *   files that define functions called by seed chunks
 * - Adaptive hops: hub files (in-degree > 5) get 3 hops instead of 2
 * - Weighted edges: 'type' imports have lower priority than runtime imports
 *
 * Forward BFS:  seed → what the seed imports (downstream)
 * Reverse BFS:  seed ← what imports the seed (upstream)
 * Symbol BFS:   seed → functions called → files defining them
 * Sibling clustering: directories with 3+ hits include all siblings.
 */

import { escapeLike } from 'brainbank';

/** Minimal DB interface for queries — avoids importing concrete Database class. */
interface DbLike {
    prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown };
}

// ── Types ───────────────────────────────────────────

/** A node in the dependency graph. */
export interface DependencyNode {
    filePath: string;
    depth: number;
    inDegree: number;
    outDegree: number;
    isSeed: boolean;
}

/** An edge in the dependency graph. */
export interface DependencyEdge {
    source: string;
    target: string;
    kind: string;
    resolved: boolean;
}

/** Complete dependency graph result. */
export interface DependencyGraph {
    nodes: DependencyNode[];
    edges: DependencyEdge[];
}

// ── Constants ───────────────────────────────────────

const MAX_NODES = 30;
const BASE_HOPS = 2;
const HUB_HOPS = 3;
const HUB_DEGREE_THRESHOLD = 5;

/** Import kinds that are runtime-critical (higher priority in BFS). */
const RUNTIME_KINDS = new Set(['static', 'require', 'dynamic', 'side-effect', 'export-from']);

// ── Public API ──────────────────────────────────────

/** Build a bidirectional dependency graph from seed files. */
export function buildDependencyGraph(
    db: DbLike, seedFiles: Set<string>, maxNodes: number = MAX_NODES,
): DependencyGraph {
    const nodeSet = new Set(seedFiles);
    const depthMap = new Map<string, number>();
    const edges: DependencyEdge[] = [];
    const edgeSet = new Set<string>();

    for (const s of seedFiles) depthMap.set(s, 0);

    // ── Forward BFS (downstream: what do seeds import?) ──────
    _forwardBFS(db, seedFiles, nodeSet, depthMap, edges, edgeSet, maxNodes);

    // ── Reverse BFS (upstream: what imports the seeds?) ───────
    _reverseBFS(db, seedFiles, nodeSet, depthMap, edges, edgeSet, maxNodes);

    // ── Symbol BFS (call graph: follow function call refs) ────
    _symbolBFS(db, seedFiles, nodeSet, depthMap, edges, edgeSet, maxNodes);

    // ── Sibling clustering ───────────────────────────────────
    _clusterSiblings(db, seedFiles, nodeSet, depthMap, maxNodes);

    // ── Compute degrees ─────────────────────────────────────
    const inDeg = new Map<string, number>();
    const outDeg = new Map<string, number>();
    for (const f of nodeSet) { inDeg.set(f, 0); outDeg.set(f, 0); }
    for (const e of edges) {
        if (nodeSet.has(e.source)) outDeg.set(e.source, (outDeg.get(e.source) ?? 0) + 1);
        if (nodeSet.has(e.target)) inDeg.set(e.target, (inDeg.get(e.target) ?? 0) + 1);
    }

    // ── Build node objects ──────────────────────────────────
    const nodes: DependencyNode[] = [...nodeSet].map(f => ({
        filePath: f,
        depth: depthMap.get(f) ?? 0,
        inDegree: inDeg.get(f) ?? 0,
        outDegree: outDeg.get(f) ?? 0,
        isSeed: seedFiles.has(f),
    }));

    // Sort: seeds first, then by absolute depth, then by total degree (descending)
    nodes.sort((a, b) => {
        if (a.isSeed !== b.isSeed) return a.isSeed ? -1 : 1;
        const absA = Math.abs(a.depth), absB = Math.abs(b.depth);
        if (absA !== absB) return absA - absB;
        return (b.inDegree + b.outDegree) - (a.inDegree + a.outDegree);
    });

    return { nodes, edges };
}

/** Legacy API — returns just the set of discovered file paths. */
export function expandViaImportGraph(db: DbLike, seedFiles: Set<string>): Set<string> {
    const graph = buildDependencyGraph(db, seedFiles);
    const discovered = new Set<string>();
    for (const node of graph.nodes) {
        if (!seedFiles.has(node.filePath)) discovered.add(node.filePath);
    }
    return discovered;
}

/** Fetch the most informative chunk per file (largest by line span). */
export function fetchBestChunks(db: DbLike, filePaths: string[]): Array<{
    filePath: string; content: string; name: string;
    chunkType: string; startLine: number; endLine: number; language: string;
}> {
    if (filePaths.length === 0) return [];

    const results: Array<{
        filePath: string; content: string; name: string;
        chunkType: string; startLine: number; endLine: number; language: string;
    }> = [];

    for (const fp of filePaths.slice(0, 15)) {
        try {
            const row = db.prepare(
                `SELECT file_path, content, name, chunk_type, start_line, end_line, language
                 FROM code_chunks WHERE file_path = ?
                 ORDER BY (end_line - start_line) DESC LIMIT 1`
            ).get(fp) as { file_path: string; content: string; name: string | null; chunk_type: string; start_line: number; end_line: number; language: string } | undefined;
            if (row) {
                results.push({
                    filePath: row.file_path, content: row.content, name: row.name ?? '',
                    chunkType: row.chunk_type ?? 'block', startLine: row.start_line,
                    endLine: row.end_line, language: row.language ?? '',
                });
            }
        } catch { /* ignore */ }
    }

    return results;
}

/** A chunk discovered via the call graph (caller calls callee). */
export interface CalledChunk {
    callerChunkId: number;
    callerFile: string;
    callerName: string;
    calleeChunkId: number;
    calleeFile: string;
    calleeName: string;
    calleeContent: string;
    calleeChunkType: string;
    calleeStartLine: number;
    calleeEndLine: number;
    calleeLanguage: string;
    symbolName: string;
}

/**
 * Fetch chunks that are called by the given seed chunk IDs via code_call_edges.
 * Returns the exact definition chunks, not just "best chunk per file".
 */
export function fetchCalledChunks(db: DbLike, seedChunkIds: number[]): CalledChunk[] {
    if (seedChunkIds.length === 0) return [];

    const results: CalledChunk[] = [];
    const seen = new Set<number>();

    for (const seedId of seedChunkIds.slice(0, 20)) {
        try {
            const rows = db.prepare(
                `SELECT
                    ce.caller_chunk_id,
                    caller.file_path AS caller_file,
                    caller.name AS caller_name,
                    ce.callee_chunk_id,
                    callee.file_path AS callee_file,
                    callee.name AS callee_name,
                    callee.content AS callee_content,
                    callee.chunk_type AS callee_chunk_type,
                    callee.start_line AS callee_start_line,
                    callee.end_line AS callee_end_line,
                    callee.language AS callee_language,
                    ce.symbol_name
                 FROM code_call_edges ce
                 JOIN code_chunks caller ON caller.id = ce.caller_chunk_id
                 JOIN code_chunks callee ON callee.id = ce.callee_chunk_id
                 WHERE ce.caller_chunk_id = ?
                   AND callee.file_path != caller.file_path
                 LIMIT 10`
            ).all(seedId) as Array<{
                caller_chunk_id: number; caller_file: string; caller_name: string | null;
                callee_chunk_id: number; callee_file: string; callee_name: string | null;
                callee_content: string; callee_chunk_type: string;
                callee_start_line: number; callee_end_line: number;
                callee_language: string; symbol_name: string;
            }>;

            for (const row of rows) {
                if (seen.has(row.callee_chunk_id)) continue;
                seen.add(row.callee_chunk_id);
                results.push({
                    callerChunkId: row.caller_chunk_id,
                    callerFile: row.caller_file,
                    callerName: row.caller_name ?? '',
                    calleeChunkId: row.callee_chunk_id,
                    calleeFile: row.callee_file,
                    calleeName: row.callee_name ?? '',
                    calleeContent: row.callee_content,
                    calleeChunkType: row.callee_chunk_type,
                    calleeStartLine: row.callee_start_line,
                    calleeEndLine: row.callee_end_line,
                    calleeLanguage: row.callee_language,
                    symbolName: row.symbol_name,
                });
            }
        } catch { /* code_call_edges might not exist */ }
    }

    return results;
}


// ── Call Tree (recursive workflow trace) ────────────

/** A node in the call tree — one function definition with its recursive callees. */
export interface CallTreeNode {
    chunkId: number;
    filePath: string;
    name: string;
    chunkType: string;
    startLine: number;
    endLine: number;
    language: string;
    content: string;
    /** The symbol name used in the call (e.g. 'on_vad_start'). */
    symbolName: string;
    /** Name of the function that calls this node. */
    callerName: string;
    /** Depth in the call tree (0 = seed, 1 = direct callee, etc.). */
    depth: number;
    /** Recursive children — functions called by this node. */
    children: CallTreeNode[];
}

/** Max call tree depth to prevent infinite recursion. */
const MAX_CALL_DEPTH = 3;
/** Max total nodes in the call tree. */
const MAX_CALL_NODES = 40;

/**
 * Build a recursive call tree from seed chunk IDs.
 * DFS traversal of code_call_edges, building a tree structure.
 * Only includes cross-file calls to avoid intra-file noise.
 * Deduplicates by chunk ID AND by function name (same-name classes across files).
 */
export function buildCallTree(db: DbLike, seedChunkIds: number[]): CallTreeNode[] {
    if (seedChunkIds.length === 0) return [];

    const seenChunks = new Set<number>();
    /** Dedup by qualified name — e.g. "TranscriptBuffer" seen once, skip duplicates. */
    const seenNames = new Set<string>();
    let totalNodes = 0;

    // Mark seeds as seen so they don't appear as their own callees
    for (const id of seedChunkIds) seenChunks.add(id);

    /** Get the position of symbolName in caller's source (for ordering). */
    function symbolPosition(callerChunkId: number, symbolName: string): number {
        try {
            const row = db.prepare(
                `SELECT content FROM code_chunks WHERE id = ?`
            ).get(callerChunkId) as { content: string } | undefined;
            if (!row) return 999;
            const idx = row.content.indexOf(symbolName);
            return idx >= 0 ? idx : 999;
        } catch { return 999; }
    }

    function expand(callerChunkId: number, depth: number): CallTreeNode[] {
        if (depth > MAX_CALL_DEPTH || totalNodes >= MAX_CALL_NODES) return [];

        try {
            const rows = db.prepare(
                `SELECT
                    ce.callee_chunk_id,
                    callee.file_path,
                    callee.name,
                    callee.chunk_type,
                    callee.start_line,
                    callee.end_line,
                    callee.language,
                    callee.content,
                    ce.symbol_name,
                    caller.file_path AS caller_file
                 FROM code_call_edges ce
                 JOIN code_chunks caller ON caller.id = ce.caller_chunk_id
                 JOIN code_chunks callee ON callee.id = ce.callee_chunk_id
                 WHERE ce.caller_chunk_id = ?
                   AND callee.file_path != caller.file_path
                 ORDER BY callee.file_path, callee.start_line
                 LIMIT 15`
            ).all(callerChunkId) as Array<{
                callee_chunk_id: number; file_path: string; name: string | null;
                chunk_type: string; start_line: number; end_line: number;
                language: string; content: string; symbol_name: string;
                caller_file: string;
            }>;

            // Sort by position of symbol_name in caller's source code
            const sorted = [...rows].sort((a, b) => {
                const posA = symbolPosition(callerChunkId, a.symbol_name);
                const posB = symbolPosition(callerChunkId, b.symbol_name);
                return posA - posB;
            });

            const children: CallTreeNode[] = [];
            for (const row of sorted) {
                if (seenChunks.has(row.callee_chunk_id)) continue;
                if (totalNodes >= MAX_CALL_NODES) break;

                // Name-based dedup: skip if we've already shown a chunk with this name
                const qualName = row.name ?? row.symbol_name;
                if (qualName && seenNames.has(qualName)) continue;

                seenChunks.add(row.callee_chunk_id);
                if (qualName) seenNames.add(qualName);
                totalNodes++;

                const node: CallTreeNode = {
                    chunkId: row.callee_chunk_id,
                    filePath: row.file_path,
                    name: row.name ?? '',
                    chunkType: row.chunk_type,
                    startLine: row.start_line,
                    endLine: row.end_line,
                    language: row.language,
                    content: row.content,
                    symbolName: row.symbol_name,
                    callerName: '',
                    depth,
                    children: [],
                };

                // Recurse into callees of this callee
                node.children = expand(row.callee_chunk_id, depth + 1);
                children.push(node);
            }

            return children;
        } catch {
            return [];
        }
    }

    // Build tree from each seed — set callerName on root nodes
    const roots: CallTreeNode[] = [];
    for (const seedId of seedChunkIds.slice(0, 10)) {
        // Look up seed name
        let seedName = '';
        try {
            const row = db.prepare(
                `SELECT name FROM code_chunks WHERE id = ?`
            ).get(seedId) as { name: string | null } | undefined;
            seedName = row?.name ?? '';
        } catch { /* ignore */ }

        const children = expand(seedId, 1);
        for (const child of children) {
            child.callerName = seedName;
        }
        roots.push(...children);
    }

    return roots;
}


// ── Adaptive hop count ──────────────────────────────

/** Determine max hops for a file based on its in-degree (hub detection). */
function _maxHopsFor(db: DbLike, file: string): number {
    try {
        const row = db.prepare(
            'SELECT COUNT(*) as cnt FROM code_imports WHERE imports_path = ? AND resolved = 1'
        ).get(file) as { cnt: number } | undefined;
        if (row && row.cnt >= HUB_DEGREE_THRESHOLD) return HUB_HOPS;
    } catch { /* ignore */ }
    return BASE_HOPS;
}

// ── Forward BFS ──────────────────────────────────────

function _forwardBFS(
    db: DbLike, seedFiles: Set<string>,
    nodeSet: Set<string>, depthMap: Map<string, number>,
    edges: DependencyEdge[], edgeSet: Set<string>,
    maxNodes: number,
): void {
    // Compute max hops from seed files (adaptive)
    let maxHops = BASE_HOPS;
    for (const s of seedFiles) {
        maxHops = Math.max(maxHops, _maxHopsFor(db, s));
    }

    let frontier = new Set(seedFiles);

    for (let hop = 0; hop < maxHops && frontier.size > 0 && nodeSet.size < maxNodes; hop++) {
        const nextFrontier = new Set<string>();

        for (const file of frontier) {
            if (nodeSet.size >= maxNodes) break;
            try {
                const rows = db.prepare(
                    'SELECT imports_path, import_kind, resolved FROM code_imports WHERE file_path = ? AND resolved = 1'
                ).all(file) as { imports_path: string; import_kind: string; resolved: number }[];

                // Sort: runtime imports first, type imports last
                rows.sort((a, b) => {
                    const aRuntime = RUNTIME_KINDS.has(a.import_kind) ? 0 : 1;
                    const bRuntime = RUNTIME_KINDS.has(b.import_kind) ? 0 : 1;
                    return aRuntime - bRuntime;
                });

                const curDepth = depthMap.get(file) ?? 0;

                for (const row of rows) {
                    const edgeKey = `${file}→${row.imports_path}`;
                    if (edgeSet.has(edgeKey)) continue;
                    edgeSet.add(edgeKey);

                    edges.push({
                        source: file,
                        target: row.imports_path,
                        kind: row.import_kind,
                        resolved: row.resolved === 1,
                    });

                    if (!nodeSet.has(row.imports_path)) {
                        nodeSet.add(row.imports_path);
                        depthMap.set(row.imports_path, curDepth + 1);
                        nextFrontier.add(row.imports_path);
                    }
                }
            } catch { /* table might not exist */ }
        }

        frontier = nextFrontier;
    }
}

// ── Reverse BFS ─────────────────────────────────────

function _reverseBFS(
    db: DbLike, seedFiles: Set<string>,
    nodeSet: Set<string>, depthMap: Map<string, number>,
    edges: DependencyEdge[], edgeSet: Set<string>,
    maxNodes: number,
): void {
    let frontier = new Set(seedFiles);

    for (let hop = 0; hop < BASE_HOPS && frontier.size > 0 && nodeSet.size < maxNodes; hop++) {
        const nextFrontier = new Set<string>();

        for (const file of frontier) {
            if (nodeSet.size >= maxNodes) break;
            try {
                const rows = db.prepare(
                    'SELECT file_path, import_kind, resolved FROM code_imports WHERE imports_path = ? AND resolved = 1'
                ).all(file) as { file_path: string; import_kind: string; resolved: number }[];

                // Sort: runtime imports first
                rows.sort((a, b) => {
                    const aRuntime = RUNTIME_KINDS.has(a.import_kind) ? 0 : 1;
                    const bRuntime = RUNTIME_KINDS.has(b.import_kind) ? 0 : 1;
                    return aRuntime - bRuntime;
                });

                const curDepth = depthMap.get(file) ?? 0;

                for (const row of rows) {
                    const edgeKey = `${row.file_path}→${file}`;
                    if (edgeSet.has(edgeKey)) continue;
                    edgeSet.add(edgeKey);

                    edges.push({
                        source: row.file_path,
                        target: file,
                        kind: row.import_kind,
                        resolved: row.resolved === 1,
                    });

                    if (!nodeSet.has(row.file_path)) {
                        nodeSet.add(row.file_path);
                        depthMap.set(row.file_path, curDepth - 1);
                        nextFrontier.add(row.file_path);
                    }
                }
            } catch { /* table might not exist */ }
        }

        frontier = nextFrontier;
    }
}

// ── Symbol BFS (call graph fusion) ──────────────────

/**
 * Follow function calls from seed chunks to discover files that
 * define the called symbols. This bridges the import graph with
 * the call graph for deeper relationships.
 *
 * Flow: seed file chunks → code_refs (calls) → code_symbols (definitions) → file_path
 */
function _symbolBFS(
    db: DbLike, seedFiles: Set<string>,
    nodeSet: Set<string>, depthMap: Map<string, number>,
    edges: DependencyEdge[], edgeSet: Set<string>,
    maxNodes: number,
): void {
    if (nodeSet.size >= maxNodes) return;

    for (const seedFile of seedFiles) {
        if (nodeSet.size >= maxNodes) break;
        try {
            // Get all symbols called by chunks in this seed file
            const calledSymbols = db.prepare(
                `SELECT DISTINCT cr.symbol_name
                 FROM code_refs cr
                 JOIN code_chunks cc ON cc.id = cr.chunk_id
                 WHERE cc.file_path = ?
                 LIMIT 20`
            ).all(seedFile) as { symbol_name: string }[];

            for (const { symbol_name } of calledSymbols) {
                if (nodeSet.size >= maxNodes) break;

                // Find where this symbol is defined
                const definitions = db.prepare(
                    `SELECT DISTINCT file_path FROM code_symbols
                     WHERE name = ? AND file_path != ?
                     LIMIT 3`
                ).all(symbol_name, seedFile) as { file_path: string }[];

                for (const def of definitions) {
                    if (nodeSet.size >= maxNodes) break;

                    // Add edge: seed calls symbol in def.file_path
                    const edgeKey = `${seedFile}⟶${def.file_path}`;
                    if (edgeSet.has(edgeKey)) continue;
                    edgeSet.add(edgeKey);

                    edges.push({
                        source: seedFile,
                        target: def.file_path,
                        kind: 'call',
                        resolved: true,
                    });

                    if (!nodeSet.has(def.file_path)) {
                        nodeSet.add(def.file_path);
                        depthMap.set(def.file_path, 1); // downstream depth 1
                    }
                }
            }
        } catch { /* tables might not exist */ }
    }
}

// ── Sibling clustering ──────────────────────────────

function _clusterSiblings(
    db: DbLike, seedFiles: Set<string>,
    nodeSet: Set<string>, depthMap: Map<string, number>,
    maxNodes: number,
): void {
    const dirCounts = new Map<string, number>();
    for (const f of seedFiles) {
        const dir = f.split('/').slice(0, -1).join('/');
        dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1);
    }

    for (const [dir, count] of dirCounts) {
        if (count < 3 || !dir || nodeSet.size >= maxNodes) continue;
        try {
            const escapedDir = escapeLike(dir);
            const siblings = db.prepare(
                `SELECT DISTINCT file_path FROM code_chunks WHERE file_path LIKE ? ESCAPE '\\' AND file_path NOT LIKE ? ESCAPE '\\'`
            ).all(`${escapedDir}/%`, `${escapedDir}/%/%`) as { file_path: string }[];
            for (const row of siblings) {
                if (nodeSet.size >= maxNodes) break;
                if (!nodeSet.has(row.file_path)) {
                    nodeSet.add(row.file_path);
                    depthMap.set(row.file_path, 0);
                }
            }
        } catch { /* ignore */ }
    }
}

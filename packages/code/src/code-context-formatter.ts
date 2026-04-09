/**
 * @brainbank/code — Code Context Formatter
 *
 * Produces a SINGLE flat section with ALL code involved in a workflow.
 * No sub-sections. No trimming. No truncation. No duplicates.
 *
 * Each chunk shows:
 *   - File path header
 *   - Name + line range
 *   - "called by X" annotation showing who invokes it
 *   - Full source code
 *
 * Chunks are ordered topologically: callers before callees (execution flow).
 * Test files are excluded from the call tree.
 */

import type { SearchResult } from 'brainbank';
import { isCodeResult } from 'brainbank';

import type { CodeGraphProvider, CallTreeNode, AdjacentPart, SymbolInfo } from './sql-code-graph.js';

// ── Public API ──────────────────────────────────────

/** Format all code context as a single flat workflow trace. */
export function formatCodeContext(
    codeHits: SearchResult[],
    parts: string[],
    codeGraph?: CodeGraphProvider,
    pathPrefix?: string,
    fields: Record<string, unknown> = {},
): void {
    if (codeHits.length === 0) return;

    const showLines = fields.lines === true;
    const showImports = fields.imports !== false; // default: true
    const showCallTree = fields.callTree !== false; // default: true
    const callTreeDepth = _resolveCallTreeDepth(fields.callTree);
    const showSymbols = fields.symbols === true;
    const showCompact = fields.compact === true;

    parts.push('## Code Context\n');

    if (!codeGraph) {
        // No graph available — just render search hits
        _renderHitsFlat(codeHits, parts, showLines);
        return;
    }

    // 1. Collect seed chunk IDs from search hits
    const seedIds = _collectChunkIds(codeHits);

    // 2. Expand multi-part hits: if "foo (part 5)" matched, fetch ±2 parts
    const expandedHits = _expandAdjacentParts(codeHits, codeGraph, pathPrefix);

    // 3. Build the full call tree (recursive, no trimming)
    const callTree = (showCallTree && seedIds.length > 0)
        ? codeGraph.buildCallTree(seedIds, callTreeDepth)
        : [];

    // 4. Flatten everything into a single ordered list
    const allChunks = _buildFlatList(expandedHits, callTree, pathPrefix);

    // 5. Render as a single flat section
    let currentFile = '';
    for (const chunk of allChunks) {
        // File header (only when file changes)
        if (chunk.filePath !== currentFile) {
            currentFile = chunk.filePath;
            parts.push(`### ${currentFile}`);
        }

        // Label with "called by" annotation
        const label = chunk.name
            ? `${chunk.chunkType} \`${chunk.name}\` (L${chunk.startLine}-${chunk.endLine})`
            : `L${chunk.startLine}-${chunk.endLine}`;

        const annotations: string[] = [];
        if (chunk.score !== undefined && chunk.score >= 0) {
            annotations.push(`${Math.round(chunk.score * 100)}% match`);
        }
        if (chunk.calledBy) {
            annotations.push(`called by \`${chunk.calledBy}\``);
        }
        if (chunk.callCount > 0) {
            annotations.push(`calls ${chunk.callCount} more`);
        }

        const suffix = annotations.length > 0 ? ` — ${annotations.join(', ')}` : '';

        // Trivial wrapper check: non-search-hit chunks (score undefined or -1)
        // with ≤2 meaningful code lines get a compact one-liner instead of full block
        const isSearchHit = chunk.score !== undefined && chunk.score >= 0;
        if (!isSearchHit && _isTrivialBody(chunk.content)) {
            const oneLiner = _extractOneLiner(chunk.content);
            parts.push(`**${label}**${suffix} → \`${oneLiner}\`\n`);
            continue;
        }

        // Compact mode: show only first signature line + symbol listing
        if (showCompact && !isSearchHit) {
            const sig = _extractSignature(chunk.content);
            parts.push(`**${label}**${suffix} → \`${sig}\`\n`);
            continue;
        }

        parts.push(`**${label}**${suffix}`);
        parts.push('```' + (chunk.language || ''));
        parts.push(`// ${chunk.filePath} L${chunk.startLine}-${chunk.endLine}`);
        parts.push(_formatContent(chunk.content, chunk.startLine, showLines));
        parts.push('```\n');
    }

    // 6. Symbol index (if enabled)
    if (showSymbols) {
        _renderSymbolIndex(codeHits, parts, codeGraph, pathPrefix);
    }

    // 7. Compact dependency summary (just file names)
    if (showImports) {
        _renderDependencySummary(codeHits, parts, codeGraph, pathPrefix);
    }
}

// ── Types ───────────────────────────────────────────

interface FlatChunk {
    filePath: string;
    name: string;
    chunkType: string;
    startLine: number;
    endLine: number;
    language: string;
    content: string;
    score?: number;
    calledBy?: string;
    callCount: number;
}

/**
 * Build a flat, topologically-ordered list of all involved chunks.
 * Search hits come first (callers), then their callees in DFS order.
 * No duplicates — each chunk appears exactly once.
 */
function _buildFlatList(
    codeHits: SearchResult[],
    callTree: CallTreeNode[],
    pathPrefix?: string,
): FlatChunk[] {
    const seen = new Set<string>(); // key: filePath:startLine
    const result: FlatChunk[] = [];

    // Helper to generate dedup key
    const key = (fp: string, sl: number) => `${fp}:${sl}`;

    // Build seedId→name map for "called by" annotations
    const seedNames = new Map<number, string>();
    for (const hit of codeHits) {
        if (isCodeResult(hit) && hit.metadata.id) {
            seedNames.set(hit.metadata.id, hit.metadata.name ?? '');
        }
    }

    // 1. Add search hits first (these are the "entry points")
    for (const hit of codeHits) {
        if (!isCodeResult(hit)) continue;
        const m = hit.metadata;
        const k = key(m.filePath ?? hit.filePath ?? '', m.startLine);
        if (seen.has(k)) continue;
        seen.add(k);

        result.push({
            filePath: m.filePath ?? hit.filePath ?? '',
            name: m.name ?? '',
            chunkType: m.chunkType ?? 'block',
            startLine: m.startLine,
            endLine: m.endLine,
            language: m.language ?? '',
            content: hit.content,
            score: hit.score,
            callCount: 0,
        });
    }

    // 2. Walk the call tree in DFS order, adding callees.
    // Each node carries callerName (set by buildCallTree for roots, by us for deeper nodes).
    function walkTree(nodes: CallTreeNode[]): void {
        for (const node of nodes) {
            // Filter test files and generic infrastructure
            if (_isTestFile(node.filePath)) continue;
            if (_isInfraFile(node.filePath)) continue;

            const k = key(node.filePath, node.startLine);
            if (seen.has(k)) continue;
            seen.add(k);

            result.push({
                filePath: pathPrefix ? `${pathPrefix}/${node.filePath}` : node.filePath,
                name: node.name,
                chunkType: node.chunkType,
                startLine: node.startLine,
                endLine: node.endLine,
                language: node.language,
                content: node.content,
                calledBy: node.callerName || undefined,
                callCount: node.children.length,
            });

            // Set callerName on children before recursing
            if (node.children.length > 0) {
                const myName = node.name || node.symbolName;
                for (const child of node.children) {
                    child.callerName = myName;
                }
                walkTree(node.children);
            }
        }
    }

    walkTree(callTree);

    // 3. Remove chunks fully contained within another chunk from the same file.
    // E.g. if the expander returns a file synopsis (L1-80) alongside individual
    // function chunks (L5-30, L32-50), the synopsis already includes the others.
    return _deduplicateContainedChunks(result);
}

/**
 * Remove FlatChunks whose line range is fully contained within another
 * chunk from the same file. Keeps the larger chunk which already
 * contains the smaller one's content.
 */
function _deduplicateContainedChunks(chunks: FlatChunk[]): FlatChunk[] {
    if (chunks.length <= 1) return chunks;

    // Group by file
    const byFile = new Map<string, FlatChunk[]>();
    for (const c of chunks) {
        const group = byFile.get(c.filePath) ?? [];
        group.push(c);
        byFile.set(c.filePath, group);
    }

    // Find chunks to remove
    const remove = new Set<FlatChunk>();
    for (const group of byFile.values()) {
        if (group.length <= 1) continue;
        for (let i = 0; i < group.length; i++) {
            for (let j = 0; j < group.length; j++) {
                if (i === j) continue;
                const inner = group[i];
                const outer = group[j];
                // inner is fully contained within outer
                if (inner.startLine >= outer.startLine && inner.endLine <= outer.endLine) {
                    remove.add(inner);
                }
            }
        }
    }

    if (remove.size === 0) return chunks;
    return chunks.filter(c => !remove.has(c));
}

/** Check if a file path looks like a test file. */
function _isTestFile(filePath: string): boolean {
    const lower = filePath.toLowerCase();
    return lower.includes('test/') || lower.includes('tests/')
        || lower.includes('__tests__') || lower.includes('test_')
        || lower.startsWith('test') || lower.includes('.test.')
        || lower.includes('.spec.');
}

/**
 * Check if a file path is generic infrastructure (noise when shown as callee).
 * Logging, config, common utils, font loaders, plugin setup, and app bootstrap
 * are too generic to be useful in call trees.
 */
function _isInfraFile(filePath: string): boolean {
    const lower = filePath.toLowerCase();
    return lower.includes('/logging/') || lower.includes('/logger')
        || lower.includes('/config/') || lower.includes('config.service')
        || lower.includes('/common/') || lower.includes('/shared/utils')
        || lower.includes('/interceptors/') || lower.includes('/guards/')
        || lower.includes('/filters/') || lower.includes('/middleware/')
        // Project bootstrap / plugin setup
        || lower.includes('webfontloader') || lower.includes('fontloader')
        || lower.includes('/polyfill') || lower.includes('polyfill.')
        || lower.includes('/plugins/') || lower.includes('plugin-setup')
        || lower.includes('vuetify.') || lower.includes('vite.config')
        || lower.includes('webpack.config') || lower.includes('tsconfig');
}

// ── Fallback: no graph ──────────────────────────────

/** Render search hits without graph enrichment. */
function _renderHitsFlat(codeHits: SearchResult[], parts: string[], showLines: boolean): void {
    let currentFile = '';
    for (const hit of codeHits) {
        if (!isCodeResult(hit)) continue;
        const m = hit.metadata;
        const filePath = m.filePath ?? hit.filePath ?? '';

        if (filePath !== currentFile) {
            currentFile = filePath;
            parts.push(`### ${currentFile}`);
        }

        const label = m.name
            ? `${m.chunkType} \`${m.name}\` (L${m.startLine}-${m.endLine})`
            : `L${m.startLine}-${m.endLine}`;

        parts.push(`**${label}** — ${Math.round(hit.score * 100)}% match`);
        parts.push('```' + (m.language || ''));
        parts.push(`// ${filePath} L${m.startLine}-${m.endLine}`);
        parts.push(_formatContent(hit.content, m.startLine, showLines));
        parts.push('```\n');
    }
}

// ── Dependency Summary ──────────────────────────────

/** Compact dependency summary — split into downstream (imports) and upstream (dependents). */
function _renderDependencySummary(
    codeHits: SearchResult[],
    parts: string[],
    codeGraph: CodeGraphProvider,
    pathPrefix?: string,
): void {
    // Strip sub-repo prefix for DB lookup (DB stores unprefixed paths)
    const strip = (fp: string) => pathPrefix && fp.startsWith(pathPrefix + '/') 
        ? fp.slice(pathPrefix.length + 1) : fp;
    const add = (fp: string) => pathPrefix ? `${pathPrefix}/${fp}` : fp;
    const hitFiles = new Set(
        codeHits.map(r => r.filePath).filter(Boolean).map(fp => strip(fp as string)),
    );
    const graph = codeGraph.buildDependencyGraph(hitFiles);

    const nonSeed = graph.nodes.filter(n => !n.isSeed);
    if (nonSeed.length === 0) return;

    // Split by depth: positive = downstream (what matched code imports),
    // negative = upstream (what imports the matched code), zero = siblings
    const downstream = nonSeed.filter(n => n.depth >= 0);
    const upstream = nonSeed.filter(n => n.depth < 0);

    parts.push('---\n');

    const sortByDegree = (a: { inDegree: number; outDegree: number }, b: { inDegree: number; outDegree: number }) =>
        (b.inDegree + b.outDegree) - (a.inDegree + a.outDegree);

    if (downstream.length > 0) {
        const fileList = downstream.sort(sortByDegree).map(n => `\`${add(n.filePath)}\``).join(', ');
        parts.push(`**Dependencies** (${downstream.length} files imported by matched code): ${fileList}\n`);
    }

    if (upstream.length > 0) {
        const fileList = upstream.sort(sortByDegree).map(n => `\`${add(n.filePath)}\``).join(', ');
        parts.push(`**Dependents** (${upstream.length} files that import matched code): ${fileList}\n`);
    }
}

// ── Helpers ─────────────────────────────────────────

function _collectChunkIds(codeHits: SearchResult[]): number[] {
    const ids: number[] = [];
    for (const r of codeHits) {
        if (!isCodeResult(r)) continue;
        // File-level results carry all chunk IDs in metadata.chunkIds
        const chunkIds = r.metadata.chunkIds as number[] | undefined;
        if (chunkIds && Array.isArray(chunkIds)) {
            ids.push(...chunkIds);
        } else if (r.metadata.id) {
            ids.push(r.metadata.id);
        }
    }
    return ids;
}

/** Regex to detect multi-part chunk names: "foo (part N)" */
const PART_RE = /^(.+) \(part (\d+)\)$/;

/** Maximum number of adjacent parts to include on each side of the hit. */
const MAX_ADJACENT_RADIUS = 2;

/**
 * Expand multi-part search hits: if "foo (part 5)" matched,
 * fetch siblings within ±MAX_ADJACENT_RADIUS (parts 3–7).
 * Non-part hits pass through unchanged.
 */
function _expandAdjacentParts(
    codeHits: SearchResult[],
    codeGraph: CodeGraphProvider,
    pathPrefix?: string,
): SearchResult[] {
    const expanded: SearchResult[] = [];
    const seenIds = new Set<number>();

    for (const hit of codeHits) {
        if (!isCodeResult(hit)) {
            expanded.push(hit);
            continue;
        }

        // Already seen (from a previous expansion)
        if (hit.metadata.id && seenIds.has(hit.metadata.id)) continue;

        const name = hit.metadata.name ?? '';
        const match = PART_RE.exec(name);

        if (!match) {
            // Not a multi-part chunk — pass through
            expanded.push(hit);
            if (hit.metadata.id) seenIds.add(hit.metadata.id);
            continue;
        }

        // Fetch all sibling parts from DB
        const baseName = match[1];
        const hitPartNum = parseInt(match[2], 10);
        // Strip sub-repo prefix for DB lookup (DB stores unprefixed paths)
    const lookupPath = pathPrefix && hit.filePath.startsWith(pathPrefix + '/') 
        ? hit.filePath.slice(pathPrefix.length + 1) 
        : hit.filePath;
    const siblings = codeGraph.fetchAdjacentParts(lookupPath, baseName);

        if (siblings.length <= 1) {
            // No siblings found — render as-is
            expanded.push(hit);
            if (hit.metadata.id) seenIds.add(hit.metadata.id);
            continue;
        }

        // Cap to ±MAX_ADJACENT_RADIUS around the hit part
        const minPart = hitPartNum - MAX_ADJACENT_RADIUS;
        const maxPart = hitPartNum + MAX_ADJACENT_RADIUS;

        // Insert capped sibling parts in order (by start_line)
        for (let i = 0; i < siblings.length; i++) {
            const sib = siblings[i];
            const sibPartNum = i + 1; // parts are 1-indexed, sorted by start_line
            if (sibPartNum < minPart || sibPartNum > maxPart) continue;
            if (seenIds.has(sib.id)) continue;
            seenIds.add(sib.id);

            // Check if this sibling IS the original hit (keep its score)
            if (sib.id === hit.metadata.id) {
                expanded.push(hit);
            } else {
                // Synthesize a CodeResult for the adjacent part
                expanded.push({
                    type: 'code' as const,
                    content: sib.content,
                    filePath: pathPrefix ? `${pathPrefix}/${sib.filePath}` : sib.filePath,
                    score: -1, // sentinel: adjacent part (not a search hit)
                    metadata: {
                        id: sib.id,
                        name: sib.name,
                        chunkType: sib.chunkType,
                        startLine: sib.startLine,
                        endLine: sib.endLine,
                        language: sib.language,
                    },
                });
            }
        }
    }

    return expanded;
}

/**
 * Check if a chunk's body is trivial (≤2 meaningful code lines).
 * Strips docstrings, comments, blank lines, decorators, type hints,
 * and boilerplate like `pass` / `...` / `return`.
 */
function _isTrivialBody(content: string): boolean {
    const lines = content.split('\n');

    let inDocstring = false;
    let meaningful = 0;

    for (const raw of lines) {
        const line = raw.trim();

        // Toggle docstring blocks
        if (line.startsWith('"""') || line.startsWith("'''")) {
            // Single-line docstring: """text""" — skip it
            const q = line.slice(0, 3);
            const rest = line.slice(3);
            if (rest.includes(q)) {
                continue; // one-liner docstring
            }
            inDocstring = !inDocstring;
            continue;
        }
        if (inDocstring) continue;

        // Skip blanks, comments, decorators, type hints, def/class sigs
        if (!line) continue;
        if (line.startsWith('#') || line.startsWith('//') || line.startsWith('/*') || line.startsWith('*')) continue;
        if (line.startsWith('@')) continue;
        if (line.startsWith('def ') || line.startsWith('async def ') || line.startsWith('class ')) continue;
        if (line === 'pass' || line === '...' || line === 'pass  # no-op') continue;

        meaningful++;
        if (meaningful > 2) return false; // early exit
    }

    return meaningful <= 2;
}

/** Extract a compact one-liner from a trivial chunk body. */
function _extractOneLiner(content: string): string {
    const lines = content.split('\n');

    let inDocstring = false;
    for (const raw of lines) {
        const line = raw.trim();

        // Skip docstrings
        if (line.startsWith('"""') || line.startsWith("'''")) {
            const q = line.slice(0, 3);
            const rest = line.slice(3);
            if (rest.includes(q)) continue;
            inDocstring = !inDocstring;
            continue;
        }
        if (inDocstring) continue;

        // Skip blanks, comments, decorators, sigs
        if (!line) continue;
        if (line.startsWith('#') || line.startsWith('//') || line.startsWith('/*') || line.startsWith('*')) continue;
        if (line.startsWith('@')) continue;
        if (line.startsWith('def ') || line.startsWith('async def ') || line.startsWith('class ')) continue;
        if (line === 'pass' || line === '...') continue;

        // This is the first meaningful line — use it
        return line.length > 80 ? line.slice(0, 77) + '...' : line;
    }

    return 'pass';
}

// ── BrainBankQL Field Helpers ───────────────────────

/**
 * Format content with optional line number annotations.
 * When `showLines` is true, each line is prefixed with its source line number:
 *   127| export class PinecallAgent extends Agent {
 *   128|     override model = "gpt-4.1-nano";
 */
function _formatContent(content: string, startLine: number, showLines: boolean): string {
    if (!showLines) return content;

    const lines = content.split('\n');
    const maxLineNum = startLine + lines.length - 1;
    const padWidth = String(maxLineNum).length;

    return lines
        .map((line, i) => `${String(startLine + i).padStart(padWidth)}| ${line}`)
        .join('\n');
}

/**
 * Resolve the callTree field value to a numeric depth.
 * - `true` or `undefined` → default depth (undefined, use hardcoded)
 * - `false` → 0 (disabled, handled by caller)
 * - `{ depth: N }` → N
 * - number → N
 */
function _resolveCallTreeDepth(value: unknown): number | undefined {
    if (value === false || value === 0) return 0;
    if (typeof value === 'number') return value;
    if (typeof value === 'object' && value !== null && 'depth' in value) {
        return (value as { depth: number }).depth;
    }
    return undefined; // use default
}

/**
 * Extract a compact signature from a chunk's content.
 * Shows the first non-comment, non-blank line (typically the function/class declaration).
 */
function _extractSignature(content: string): string {
    const lines = content.split('\n');
    for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        if (line.startsWith('//') || line.startsWith('#') || line.startsWith('/*') || line.startsWith('*')) continue;
        if (line.startsWith('@')) continue;
        return line.length > 100 ? line.slice(0, 97) + '...' : line;
    }
    return '...';
}

/**
 * Render a symbol index section — all functions, classes, interfaces
 * from matched files, grouped by file path.
 */
function _renderSymbolIndex(
    codeHits: SearchResult[],
    parts: string[],
    codeGraph: CodeGraphProvider,
    pathPrefix?: string,
): void {
    // Collect unique file paths from search hits
    const strip = (fp: string) => pathPrefix && fp.startsWith(pathPrefix + '/')
        ? fp.slice(pathPrefix.length + 1) : fp;
    const add = (fp: string) => pathPrefix ? `${pathPrefix}/${fp}` : fp;

    const filePaths = [...new Set(
        codeHits
            .filter(r => r.filePath)
            .map(r => strip(r.filePath as string)),
    )];

    if (!('fetchSymbolsForFiles' in codeGraph)) return;
    const symbols = (codeGraph as unknown as { fetchSymbolsForFiles(fps: string[]): SymbolInfo[] })
        .fetchSymbolsForFiles(filePaths);

    if (symbols.length === 0) return;

    parts.push('---\n');
    parts.push('## Symbol Index\n');

    // Group by file
    let currentFile = '';
    for (const sym of symbols) {
        const displayPath = add(sym.filePath);
        if (displayPath !== currentFile) {
            currentFile = displayPath;
            parts.push(`### ${currentFile}`);
        }
        parts.push(`  ${sym.kind} ${sym.name} (L${sym.line})`);
    }
    parts.push('');
}

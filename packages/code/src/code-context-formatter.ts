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

import type { CodeGraphProvider, CallTreeNode, AdjacentPart } from './sql-code-graph.js';

// ── Public API ──────────────────────────────────────

/** Format all code context as a single flat workflow trace. */
export function formatCodeContext(
    codeHits: SearchResult[],
    parts: string[],
    codeGraph?: CodeGraphProvider,
): void {
    if (codeHits.length === 0) return;

    parts.push('## Code Context\n');

    if (!codeGraph) {
        // No graph available — just render search hits
        _renderHitsFlat(codeHits, parts);
        return;
    }

    // 1. Collect seed chunk IDs from search hits
    const seedIds = _collectChunkIds(codeHits);

    // 2. Expand multi-part hits: if "foo (part 5)" matched, fetch ±2 parts
    const expandedHits = _expandAdjacentParts(codeHits, codeGraph);

    // 3. Build the full call tree (recursive, no trimming)
    const callTree = seedIds.length > 0 ? codeGraph.buildCallTree(seedIds) : [];

    // 4. Flatten everything into a single ordered list
    const allChunks = _buildFlatList(expandedHits, callTree);

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

        parts.push(`**${label}**${suffix}`);
        parts.push('```' + (chunk.language || ''));
        parts.push(chunk.content);
        parts.push('```\n');
    }

    // 5. Compact dependency summary (just file names)
    _renderDependencySummary(codeHits, parts, codeGraph);
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
                filePath: node.filePath,
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

    return result;
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
 * Logging, config, common utils are too generic to be useful in call trees.
 */
function _isInfraFile(filePath: string): boolean {
    const lower = filePath.toLowerCase();
    return lower.includes('/logging/') || lower.includes('/logger')
        || lower.includes('/config/') || lower.includes('config.service')
        || lower.includes('/common/') || lower.includes('/shared/utils')
        || lower.includes('/interceptors/') || lower.includes('/guards/')
        || lower.includes('/filters/') || lower.includes('/middleware/');
}

// ── Fallback: no graph ──────────────────────────────

/** Render search hits without graph enrichment. */
function _renderHitsFlat(codeHits: SearchResult[], parts: string[]): void {
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
        parts.push(hit.content);
        parts.push('```\n');
    }
}

// ── Dependency Summary ──────────────────────────────

/** Compact dependency summary — just file list, no source code. */
function _renderDependencySummary(
    codeHits: SearchResult[],
    parts: string[],
    codeGraph: CodeGraphProvider,
): void {
    const hitFiles = new Set(codeHits.map(r => r.filePath).filter(Boolean) as string[]);
    const graph = codeGraph.buildDependencyGraph(hitFiles);

    const nonSeed = graph.nodes.filter(n => !n.isSeed);
    if (nonSeed.length === 0) return;

    parts.push('---\n');

    const fileList = nonSeed
        .sort((a, b) => (b.inDegree + b.outDegree) - (a.inDegree + a.outDegree))
        .map(n => `\`${n.filePath}\``).join(', ');

    parts.push(`**Dependencies** (${nonSeed.length} files imported by matched code): ${fileList}\n`);
}

// ── Helpers ─────────────────────────────────────────

function _collectChunkIds(codeHits: SearchResult[]): number[] {
    const ids: number[] = [];
    for (const r of codeHits) {
        if (isCodeResult(r) && r.metadata.id) {
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
        const siblings = codeGraph.fetchAdjacentParts(hit.filePath, baseName);

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
                    filePath: sib.filePath,
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

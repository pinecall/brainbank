/**
 * stats-tui.tsx — Interactive Ink TUI for `brainbank stats`.
 *
 * Split-panel layout with 4 views:
 *   1. Dashboard — overview, language bars, directory list
 *   2. File Explorer — drill into directory, file list + detail
 *   3. Chunk Viewer — browse chunks, preview content
 *   4. Call Graph — interactive call tree
 *
 * Reuses patterns & colors from index-tui.tsx.
 */

import React, { useState, useMemo, useEffect } from 'react';
import { render, Box, Text, useApp, useInput, useStdout } from 'ink';
import {
    fetchOverview, fetchLanguageBreakdown, fetchDirectories,
    fetchFilesInDir, fetchFileDetail, fetchChunksForFile, fetchCallTree,
    searchSymbols, searchChunks, fetchChunkById,
} from './stats-data.ts';
import type {
    StatsOverview, LanguageStat, DirectoryStat,
    FileStat, FileDetailInfo, ChunkInfo, CallTreeNode, SearchResultItem,
} from './stats-data.ts';


// ── Colors (Aurora palette — same as index-tui) ───────

const C = {
    aurora:  '#7AA2F7',
    success: '#9ECE6A',
    error:   '#F7768E',
    warning: '#E0AF68',
    dim:     '#565F89',
    text:    '#C0CAF5',
    border:  '#3B4261',
    cyan:    '#7DCFFF',
    purple:  '#BB9AF7',
    orange:  '#FF9E64',
    dir:     '#E0AF68',
} as const;

// Use 90% of terminal — cleared on launch for full-screen feel.

// ── Language colors / badges ──────────────────────

const LANG_COLORS: Record<string, string> = {
    python:     '#4B8BBE',
    typescript: '#519ABA',
    javascript: '#CBCB41',
    css:        '#42A5F5',
    go:         '#7FD5EA',
    rust:       '#DEA584',
    ruby:       '#CC3E44',
    java:       '#CC3E44',
    c:          '#599EFF',
    cpp:        '#599EFF',
};

const LANG_BADGES: Record<string, string> = {
    python: 'PY', typescript: 'TS', javascript: 'JS', css: 'CS',
    go: 'GO', rust: 'RS', ruby: 'RB', java: 'JV', c: 'C ', cpp: 'C+',
};

function langColor(lang: string): string { return LANG_COLORS[lang] ?? C.text; }
function langBadge(lang: string): string { return LANG_BADGES[lang] ?? lang.slice(0, 2).toUpperCase(); }


// ── Utilities ───────────────────────────────────────

function centerScroll(cursor: number, total: number, viewH: number): number {
    if (total <= viewH) return 0;
    const half = Math.floor(viewH / 2);
    const offset = Math.max(0, cursor - half);
    return Math.min(offset, total - viewH);
}

function bar(percent: number, width: number): string {
    const filled = Math.round(percent / 100 * width);
    return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled));
}

function truncate(str: string, max: number): string {
    return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

type View = 'dashboard' | 'files' | 'chunks' | 'callgraph' | 'search';


// ── Dashboard View ────────────────────────────────

function DashboardView({ overview, languages, dirs, width, height, onDrillDir, onCallGraph, onSearch }: {
    overview: StatsOverview;
    languages: LanguageStat[];
    dirs: DirectoryStat[];
    width: number;
    height: number;
    onDrillDir: (dir: string) => void;
    onCallGraph: () => void;
    onSearch: () => void;
}): React.ReactNode {
    const [cursor, setCursor] = useState(0);

    useInput((input, key) => {
        if (key.downArrow) setCursor(c => Math.min(c + 1, dirs.length - 1));
        if (key.upArrow) setCursor(c => Math.max(c - 1, 0));
        if (key.return && dirs[cursor]) onDrillDir(dirs[cursor].dir);
        if (input === 'g') onCallGraph();
        if (input === '/') onSearch();
    });

    const leftW = 30;
    const rightW = Math.max(40, width - leftW - 5);
    const barW = Math.max(10, rightW - 35);

    return (
        <Box flexDirection="row" width={width} height={height - 4}>
            {/* Left: Overview */}
            <Box flexDirection="column" width={leftW} paddingX={1}>
                <Box marginBottom={1}>
                    <Text color={C.aurora} bold>Overview</Text>
                </Box>
                <Text color={C.text}>  📁 <Text bold>{overview.files}</Text> files</Text>
                <Text color={C.text}>  🧩 <Text bold>{overview.chunks}</Text> chunks</Text>
                <Text color={C.text}>  🔗 <Text bold>{overview.callEdges}</Text> call edges</Text>
                <Text color={C.text}>  📥 <Text bold>{overview.importEdges}</Text> imports</Text>
                <Text color={C.text}>  🏷  <Text bold>{overview.symbols}</Text> symbols</Text>
                <Text color={C.text}>  📊 <Text bold>{overview.dbSizeMB}</Text> MB db</Text>
                <Text color={C.text}>  🔍 <Text bold>{overview.hnswSize}</Text> vectors</Text>
                <Box marginTop={1}>
                    <Text color={C.dim}>Embedding:</Text>
                </Box>
                <Text color={C.cyan}>  {overview.embeddingModel}</Text>
                <Text color={C.dim}>  Pruner: <Text color={C.text}>{overview.pruner}</Text></Text>
                <Text color={C.dim}>  Expander: <Text color={C.text}>{overview.expander}</Text></Text>
            </Box>

            {/* Right: Languages + Directories */}
            <Box flexDirection="column" width={rightW} paddingX={1}>
                <Box marginBottom={1}>
                    <Text color={C.aurora} bold>Language Breakdown</Text>
                </Box>
                {languages.map(lang => (
                    <Box key={lang.language} height={1}>
                        <Text wrap="truncate">
                            <Text color={langColor(lang.language)} bold>{langBadge(lang.language)}</Text>
                            <Text> </Text>
                            <Text color={langColor(lang.language)}>{bar(lang.percent, barW)}</Text>
                            <Text color={C.dim}> {String(lang.chunks).padStart(4)} </Text>
                            <Text color={C.dim}>{lang.percent.toFixed(1).padStart(5)}%</Text>
                        </Text>
                    </Box>
                ))}

                <Box marginTop={1} marginBottom={1}>
                    <Text color={C.aurora} bold>Directories</Text>
                    <Text color={C.dim}> ─── files ── chunks</Text>
                </Box>
                {dirs.map((d, i) => {
                    const isCursor = i === cursor;
                    const ptr = isCursor ? '▸ ' : '  ';
                    const dirBarW = Math.max(5, Math.min(15, Math.round(d.percent / 100 * 15)));
                    return (
                        <Box key={d.dir} height={1}>
                            <Text wrap="truncate">
                                <Text color={isCursor ? C.aurora : C.dim}>{ptr}</Text>
                                <Text color={isCursor ? C.aurora : C.dir} bold={isCursor}>
                                    {truncate(d.dir + '/', 20).padEnd(20)}
                                </Text>
                                <Text color={C.dim}>{String(d.files).padStart(5)}  {String(d.chunks).padStart(5)}  </Text>
                                <Text color={isCursor ? C.aurora : C.success}>{bar(d.percent, dirBarW)}</Text>
                            </Text>
                        </Box>
                    );
                })}
            </Box>
        </Box>
    );
}


// ── File Explorer View ────────────────────────────

function FileExplorerView({ dbPath, dir, width, height, onDrillFile, onBack }: {
    dbPath: string;
    dir: string;
    width: number;
    height: number;
    onDrillFile: (filePath: string) => void;
    onBack: () => void;
}): React.ReactNode {
    const files = useMemo(() => fetchFilesInDir(dbPath, dir), [dbPath, dir]);
    const [cursor, setCursor] = useState(0);
    const [sortMode, setSortMode] = useState<'chunks' | 'name' | 'symbols'>('chunks');

    const sorted = useMemo(() => {
        const s = [...files];
        if (sortMode === 'name') s.sort((a, b) => a.fileName.localeCompare(b.fileName));
        else if (sortMode === 'symbols') s.sort((a, b) => b.symbols - a.symbols);
        // default: by chunks (already sorted)
        return s;
    }, [files, sortMode]);

    const detail: FileDetailInfo | null = useMemo(() => {
        if (!sorted[cursor]) return null;
        return fetchFileDetail(dbPath, sorted[cursor].filePath);
    }, [dbPath, sorted, cursor]);

    const listH = Math.max(5, height - 6);
    const scrollOff = centerScroll(cursor, sorted.length, listH);

    useInput((input, key) => {
        if (key.escape) onBack();
        if (key.downArrow) setCursor(c => Math.min(c + 1, sorted.length - 1));
        if (key.upArrow) setCursor(c => Math.max(c - 1, 0));
        if (key.return && sorted[cursor]) onDrillFile(sorted[cursor].filePath);
        if (input === 's') setSortMode(m => m === 'chunks' ? 'name' : m === 'name' ? 'symbols' : 'chunks');
    });

    const leftW = Math.min(40, Math.floor(width * 0.4));
    const rightW = width - leftW - 3;
    const visible = sorted.slice(scrollOff, scrollOff + listH);

    return (
        <Box flexDirection="row" width={width} height={height - 4}>
            {/* Left: File list */}
            <Box flexDirection="column" width={leftW} paddingX={1}>
                <Box marginBottom={1}>
                    <Text color={C.aurora} bold>Files</Text>
                    <Text color={C.dim}> ({files.length})</Text>
                    <Text color={C.dim}> sort: </Text>
                    <Text color={C.cyan}>{sortMode}</Text>
                </Box>
                {visible.map((f, vi) => {
                    const idx = scrollOff + vi;
                    const isCursor = idx === cursor;
                    const ptr = isCursor ? '▸ ' : '  ';
                    return (
                        <Box key={f.filePath} height={1}>
                            <Text wrap="truncate">
                                <Text color={isCursor ? C.aurora : C.dim}>{ptr}</Text>
                                <Text color={langColor(f.language)} bold>{langBadge(f.language)}</Text>
                                <Text> </Text>
                                <Text color={isCursor ? C.text : C.dim}>
                                    {truncate(f.fileName, leftW - 12)}
                                </Text>
                                <Text color={C.dim}> {String(f.chunks).padStart(3)}ch</Text>
                            </Text>
                        </Box>
                    );
                })}
            </Box>

            {/* Right: File detail */}
            <Box flexDirection="column" width={rightW} paddingX={1}>
                {detail && (
                    <>
                        <Box marginBottom={1}>
                            <Text color={C.aurora} bold>File Detail</Text>
                        </Box>
                        <Text color={C.dim}>📄 <Text color={C.text}>{detail.filePath}</Text></Text>
                        <Text color={C.dim}>   Language: <Text color={langColor(detail.language)}>{detail.language}</Text></Text>
                        <Text color={C.dim}>   Chunks: <Text color={C.text}>{detail.chunks}</Text></Text>
                        <Text color={C.dim}>   Symbols: <Text color={C.text}>{detail.symbols.length}</Text></Text>
                        <Text color={C.dim}>   Imports: <Text color={C.success}>{detail.importsIn.length} in</Text>, <Text color={C.orange}>{detail.importsOut.length} out</Text></Text>
                        <Text color={C.dim}>   Call edges: <Text color={C.success}>{detail.callEdgesIn} in</Text>, <Text color={C.orange}>{detail.callEdgesOut} out</Text></Text>

                        {detail.symbols.length > 0 && (
                            <Box flexDirection="column" marginTop={1}>
                                <Text color={C.purple} bold>Symbols</Text>
                                {detail.symbols.slice(0, Math.max(5, height - 15)).map((sym, i) => (
                                    <Box key={`${sym.name}-${i}`} height={1}>
                                        <Text wrap="truncate">
                                            <Text color={C.dim}>  {sym.kind === 'class' || sym.kind === 'Class' ? 'C' : 'ƒ'} </Text>
                                            <Text color={C.text}>{truncate(sym.name, rightW - 10)}</Text>
                                            <Text color={C.dim}> L{sym.line}</Text>
                                        </Text>
                                    </Box>
                                ))}
                                {detail.symbols.length > height - 15 && (
                                    <Text color={C.dim}>  … {detail.symbols.length - (height - 15)} more</Text>
                                )}
                            </Box>
                        )}

                        {detail.importsIn.length > 0 && (
                            <Box flexDirection="column" marginTop={1}>
                                <Text color={C.cyan} bold>Imported by</Text>
                                {detail.importsIn.slice(0, 5).map((imp, i) => (
                                    <Text key={i} color={C.dim}>  ← {truncate(imp, rightW - 6)}</Text>
                                ))}
                            </Box>
                        )}
                    </>
                )}
            </Box>
        </Box>
    );
}


// ── Chunk Viewer ──────────────────────────────────

function ChunkViewerView({ dbPath, filePath, width, height, onBack }: {
    dbPath: string;
    filePath: string;
    width: number;
    height: number;
    onBack: () => void;
}): React.ReactNode {
    const chunks = useMemo(() => fetchChunksForFile(dbPath, filePath), [dbPath, filePath]);
    const [cursor, setCursor] = useState(0);
    const [contentScroll, setContentScroll] = useState(0);
    const [focusPanel, setFocusPanel] = useState<'list' | 'content'>('list');

    const listH = Math.max(5, height - 6);
    const scrollOff = centerScroll(cursor, chunks.length, listH);

    const leftW = Math.min(26, Math.floor(width * 0.28));
    const rightW = width - leftW - 3;
    const activeChunk = chunks[cursor] ?? null;
    const visible = chunks.slice(scrollOff, scrollOff + listH);
    const metaH = 5; // header + symbol + calls
    const previewH = Math.max(3, height - 10 - metaH);
    const contentLines = useMemo(() => activeChunk?.content.split('\n') ?? [], [activeChunk]);
    const maxContentScroll = Math.max(0, contentLines.length - previewH);

    // Reset content scroll when switching chunks
    useEffect(() => { setContentScroll(0); }, [cursor]);

    useInput((input, key) => {
        if (key.escape) {
            if (focusPanel === 'content') { setFocusPanel('list'); return; }
            onBack();
        }
        if (key.tab || (input === 'l' && focusPanel === 'list') || (input === 'h' && focusPanel === 'content')) {
            setFocusPanel(p => p === 'list' ? 'content' : 'list');
            return;
        }
        if (focusPanel === 'list') {
            if (key.downArrow) setCursor(c => Math.min(c + 1, chunks.length - 1));
            if (key.upArrow) setCursor(c => Math.max(c - 1, 0));
            if (key.return) setFocusPanel('content');
        } else {
            // Content panel scrolling
            if (key.downArrow) setContentScroll(s => Math.min(s + 1, maxContentScroll));
            if (key.upArrow) setContentScroll(s => Math.max(s - 1, 0));
            if (input === 'd') setContentScroll(s => Math.min(s + 15, maxContentScroll));
            if (input === 'u') setContentScroll(s => Math.max(s - 15, 0));
        }
    });

    const visibleLines = contentLines.slice(contentScroll, contentScroll + previewH);
    const scrollPct = maxContentScroll > 0 ? Math.round(contentScroll / maxContentScroll * 100) : 100;

    return (
        <Box flexDirection="row" width={width} height={height - 4}>
            {/* Left: Chunk list */}
            <Box flexDirection="column" width={leftW} paddingX={1}>
                <Box marginBottom={1}>
                    <Text color={focusPanel === 'list' ? C.aurora : C.dim} bold>Chunks</Text>
                    <Text color={C.dim}> ({chunks.length})</Text>
                </Box>
                {visible.map((ch, vi) => {
                    const idx = scrollOff + vi;
                    const isCursor = idx === cursor;
                    const ptr = isCursor ? '▸ ' : '  ';
                    const hasSym = ch.name !== null && ch.name !== '';
                    const active = focusPanel === 'list' && isCursor;
                    return (
                        <Box key={ch.id} height={1}>
                            <Text wrap="truncate">
                                <Text color={active ? C.aurora : isCursor ? C.cyan : C.dim}>{ptr}</Text>
                                <Text color={active ? C.text : isCursor ? C.cyan : C.dim}>
                                    #{String(idx + 1).padStart(2)} L{ch.startLine}-{ch.endLine}
                                </Text>
                                {hasSym && <Text color={C.warning}> ★</Text>}
                            </Text>
                        </Box>
                    );
                })}
                <Box marginTop={1}>
                    <Text color={C.dim}>★ = named symbol</Text>
                </Box>
            </Box>

            {/* Right: Chunk preview (scrollable) */}
            <Box flexDirection="column" width={rightW} paddingX={1}>
                {activeChunk && (
                    <>
                        <Box marginBottom={1} justifyContent="space-between">
                            <Text>
                                <Text color={focusPanel === 'content' ? C.aurora : C.dim} bold>Preview</Text>
                                <Text color={C.dim}> #{cursor + 1} L{activeChunk.startLine}-{activeChunk.endLine}</Text>
                                {activeChunk.name ? <Text color={C.purple}> {activeChunk.name}</Text> : null}
                            </Text>
                            {contentLines.length > previewH && (
                                <Text color={focusPanel === 'content' ? C.cyan : C.dim}>{scrollPct}%</Text>
                            )}
                        </Box>
                        <Box flexDirection="column">
                            {visibleLines.map((line, i) => (
                                <Box key={contentScroll + i} height={1}>
                                    <Text wrap="truncate">
                                        <Text color={C.dim}>{String(activeChunk.startLine + contentScroll + i).padStart(4)}│</Text>
                                        <Text color={C.text}>{truncate(line, rightW - 6)}</Text>
                                    </Text>
                                </Box>
                            ))}
                        </Box>

                        <Box marginTop={1} flexDirection="column">
                            {activeChunk.callsOut.length > 0 && (
                                <Text color={C.dim}>→ <Text color={C.orange}>{activeChunk.callsOut.slice(0, 8).join(', ')}</Text></Text>
                            )}
                            {activeChunk.calledBy.length > 0 && (
                                <Text color={C.dim}>← <Text color={C.success}>{activeChunk.calledBy.slice(0, 8).join(', ')}</Text></Text>
                            )}
                        </Box>
                    </>
                )}
            </Box>
        </Box>
    );
}


// ── Search View ───────────────────────────────────

function SearchView({ dbPath, width, height, onBack, onViewChunk }: {
    dbPath: string;
    width: number;
    height: number;
    onBack: () => void;
    onViewChunk: (filePath: string) => void;
}): React.ReactNode {
    const [query, setQuery] = useState('');
    const [results, setResults] = useState<SearchResultItem[]>([]);
    const [cursor, setCursor] = useState(0);
    const [preview, setPreview] = useState<ChunkInfo | null>(null);

    // Search when query changes
    useEffect(() => {
        if (query.length < 2) { setResults([]); setPreview(null); return; }
        try {
            const r = searchChunks(dbPath, query, 30);
            setResults(r);
            setCursor(0);
        } catch { setResults([]); }
    }, [query, dbPath]);

    // Preview selected result
    useEffect(() => {
        if (results[cursor]) {
            setPreview(fetchChunkById(dbPath, results[cursor].id));
        } else {
            setPreview(null);
        }
    }, [cursor, results, dbPath]);

    const [previewScroll, setPreviewScroll] = useState(0);
    useEffect(() => { setPreviewScroll(0); }, [cursor]);

    const listH = Math.max(5, height - 8);
    const scrollOff = centerScroll(cursor, results.length, listH);
    const visible = results.slice(scrollOff, scrollOff + listH);

    const leftW = Math.min(45, Math.floor(width * 0.45));
    const rightW = width - leftW - 3;
    const previewH = Math.max(3, height - 10);
    const previewLines = useMemo(() => preview?.content.split('\n') ?? [], [preview]);
    const maxPreviewScroll = Math.max(0, previewLines.length - previewH);

    useInput((input, key) => {
        if (key.escape) {
            if (query.length > 0) { setQuery(''); setResults([]); return; }
            onBack();
        }
        if (key.downArrow) setCursor(c => Math.min(c + 1, results.length - 1));
        if (key.upArrow) setCursor(c => Math.max(c - 1, 0));
        if (key.return && results[cursor]) {
            onViewChunk(results[cursor].filePath);
            return;
        }
        // Page scroll on preview (Ctrl not available, use tab+scroll combo not ideal)
        // Use { } for preview scroll
        if (input === '}') { setPreviewScroll(s => Math.min(s + 10, maxPreviewScroll)); return; }
        if (input === '{') { setPreviewScroll(s => Math.max(s - 10, 0)); return; }
        if (key.backspace || key.delete) {
            setQuery(q => q.slice(0, -1));
            return;
        }
        if (input && input.length === 1 && !key.ctrl && !key.meta && !key.downArrow && !key.upArrow) {
            setQuery(q => q + input);
        }
    });

    const visiblePreview = previewLines.slice(previewScroll, previewScroll + previewH);

    return (
        <Box flexDirection="column" width={width} height={height - 4}>
            {/* Search bar */}
            <Box paddingX={1} marginBottom={1}>
                <Text color={C.aurora} bold>🔍 Search: </Text>
                <Text color={C.text}>{query}<Text color={C.aurora}>▎</Text></Text>
                <Text color={C.dim}>  {results.length > 0 ? `${results.length} results` : query.length >= 2 ? 'no matches' : ''}</Text>
            </Box>

            <Box flexDirection="row" width={width} height={height - 8}>
                {/* Left: Results list */}
                <Box flexDirection="column" width={leftW} paddingX={1}>
                    {visible.map((r, vi) => {
                        const idx = scrollOff + vi;
                        const isCursor = idx === cursor;
                        const ptr = isCursor ? '▸ ' : '  ';
                        const shortPath = r.filePath.length > leftW - 15
                            ? '…' + r.filePath.slice(-(leftW - 16))
                            : r.filePath;
                        return (
                            <Box key={`${r.id}-${vi}`} height={2} flexDirection="column">
                                <Text wrap="truncate">
                                    <Text color={isCursor ? C.aurora : C.dim}>{ptr}</Text>
                                    <Text color={langColor(r.language)} bold>{langBadge(r.language)}</Text>
                                    <Text> </Text>
                                    <Text color={isCursor ? C.text : C.dim} bold={isCursor}>
                                        {r.name ?? r.chunkType}
                                    </Text>
                                    <Text color={C.dim}> L{r.startLine}</Text>
                                </Text>
                                <Text wrap="truncate" color={C.dim}>
                                    {'    '}{shortPath}
                                </Text>
                            </Box>
                        );
                    })}
                </Box>

                {/* Right: Preview */}
                <Box flexDirection="column" width={rightW} paddingX={1}>
                    {preview && (
                        <>
                            <Box marginBottom={1} justifyContent="space-between">
                                <Text>
                                    <Text color={C.aurora} bold>Preview</Text>
                                    <Text color={C.dim}> L{preview.startLine}-{preview.endLine}</Text>
                                    {preview.name && <Text color={C.purple}> {preview.name}</Text>}
                                </Text>
                                {previewLines.length > previewH && (
                                    <Text color={C.dim}>{Math.round(previewScroll / maxPreviewScroll * 100)}%</Text>
                                )}
                            </Box>
                            <Box flexDirection="column">
                                {visiblePreview.map((line, i) => (
                                    <Box key={previewScroll + i} height={1}>
                                        <Text wrap="truncate">
                                            <Text color={C.dim}>{String(preview.startLine + previewScroll + i).padStart(4)}│</Text>
                                            <Text color={C.text}>{truncate(line, rightW - 6)}</Text>
                                        </Text>
                                    </Box>
                                ))}
                            </Box>
                        </>
                    )}
                </Box>
            </Box>
        </Box>
    );
}


// ── Call Graph View ───────────────────────────────

function CallGraphView({ dbPath, width, height, onBack }: {
    dbPath: string;
    width: number;
    height: number;
    onBack: () => void;
}): React.ReactNode {
    // Start with a top-level symbol search
    const [searchQuery, setSearchQuery] = useState('');
    const [rootNodes, setRootNodes] = useState<CallTreeNode[]>([]);
    const [cursor, setCursor] = useState(0);

    // Flatten tree for display
    const flatNodes = useMemo(() => {
        interface FlatNode { node: CallTreeNode; depth: number }
        const flat: FlatNode[] = [];
        function walk(nodes: CallTreeNode[], d: number): void {
            for (const n of nodes) {
                flat.push({ node: n, depth: d });
                walk(n.children, d + 1);
            }
        }
        walk(rootNodes, 0);
        return flat;
    }, [rootNodes]);

    useInput((input, key) => {
        if (key.escape) {
            if (rootNodes.length > 0) { setRootNodes([]); setSearchQuery(''); }
            else onBack();
        }
        if (key.downArrow) setCursor(c => Math.min(c + 1, flatNodes.length - 1));
        if (key.upArrow) setCursor(c => Math.max(c - 1, 0));
        if (key.return && flatNodes[cursor]) {
            // Drill into this node
            const tree = fetchCallTree(dbPath, flatNodes[cursor].node.chunkId, 3);
            if (tree.children.length > 0) {
                setRootNodes([tree]);
                setCursor(0);
            }
        }
        if (key.backspace || key.delete) {
            setSearchQuery(q => q.slice(0, -1));
        }
        if (input && input.length === 1 && !key.ctrl && !key.meta) {
            setSearchQuery(q => q + input);
        }
    });

    // Search for matching chunks when query changes
    useEffect(() => {
        if (searchQuery.length < 2) { setRootNodes([]); return; }
        try {
            const rows = searchSymbols(dbPath, searchQuery, 10);
            const trees = rows.map(r => fetchCallTree(dbPath, r.id, 2));
            setRootNodes(trees);
            setCursor(0);
        } catch { /* ignore */ }
    }, [searchQuery, dbPath]);

    const listH = Math.max(5, height - 8);
    const scrollOff = centerScroll(cursor, flatNodes.length, listH);
    const visible = flatNodes.slice(scrollOff, scrollOff + listH);

    return (
        <Box flexDirection="column" width={width} height={height - 4} paddingX={1}>
            <Box marginBottom={1}>
                <Text color={C.aurora} bold>Call Graph</Text>
            </Box>
            <Box marginBottom={1}>
                <Text color={C.dim}>🔍 Search: </Text>
                <Text color={C.text}>{searchQuery || '(type to search symbols…)'}</Text>
            </Box>

            {flatNodes.length === 0 && searchQuery.length >= 2 && (
                <Text color={C.dim}>No matching symbols found.</Text>
            )}

            {visible.map((item, vi) => {
                const idx = scrollOff + vi;
                const isCursor = idx === cursor;
                const indent = '  '.repeat(item.depth);
                const prefix = item.depth > 0 ? '├── ' : '';
                return (
                    <Box key={`${item.node.chunkId}-${vi}`} height={1}>
                        <Text wrap="truncate">
                            <Text color={isCursor ? C.aurora : C.dim}>{isCursor ? '▸ ' : '  '}</Text>
                            <Text color={C.dim}>{indent}{prefix}</Text>
                            <Text color={isCursor ? C.aurora : C.purple} bold={isCursor}>{item.node.symbol}</Text>
                            <Text color={C.dim}> </Text>
                            <Text color={C.dim}>{truncate(item.node.filePath, width - indent.length * 2 - item.node.symbol.length - 12)}</Text>
                            {item.node.children.length > 0 && (
                                <Text color={C.dim}> ({item.node.children.length})</Text>
                            )}
                        </Text>
                    </Box>
                );
            })}
        </Box>
    );
}


// ── Header / Footer ───────────────────────────────

function Header({ repoPath, dbSizeMB, view, breadcrumb, width }: {
    repoPath: string; dbSizeMB: number; view: View; breadcrumb: string[];
    width: number;
}): React.ReactNode {
    const crumb = breadcrumb.length > 0 ? '  ▸ ' + breadcrumb.join(' ▸ ') : '';
    const right = `${repoPath}  ${dbSizeMB}MB`;
    return (
        <Box width={width} height={2} paddingX={1} flexDirection="column">
            <Box justifyContent="space-between">
                <Text>
                    <Text color={C.aurora} bold>⚡ BrainBank Explorer</Text>
                    <Text color={C.dim}>{crumb}</Text>
                </Text>
                <Text color={C.dim}>{truncate(right, Math.max(10, width - 40))}</Text>
            </Box>
            <Text color={C.border}>{'─'.repeat(width - 2)}</Text>
        </Box>
    );
}

function Footer({ view, width }: { view: View; width: number }): React.ReactNode {
    const hints: Record<View, string> = {
        dashboard: '↑↓ navigate   Enter drill in   / search   g call graph   q quit',
        files:     '↑↓ navigate   Enter view chunks   s sort   Esc back   q quit',
        chunks:    'Tab focus   ↑↓ scroll   h/l switch   u/d page   Enter preview   Esc back   q quit',
        callgraph: 'type to search   ↑↓ navigate   Enter expand   Esc back   q quit',
        search:    'type to search   ↑↓ navigate   {/} scroll preview   Enter go to file   Esc back   q quit',
    };

    return (
        <Box width={width} height={2} paddingX={1} flexDirection="column">
            <Text color={C.border}>{'─'.repeat(width - 2)}</Text>
            <Text color={C.dim}>
                {hints[view].split(/(\S+:)/).map((part, i) =>
                    part.endsWith(':') ? (
                        <Text key={i} color={C.aurora}>{part} </Text>
                    ) : (
                        <Text key={i}>{part}</Text>
                    )
                )}
            </Text>
        </Box>
    );
}


// ── App Root ──────────────────────────────────────

function StatsApp({ dbPath, repoPath, configPath }: {
    dbPath: string;
    repoPath: string;
    configPath: string;
}): React.ReactNode {
    const { exit } = useApp();
    const { stdout } = useStdout();
    const [rawW, setRawW] = useState(stdout?.columns || 100);
    const [rawH, setRawH] = useState(stdout?.rows || 30);
    const [view, setView] = useState<View>('dashboard');
    const [breadcrumb, setBreadcrumb] = useState<string[]>([]);
    const [currentDir, setCurrentDir] = useState('');
    const [currentFile, setCurrentFile] = useState('');

    const width = Math.floor(rawW * 0.9);
    const height = Math.floor(rawH * 0.9);

    useEffect(() => {
        if (!stdout) return;
        const onResize = () => { setRawW(stdout.columns); setRawH(stdout.rows); };
        stdout.on('resize', onResize);
        return () => { stdout.off('resize', onResize); };
    }, [stdout]);

    // Global quit
    useInput((input) => {
        if (input === 'q') { exit(); }
    });

    // Fetch data
    const overview = useMemo(() => fetchOverview(dbPath, repoPath, configPath), [dbPath, repoPath, configPath]);
    const languages = useMemo(() => fetchLanguageBreakdown(dbPath), [dbPath]);
    const dirs = useMemo(() => fetchDirectories(dbPath), [dbPath]);

    // Navigation handlers
    const drillDir = (dir: string) => {
        setCurrentDir(dir);
        setBreadcrumb([dir + '/']);
        setView('files');
    };

    const drillFile = (filePath: string) => {
        setCurrentFile(filePath);
        const fileName = filePath.split('/').pop() || filePath;
        setBreadcrumb([currentDir + '/', fileName]);
        setView('chunks');
    };

    const goBack = () => {
        if (view === 'chunks') {
            setBreadcrumb([currentDir + '/']);
            setView('files');
        } else if (view === 'files') {
            setBreadcrumb([]);
            setView('dashboard');
        } else if (view === 'callgraph' || view === 'search') {
            setBreadcrumb([]);
            setView('dashboard');
        }
    };

    const goCallGraph = () => {
        setBreadcrumb(['Call Graph']);
        setView('callgraph');
    };

    const goSearch = () => {
        setBreadcrumb(['Search']);
        setView('search');
    };

    const searchDrillFile = (filePath: string) => {
        setCurrentFile(filePath);
        const dir = filePath.split('/')[0] || '';
        const fileName = filePath.split('/').pop() || filePath;
        setCurrentDir(dir);
        setBreadcrumb(['Search', fileName]);
        setView('chunks');
    };

    return (
        <Box flexDirection="column" width={width} height={height}>
            <Header repoPath={overview.repoPath} dbSizeMB={overview.dbSizeMB} view={view} breadcrumb={breadcrumb} width={width} />

            {view === 'dashboard' && (
                <DashboardView
                    overview={overview} languages={languages} dirs={dirs}
                    width={width} height={height}
                    onDrillDir={drillDir} onCallGraph={goCallGraph} onSearch={goSearch}
                />
            )}
            {view === 'files' && (
                <FileExplorerView
                    dbPath={dbPath} dir={currentDir}
                    width={width} height={height}
                    onDrillFile={drillFile} onBack={goBack}
                />
            )}
            {view === 'chunks' && (
                <ChunkViewerView
                    dbPath={dbPath} filePath={currentFile}
                    width={width} height={height}
                    onBack={goBack}
                />
            )}
            {view === 'callgraph' && (
                <CallGraphView
                    dbPath={dbPath}
                    width={width} height={height}
                    onBack={goBack}
                />
            )}
            {view === 'search' && (
                <SearchView
                    dbPath={dbPath}
                    width={width} height={height}
                    onBack={goBack}
                    onViewChunk={searchDrillFile}
                />
            )}

            <Footer view={view} width={width} />
        </Box>
    );
}


// ── Public API ────────────────────────────────────

export async function runStatsTui(dbPath: string, repoPath: string, configPath: string): Promise<void> {
    // Clear screen + hide cursor for full-screen feel
    process.stdout.write('\x1b[2J\x1b[H\x1b[?25l');

    const instance = render(
        <StatsApp dbPath={dbPath} repoPath={repoPath} configPath={configPath} />
    );
    await instance.waitUntilExit();

    // Restore: show cursor + clear screen
    process.stdout.write('\x1b[?25h\x1b[2J\x1b[H');
}

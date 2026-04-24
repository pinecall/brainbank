/**
 * stats-tui.tsx — Interactive Ink TUI for `brainbank stats`.
 *
 * Split-panel layout with 5 views:
 *   1. Dashboard — overview, language bars, directory list
 *   2. File Explorer — drill into directory, file list + detail
 *   3. Chunk Viewer — browse chunks, preview content
 *   4. Call Graph — interactive call tree
 *   5. Semantic Search — full pipeline (vector → prune → expand)
 *
 * Reuses patterns & colors from index-tui.tsx.
 */

import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { render, Box, Text, useApp, useInput, useStdout } from 'ink';
import {
    fetchOverview, fetchLanguageBreakdown, fetchDirectories,
    fetchFilesInDir, fetchFileDetail, fetchChunksForFile, fetchCallTree,
    searchSymbols,
} from './stats-data.ts';
import type {
    StatsOverview, LanguageStat, DirectoryStat,
    FileStat, FileDetailInfo, ChunkInfo, CallTreeNode,
} from './stats-data.ts';
import { BrainSearchSession } from './stats-search.ts';
import type { SearchPipelineResult, SourceOption } from './stats-search.ts';
import type { SearchResult } from '@/types.ts';


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

// ── Syntax Highlighting ───────────────────────────

/** A colored segment of a syntax-highlighted line. */
interface SyntaxSegment {
    text: string;
    color: string;
}

// Keyword sets for common languages
const KEYWORDS = new Set([
    // JS/TS
    'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue',
    'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false',
    'finally', 'for', 'from', 'function', 'if', 'implements', 'import', 'in',
    'instanceof', 'interface', 'let', 'new', 'null', 'of', 'return', 'static',
    'super', 'switch', 'this', 'throw', 'true', 'try', 'type', 'typeof',
    'undefined', 'var', 'void', 'while', 'yield',
    // Python
    'def', 'class', 'self', 'None', 'True', 'False', 'and', 'or', 'not',
    'is', 'lambda', 'with', 'as', 'pass', 'raise', 'global', 'nonlocal',
    'elif', 'except', 'assert',
]);

const TYPE_WORDS = new Set([
    'string', 'number', 'boolean', 'any', 'void', 'never', 'unknown',
    'object', 'Promise', 'Array', 'Map', 'Set', 'Record', 'Partial',
    'Readonly', 'Required', 'Pick', 'Omit', 'int', 'float', 'str',
    'list', 'dict', 'tuple', 'bool', 'Optional',
]);

/** Tokenize a line of code into colored segments. Simple regex-based. */
function highlightLine(line: string, maxW: number): SyntaxSegment[] {
    const trimmed = line.length > maxW ? line.slice(0, maxW - 1) + '…' : line;
    if (trimmed.length === 0) return [{ text: '', color: C.text }];

    const segments: SyntaxSegment[] = [];
    // Single-line comment check
    const commentIdx = findCommentStart(trimmed);
    const codePart = commentIdx >= 0 ? trimmed.slice(0, commentIdx) : trimmed;
    const commentPart = commentIdx >= 0 ? trimmed.slice(commentIdx) : '';

    // Tokenize code part
    if (codePart.length > 0) {
        // Match patterns: strings, numbers, keywords, decorators, rest
        const pattern = /(@\w+)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d+(?:\.\d+)?\b)|(\b[A-Za-z_]\w*\b)|([^A-Za-z_@'"\d`]+)/g;
        let m: RegExpExecArray | null;
        while ((m = pattern.exec(codePart)) !== null) {
            const [full, decorator, str, num, word, other] = m;
            if (decorator) {
                segments.push({ text: decorator, color: C.warning });
            } else if (str) {
                segments.push({ text: str, color: C.success });
            } else if (num) {
                segments.push({ text: num, color: C.orange });
            } else if (word) {
                if (KEYWORDS.has(word)) {
                    segments.push({ text: word, color: C.purple });
                } else if (TYPE_WORDS.has(word)) {
                    segments.push({ text: word, color: C.cyan });
                } else if (word[0] === word[0].toUpperCase() && word[0] !== word[0].toLowerCase()) {
                    // PascalCase → likely a class/type
                    segments.push({ text: word, color: C.cyan });
                } else {
                    segments.push({ text: word, color: C.text });
                }
            } else if (other) {
                segments.push({ text: other, color: C.dim });
            } else {
                segments.push({ text: full, color: C.text });
            }
        }
    }

    // Comment part
    if (commentPart) {
        segments.push({ text: commentPart, color: C.dim });
    }

    return segments.length > 0 ? segments : [{ text: trimmed, color: C.text }];
}

/** Find the start of a single-line comment, avoiding matches inside strings. */
function findCommentStart(line: string): number {
    let inString: string | null = null;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inString) {
            if (ch === '\\') { i++; continue; }
            if (ch === inString) inString = null;
        } else {
            if (ch === '"' || ch === "'" || ch === '`') { inString = ch; continue; }
            if (ch === '/' && line[i + 1] === '/') return i;
            if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) return i;
        }
    }
    return -1;
}

/** Render a syntax-highlighted code line as Ink <Text> elements. */
function HighlightedLine({ segments }: { segments: SyntaxSegment[] }): React.ReactNode {
    return (
        <>
            {segments.map((seg, i) => (
                <Text key={i} color={seg.color}>{seg.text}</Text>
            ))}
        </>
    );
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

    // Filter mode
    const [filterText, setFilterText] = useState('');
    const isFilteringRef = useRef(false);
    const [isFiltering, setIsFiltering] = useState(false);

    const sorted = useMemo(() => {
        const s = [...files];
        if (sortMode === 'name') s.sort((a, b) => a.fileName.localeCompare(b.fileName));
        else if (sortMode === 'symbols') s.sort((a, b) => b.symbols - a.symbols);
        return s;
    }, [files, sortMode]);

    const filtered = useMemo(() => {
        if (!filterText) return sorted;
        const lower = filterText.toLowerCase();
        return sorted.filter(f => f.fileName.toLowerCase().includes(lower));
    }, [sorted, filterText]);

    const detail: FileDetailInfo | null = useMemo(() => {
        if (!filtered[cursor]) return null;
        return fetchFileDetail(dbPath, filtered[cursor].filePath);
    }, [dbPath, filtered, cursor]);

    const listH = Math.max(5, height - 6);
    const scrollOff = centerScroll(cursor, filtered.length, listH);

    useInput((input, key) => {
        const filtering = isFilteringRef.current;

        if (key.escape) {
            if (filtering || filterText) {
                isFilteringRef.current = false;
                setIsFiltering(false);
                setFilterText('');
                setCursor(0);
                return;
            }
            onBack();
            return;
        }

        // Filter mode typing
        if (filtering) {
            if (key.return) {
                isFilteringRef.current = false;
                setIsFiltering(false);
                return;
            }
            if (key.backspace || key.delete) {
                setFilterText(prev => prev.slice(0, -1));
                setCursor(0);
                return;
            }
            if (input && !key.upArrow && !key.downArrow) {
                setFilterText(prev => prev + input);
                setCursor(0);
                return;
            }
        }

        // '/' to start filtering
        if (input === '/' && !filtering) {
            isFilteringRef.current = true;
            setIsFiltering(true);
            setFilterText('');
            setCursor(0);
            return;
        }

        if (key.downArrow) setCursor(c => Math.min(c + 1, filtered.length - 1));
        if (key.upArrow) setCursor(c => Math.max(c - 1, 0));
        if (key.return && filtered[cursor]) onDrillFile(filtered[cursor].filePath);
        if (!filtering && input === 's') setSortMode(m => m === 'chunks' ? 'name' : m === 'name' ? 'symbols' : 'chunks');
    });

    const leftW = Math.min(40, Math.floor(width * 0.4));
    const rightW = width - leftW - 3;
    const visible = filtered.slice(scrollOff, scrollOff + listH);

    return (
        <Box flexDirection="row" width={width} height={height - 4}>
            {/* Left: File list */}
            <Box flexDirection="column" width={leftW} paddingX={1}>
                <Box marginBottom={1}>
                    <Text color={C.aurora} bold>Files</Text>
                    <Text color={C.dim}> ({filtered.length}{filterText ? `/${files.length}` : ''})</Text>
                    <Text color={C.dim}> sort: </Text>
                    <Text color={C.cyan}>{sortMode}</Text>
                </Box>
                {/* Filter bar */}
                {(isFiltering || filterText) && (
                    <Box height={1} marginBottom={0}>
                        <Text color={C.aurora} bold>/ </Text>
                        <Text color={C.text}>{filterText}</Text>
                        <Text color={C.aurora}>▎</Text>
                    </Box>
                )}
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
    // Preview fills to footer: height - 4 (outer margin) - 2 (header) - 3 (calls+meta) = usable
    const previewH = Math.max(3, height - 9);
    const contentLines = useMemo(() => activeChunk?.content.split('\n') ?? [], [activeChunk]);
    const maxContentScroll = Math.max(0, contentLines.length - previewH);

    // Reset content scroll when switching chunks
    useEffect(() => { setContentScroll(0); }, [cursor]);

    useInput((input, key) => {
        if (key.escape) {
            if (focusPanel === 'content') { setFocusPanel('list'); return; }
            onBack();
        }
        if (key.tab || (input === 'l' && focusPanel === 'list') || (input === 'h' && focusPanel === 'content')
            || (key.rightArrow && focusPanel === 'list') || (key.leftArrow && focusPanel === 'content')) {
            setFocusPanel(p => p === 'list' ? 'content' : 'list');
            return;
        }
        if (focusPanel === 'list') {
            if (key.downArrow) setCursor(c => Math.min(c + 1, chunks.length - 1));
            if (key.upArrow) setCursor(c => Math.max(c - 1, 0));
            if (input === '}') setCursor(c => Math.min(c + 10, chunks.length - 1));
            if (input === '{') setCursor(c => Math.max(c - 10, 0));
            if (key.return) setFocusPanel('content');
        } else {
            // Content panel scrolling
            if (key.downArrow) setContentScroll(s => Math.min(s + 1, maxContentScroll));
            if (key.upArrow) setContentScroll(s => Math.max(s - 1, 0));
            if (input === '}') setContentScroll(s => Math.min(s + 10, maxContentScroll));
            if (input === '{') setContentScroll(s => Math.max(s - 10, 0));
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

            {/* Right: Chunk preview (scrollable with syntax highlighting) */}
            <Box flexDirection="column" width={rightW} paddingX={1}>
                {activeChunk && (
                    <>
                        <Box marginBottom={0} justifyContent="space-between">
                            <Text>
                                <Text color={focusPanel === 'content' ? C.aurora : C.dim} bold>Preview</Text>
                                <Text color={C.dim}> #{cursor + 1} L{activeChunk.startLine}-{activeChunk.endLine}</Text>
                                {activeChunk.name ? <Text color={C.purple}> {activeChunk.name}</Text> : null}
                            </Text>
                            <Text>
                                {focusPanel === 'list' && <Text color={C.dim} italic>Enter to scroll </Text>}
                                {contentLines.length > previewH && (
                                    <Text color={focusPanel === 'content' ? C.cyan : C.dim}>{scrollPct}%</Text>
                                )}
                            </Text>
                        </Box>
                        <Box flexDirection="column">
                            {visibleLines.map((line, i) => {
                                const segs = highlightLine(line, rightW - 6);
                                return (
                                    <Box key={contentScroll + i} height={1}>
                                        <Text wrap="truncate">
                                            <Text color={C.dim}>{String(activeChunk.startLine + contentScroll + i).padStart(4)}│</Text>
                                            <HighlightedLine segments={segs} />
                                        </Text>
                                    </Box>
                                );
                            })}
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


// ── Semantic Search View ──────────────────────────

type SearchState = 'idle' | 'initializing' | 'searching' | 'done' | 'error';
type SearchFocus = 'input' | 'sources' | 'raw' | 'final' | 'preview' | 'fullpreview';

/** Extract display info from a SearchResult. */
function resultLabel(r: SearchResult): { name: string; path: string; score: number; line: number } {
    const meta = r.metadata as Record<string, unknown> | undefined;
    return {
        name: (meta?.name as string) ?? r.type,
        path: r.filePath ?? 'unknown',
        score: r.score,
        line: (meta?.startLine as number) ?? 0,
    };
}

function SemanticSearchView({ repoPath, width, height, onBack, session }: {
    repoPath: string;
    width: number;
    height: number;
    onBack: () => void;
    session: BrainSearchSession;
}): React.ReactNode {
    // Session — owned by StatsApp, shared across view transitions
    const sessionRef = useRef<BrainSearchSession>(session);

    // State
    const [query, setQuery] = useState('');
    const [state, setState] = useState<SearchState>(() =>
        session.initialized ? 'idle' : 'initializing',
    );
    const [stateMsg, setStateMsg] = useState(() =>
        session.initialized ? '' : 'Loading search index...',
    );
    const [focus, setFocus] = useState<SearchFocus>('input');
    const [pipeline, setPipeline] = useState<SearchPipelineResult | null>(null);
    const [sourceOpts, setSourceOpts] = useState<SourceOption[]>(() =>
        session.initialized ? [...session.sources] : [],
    );
    const [rawCursor, setRawCursor] = useState(0);
    const [finalCursor, setFinalCursor] = useState(0);
    const [previewScroll, setPreviewScroll] = useState(0);
    const [errorMsg, setErrorMsg] = useState('');
    const [sourceCursor, setSourceCursor] = useState(0);
    const [usePruner, setUsePruner] = useState(true);
    const [useExpander, setUseExpander] = useState(true);

    // Init session on mount — skip if already initialized (re-entry)
    useEffect(() => {
        sessionRef.current = session;

        if (session.initialized) {
            setSourceOpts([...session.sources]);
            setState('idle');
            setStateMsg('');
            return;
        }

        setState('initializing');
        setStateMsg('Loading search index...');

        // Defer to next tick so React paints the loading modal before heavy sync work
        const timer = setTimeout(() => {
            session.init()
                .then(() => {
                    setSourceOpts([...session.sources]);
                    setState('idle');
                    setStateMsg('');
                })
                .catch((err: unknown) => {
                    setState('error');
                    setErrorMsg(err instanceof Error ? err.message : String(err));
                });
        }, 50);

        return () => { clearTimeout(timer); };
    }, [session]);

    // Column sizing — preview gets most space for code readability
    const rawW = Math.max(20, Math.floor(width * 0.22));
    const prunedW = Math.max(20, Math.floor(width * 0.22));
    const previewW = width - rawW - prunedW - 4;
    const listH = Math.max(3, height - 12);
    const previewH = Math.max(3, height - 12);

    // Active result for preview — each column independently controls what's shown
    const activeResult = useMemo(() => {
        if (!pipeline) return null;
        if (focus === 'final') {
            const combined = [...pipeline.pruned, ...pipeline.expanded];
            return combined[finalCursor] ?? null;
        }
        // raw, input, sources, preview all show the raw cursor's item
        return pipeline.raw[rawCursor] ?? null;
    }, [focus, rawCursor, finalCursor, pipeline]);

    const previewLines = useMemo(() => activeResult?.content.split('\n') ?? [], [activeResult]);
    const maxPreviewScroll = Math.max(0, previewLines.length - previewH);

    // Reset preview scroll when result changes
    useEffect(() => { setPreviewScroll(0); }, [activeResult]);

    // Toggle source
    const toggleSource = useCallback((key: string) => {
        setSourceOpts(prev => {
            const next = prev.map(s => ({ ...s }));
            const target = next.find(s => s.key === key);
            if (target) target.enabled = !target.enabled;
            return next;
        });
    }, []);

    // Run search
    const doSearch = useCallback(async () => {
        const session = sessionRef.current;
        if (!session?.initialized || !query.trim()) return;
        setState('searching');
        setStateMsg('Searching...');
        setRawCursor(0);
        setFinalCursor(0);
        try {
            const activeKeys = new Set(
                sourceOpts.filter(s => s.enabled).map(s => s.key),
            );
            const allEnabled = sourceOpts.every(s => s.enabled);
            const result = await session.search(query, allEnabled ? undefined : activeKeys, usePruner, useExpander);
            setPipeline(result);
            setState('done');
            setStateMsg('');
            setFocus('raw');
        } catch (err: unknown) {
            setState('error');
            setErrorMsg(err instanceof Error ? err.message : String(err));
        }
    }, [query, sourceOpts, usePruner, useExpander]);

    // Input handling
    useInput((input, key) => {
        // Esc — back out
        if (key.escape) {
            if (focus === 'fullpreview') { setFocus('final'); return; }
            if (focus !== 'input' && pipeline) { setFocus('input'); return; }
            onBack();
            return;
        }

        // Source toggles removed from input mode — now handled in 'sources' focus

        // Input mode — typing query
        if (focus === 'input') {
            if (key.return && query.trim()) {
                doSearch();
                return;
            }
            if (key.backspace || key.delete) {
                setQuery(q => q.slice(0, -1));
                return;
            }
            if (key.tab) {
                setFocus('sources');
                return;
            }
            if (input && input.length === 1 && !key.ctrl && !key.meta) {
                setQuery(q => q + input);
            }
            return;
        }

        // Sources mode — ←→ to move cursor, space to toggle
        // Combined list: [sources...] | [Pruner] [Expander]
        if (focus === 'sources') {
            const totalOpts = sourceOpts.length + 2; // +2 for pruner, expander
            if (key.rightArrow) setSourceCursor(c => Math.min(c + 1, totalOpts - 1));
            if (key.leftArrow) setSourceCursor(c => Math.max(c - 1, 0));
            if (input === ' ') {
                if (sourceCursor < sourceOpts.length) {
                    toggleSource(sourceOpts[sourceCursor].key);
                } else if (sourceCursor === sourceOpts.length) {
                    setUsePruner(p => !p);
                } else {
                    setUseExpander(e => !e);
                }
                return;
            }
            // ↑↓ adjust K for the focused source
            if (key.upArrow && sourceCursor < sourceOpts.length) {
                setSourceOpts(prev => {
                    const next = prev.map(s => ({ ...s }));
                    const target = next[sourceCursor];
                    if (target) target.k = Math.min(target.k + 5, 50);
                    return next;
                });
                return;
            }
            if (key.downArrow && sourceCursor < sourceOpts.length) {
                setSourceOpts(prev => {
                    const next = prev.map(s => ({ ...s }));
                    const target = next[sourceCursor];
                    if (target) target.k = Math.max(target.k - 5, 5);
                    return next;
                });
                return;
            }
            if (key.tab) {
                setFocus(pipeline ? 'raw' : 'input');
                return;
            }
            if (key.return && query.trim()) {
                doSearch();
                return;
            }
            return;
        }

        // 'P' — toggle full context preview (what the agent sees)
        if (input === 'p' && focus !== 'input') {
            if (focus === 'fullpreview') { setFocus('final'); }
            else { setFocus('fullpreview'); setPreviewScroll(0); }
            return;
        }

        // Tab — cycle focus
        if (key.tab) {
            const order: SearchFocus[] = ['raw', 'final', 'preview', 'input'];
            const idx = order.indexOf(focus);
            setFocus(order[(idx + 1) % order.length]);
            return;
        }

        // Column navigation
        if (focus === 'raw') {
            if (key.downArrow) setRawCursor(c => Math.min(c + 1, (pipeline?.raw.length ?? 1) - 1));
            if (key.upArrow) setRawCursor(c => Math.max(c - 1, 0));
            if (input === '}') setRawCursor(c => Math.min(c + 10, (pipeline?.raw.length ?? 1) - 1));
            if (input === '{') setRawCursor(c => Math.max(c - 10, 0));
            if (input === 'h' || key.leftArrow) setFocus('sources');
            if (input === 'l' || key.rightArrow) setFocus('final');
            if (key.return) { setFocus('preview'); setPreviewScroll(0); }
            return;
        }

        if (focus === 'final') {
            const combined = pipeline ? [...pipeline.pruned, ...pipeline.expanded] : [];
            if (key.downArrow) setFinalCursor(c => Math.min(c + 1, combined.length - 1));
            if (key.upArrow) setFinalCursor(c => Math.max(c - 1, 0));
            if (input === '}') setFinalCursor(c => Math.min(c + 10, combined.length - 1));
            if (input === '{') setFinalCursor(c => Math.max(c - 10, 0));
            if (input === 'h' || key.leftArrow) setFocus('raw');
            if (input === 'l' || key.rightArrow) setFocus('preview');
            if (key.return) { setFocus('preview'); setPreviewScroll(0); }
            return;
        }

        if (focus === 'preview') {
            if (key.downArrow) setPreviewScroll(s => Math.min(s + 1, maxPreviewScroll));
            if (key.upArrow) setPreviewScroll(s => Math.max(s - 1, 0));
            if (input === '}') setPreviewScroll(s => Math.min(s + 10, maxPreviewScroll));
            if (input === '{') setPreviewScroll(s => Math.max(s - 10, 0));
            if (input === 'd') setPreviewScroll(s => Math.min(s + 15, maxPreviewScroll));
            if (input === 'u') setPreviewScroll(s => Math.max(s - 15, 0));
            if (input === 'h' || key.leftArrow) setFocus('final');
            return;
        }

        if (focus === 'fullpreview') {
            if (key.downArrow) setPreviewScroll(s => Math.min(s + 1, maxPreviewScroll));
            if (key.upArrow) setPreviewScroll(s => Math.max(s - 1, 0));
            if (input === '}') setPreviewScroll(s => Math.min(s + 10, maxPreviewScroll));
            if (input === '{') setPreviewScroll(s => Math.max(s - 10, 0));
            if (input === 'd') setPreviewScroll(s => Math.min(s + 15, maxPreviewScroll));
            if (input === 'u') setPreviewScroll(s => Math.max(s - 15, 0));
            return;
        }
    });

    // Combined pruned+expanded list
    const combinedResults = useMemo(() => {
        if (!pipeline) return [];
        return [
            ...pipeline.pruned.map(r => ({ r, type: 'kept' as const })),
            ...pipeline.expanded.map(r => ({ r, type: 'expanded' as const })),
        ];
    }, [pipeline]);

    // Set of dropped filePaths for dimming in raw column
    const droppedPaths = useMemo(() => {
        if (!pipeline) return new Set<string>();
        return new Set(pipeline.dropped.map(r => r.filePath ?? ''));
    }, [pipeline]);

    const rawScrollOff = centerScroll(rawCursor, pipeline?.raw.length ?? 0, listH);
    const finalScrollOff = centerScroll(finalCursor, combinedResults.length, listH);

    // Full context preview: all final results concatenated
    const fullContextLines = useMemo(() => {
        if (!pipeline) return [];
        const final = [...pipeline.pruned, ...pipeline.expanded];
        const lines: string[] = [];
        for (const r of final) {
            const info = resultLabel(r);
            lines.push(`━━━ ${info.path} L${info.line} ━━━`);
            lines.push(...r.content.split('\n'));
            lines.push('');
        }
        return lines;
    }, [pipeline]);

    const currentPreviewLines = focus === 'fullpreview' ? fullContextLines : previewLines;
    const currentMaxScroll = Math.max(0, currentPreviewLines.length - previewH);
    const visiblePreview = currentPreviewLines.slice(previewScroll, previewScroll + previewH);
    const scrollPct = currentMaxScroll > 0 ? Math.round(previewScroll / currentMaxScroll * 100) : 100;
    // Clamp preview scroll to current max
    useEffect(() => {
        setPreviewScroll(s => Math.min(s, currentMaxScroll));
    }, [currentMaxScroll]);

    // Animated spinner during init
    const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    const [spinIdx, setSpinIdx] = useState(0);
    useEffect(() => {
        if (state !== 'initializing') return;
        const timer = setInterval(() => setSpinIdx(i => (i + 1) % spinnerFrames.length), 80);
        return () => clearInterval(timer);
    }, [state]);

    // Show loading modal if still initializing
    if (state === 'initializing') {
        return (
            <Box flexDirection="column" width={width} height={height - 4}
                 justifyContent="center" alignItems="center">
                <Box flexDirection="column" alignItems="center" borderStyle="round"
                     borderColor={C.border} paddingX={6} paddingY={2}>
                    <Text color={C.aurora} bold>
                        {spinnerFrames[spinIdx]} Loading Search Engine
                    </Text>
                    <Text color={C.dim}> </Text>
                    <Text color={C.dim}>Initializing HNSW indices and plugins...</Text>
                    <Text color={C.dim}>This only happens once per session</Text>
                </Box>
                <Box marginTop={1}>
                    <Text color={C.dim}>Esc to go back</Text>
                </Box>
            </Box>
        );
    }

    return (
        <Box flexDirection="column" width={width} height={height - 4}>
            {/* Search bar */}
            <Box paddingX={1} flexDirection="column" marginBottom={1}>
                <Box>
                    <Text color={C.aurora} bold>🔍 </Text>
                    <Text color={focus === 'input' ? C.text : C.dim}>
                        {query}<Text color={focus === 'input' ? C.aurora : C.dim}>▎</Text>
                    </Text>
                    <Text color={C.dim}>
                        {'  '}{state === 'initializing' ? '⟳ ' + stateMsg
                            : state === 'searching' ? '⟳ Searching...'
                            : state === 'error' ? '✗ ' + errorMsg
                            : state === 'done' ? `${pipeline?.raw.length ?? 0} results`
                            : 'Enter to search'}
                    </Text>
                </Box>
                {/* Source filter tabs + pipeline toggles */}
                <Box marginTop={1}>
                    <Text color={focus === 'sources' ? C.aurora : C.dim}>Sources: </Text>
                    {sourceOpts.map((s, i) => {
                        const isFocused = focus === 'sources' && i === sourceCursor;
                        return (
                            <Text key={s.key}>
                                <Text color={isFocused ? C.text : (s.enabled ? C.aurora : C.dim)}
                                      bold={isFocused}
                                      underline={isFocused}>
                                    [{s.enabled ? '■' : '□'}] {s.label}
                                </Text>
                                <Text color={isFocused ? C.cyan : C.dim}>:{s.k}</Text>
                                <Text color={C.dim}>  </Text>
                            </Text>
                        );
                    })}
                    <Text color={C.dim}>│ </Text>
                    {/* Pruner toggle */}
                    <Text color={focus === 'sources' && sourceCursor === sourceOpts.length
                        ? C.text
                        : (usePruner ? C.purple : C.dim)}
                          bold={focus === 'sources' && sourceCursor === sourceOpts.length}
                          underline={focus === 'sources' && sourceCursor === sourceOpts.length}>
                        [{usePruner ? '■' : '□'}] Pruner
                    </Text>
                    <Text color={C.dim}>  </Text>
                    {/* Expander toggle */}
                    <Text color={focus === 'sources' && sourceCursor === sourceOpts.length + 1
                        ? C.text
                        : (useExpander ? C.purple : C.dim)}
                          bold={focus === 'sources' && sourceCursor === sourceOpts.length + 1}
                          underline={focus === 'sources' && sourceCursor === sourceOpts.length + 1}>
                        [{useExpander ? '■' : '□'}] Expander
                    </Text>
                    <Text color={C.dim}>  (←→ move, Space toggle, ↑↓ adjust K)</Text>
                </Box>
            </Box>

            {/* Full context preview mode */}
            {focus === 'fullpreview' ? (
                <Box flexDirection="column" width={width} height={listH + 2} marginTop={1} paddingX={1}>
                    <Box marginBottom={0} justifyContent="space-between">
                        <Text color={C.aurora} bold>Full Context Preview</Text>
                        <Text>
                            <Text color={C.dim} italic>What the agent sees  </Text>
                            <Text color={C.cyan}>{scrollPct}%</Text>
                            <Text color={C.dim}>  P to close</Text>
                        </Text>
                    </Box>
                    <Box flexDirection="column">
                        {visiblePreview.map((line, i) => {
                            const isHeader = line.startsWith('━━━');
                            if (isHeader) {
                                return (
                                    <Box key={previewScroll + i} height={1}>
                                        <Text color={C.purple} bold wrap="truncate">{truncate(line, width - 4)}</Text>
                                    </Box>
                                );
                            }
                            const segs = highlightLine(line, width - 8);
                            return (
                                <Box key={previewScroll + i} height={1}>
                                    <Text wrap="truncate">
                                        <Text color={C.dim}>{String(previewScroll + i + 1).padStart(4)}│</Text>
                                        <HighlightedLine segments={segs} />
                                    </Text>
                                </Box>
                            );
                        })}
                    </Box>
                </Box>
            ) : (
            /* Two result columns + wide preview */
            <Box flexDirection="row" width={width} height={listH} marginTop={1}>
                {/* Column 1: Raw results */}
                <Box flexDirection="column" width={rawW} paddingX={1}>
                    <Box marginBottom={0}>
                        <Text color={focus === 'raw' ? C.aurora : C.dim} bold>
                            Raw ({pipeline?.raw.length ?? 0})
                        </Text>
                    </Box>
                    {pipeline && pipeline.raw.slice(rawScrollOff, rawScrollOff + listH - 1).map((r, vi) => {
                        const idx = rawScrollOff + vi;
                        const isCursor = focus === 'raw' && idx === rawCursor;
                        const info = resultLabel(r);
                        const isDimmed = droppedPaths.has(r.filePath ?? '');
                        const ptr = isCursor ? '▸' : ' ';
                        const scorePct = Math.round(info.score * 100);
                        return (
                            <Box key={idx} height={1}>
                                <Text wrap="truncate">
                                    <Text color={isCursor ? C.aurora : C.dim}>{ptr} </Text>
                                    <Text color={isDimmed ? C.error : (isCursor ? C.text : C.dim)}
                                          strikethrough={isDimmed}>
                                        {truncate(info.name, rawW - 10)}
                                    </Text>
                                    <Text color={isDimmed ? C.error : C.dim}> {scorePct}%</Text>
                                </Text>
                            </Box>
                        );
                    })}
                </Box>

                {/* Column 2: Final = pruned survivors + expanded discoveries */}
                <Box flexDirection="column" width={prunedW} paddingX={1}>
                    <Box marginBottom={0}>
                        <Text color={focus === 'final' ? C.aurora : C.dim} bold>
                            Final ({combinedResults.length})
                        </Text>
                        {(pipeline?.expanded.length ?? 0) > 0 && (
                            <Text color={C.success}> +{pipeline?.expanded.length}◆</Text>
                        )}
                        {pipeline && pipeline.dropped.length > 0 && (
                            <Text color={C.error}> -{pipeline.dropped.length}</Text>
                        )}
                    </Box>
                    {combinedResults.slice(finalScrollOff, finalScrollOff + listH - 1).map((item, vi) => {
                        const idx = finalScrollOff + vi;
                        const isCursor = focus === 'final' && idx === finalCursor;
                        const info = resultLabel(item.r);
                        const isExpanded = item.type === 'expanded';
                        const ptr = isCursor ? '▸' : (isExpanded ? '◆' : ' ');
                        // Show rerank position# + shortened file path (visually distinct from raw column)
                        const shortFile = info.path.split('/').pop() ?? info.path;
                        return (
                            <Box key={idx} height={1}>
                                <Text wrap="truncate">
                                    <Text color={isCursor ? C.aurora : (isExpanded ? C.success : C.dim)}>
                                        {ptr}
                                    </Text>
                                    <Text color={C.dim}>{String(idx + 1).padStart(2)} </Text>
                                    <Text color={isCursor ? C.text : (isExpanded ? C.success : C.dim)}>
                                        {truncate(shortFile, prunedW - 8)}
                                    </Text>
                                </Text>
                            </Box>
                        );
                    })}
                </Box>

                {/* Column 3: Preview */}
                <Box flexDirection="column" width={previewW} paddingX={1}>
                    <Box marginBottom={0} justifyContent="space-between">
                        <Text color={focus === 'preview' ? C.aurora : C.dim} bold>Preview</Text>
                        <Text>
                            {focus !== 'preview' && <Text color={C.dim} italic>Enter/→ to scroll </Text>}
                            {currentPreviewLines.length > previewH && (
                                <Text color={focus === 'preview' ? C.cyan : C.dim}>{scrollPct}%</Text>
                            )}
                        </Text>
                    </Box>
                    {activeResult && (
                        <Box flexDirection="column">
                            <Text color={C.dim} wrap="truncate">
                                {truncate(resultLabel(activeResult).path, previewW - 4)} L{resultLabel(activeResult).line}
                            </Text>
                            {visiblePreview.map((line, i) => {
                                const segs = highlightLine(line, previewW - 5);
                                return (
                                    <Box key={previewScroll + i} height={1}>
                                        <Text wrap="truncate">
                                            <Text color={C.dim}>{String(previewScroll + i + 1).padStart(3)}│</Text>
                                            <HighlightedLine segments={segs} />
                                        </Text>
                                    </Box>
                                );
                            })}
                        </Box>
                    )}
                </Box>
            </Box>
            )}

            {/* Timings bar */}
            {pipeline && (
                <Box paddingX={1} marginTop={0}>
                    <Text color={C.dim}>
                        ⏱ search: {pipeline.timings.search}ms
                        {pipeline.prunerName && (
                            <Text>{'  '}prune: {pipeline.timings.prune}ms ({pipeline.prunerName}, -{pipeline.dropped.length})</Text>
                        )}
                        {pipeline.expanderName && pipeline.expanded.length > 0 && (
                            <Text>{'  '}expand: {pipeline.timings.expand}ms ({pipeline.expanderName}, +{pipeline.expanded.length})</Text>
                        )}
                        {'  '}total: {pipeline.timings.total}ms
                    </Text>
                </Box>
            )}
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
        files:     '↑↓ navigate   Enter view chunks   s sort   / filter   Esc back   q quit',
        chunks:    'Tab focus   ↑↓ scroll   {/} jump 10   u/d page   Enter preview   Esc back',
        callgraph: 'type to search   ↑↓ navigate   Enter expand   Esc back   q quit',
        search:    'type query → Enter   ←→ panels   {/} jump 10   P full context   Tab sources   Space toggle   Esc back',
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

    // Persistent search session — survives view transitions
    const searchSessionRef = useRef<BrainSearchSession | null>(null);
    const getSearchSession = useCallback(() => {
        if (!searchSessionRef.current) {
            searchSessionRef.current = new BrainSearchSession(repoPath);
        }
        return searchSessionRef.current;
    }, [repoPath]);
    // Clean up on unmount
    useEffect(() => {
        return () => { searchSessionRef.current?.close(); };
    }, []);

    const width = Math.floor(rawW * 0.9);
    const height = Math.floor(rawH * 0.9);

    useEffect(() => {
        if (!stdout) return;
        const onResize = () => { setRawW(stdout.columns); setRawH(stdout.rows); };
        stdout.on('resize', onResize);
        return () => { stdout.off('resize', onResize); };
    }, [stdout]);

    // Global quit — skip in text-input views (search, callgraph)
    useInput((input) => {
        if (input === 'q' && view !== 'search' && view !== 'callgraph') { exit(); }
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
                <SemanticSearchView
                    repoPath={repoPath}
                    width={width} height={height}
                    onBack={goBack}
                    session={getSearchSession()}
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

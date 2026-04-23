/**
 * index-tui.tsx — Interactive Ink TUI for `brainbank index`.
 *
 * Split-panel layout:
 *   Left:  Module sidebar (Tab to focus, Space toggle)
 *   Right: Interactive file explorer (↑↓ navigate, Space toggle dirs)
 *
 * Phase 2: Config setup (embedding + pruner) — only if no config.json.
 */

import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { render, Box, Text, useApp, useInput, useStdout } from 'ink';
import type { ScanResult } from '@/cli/commands/scan.ts';
import {
    buildFileTree, expandDir, collapseDir, toggleDir, setAllDirs,
    generatePatternsFromTree, countTotalFiles, getExtColor,
    scanDocsPreview, scanGitPreview,
} from './tree-scanner.ts';
import type { FileTreeItem, PreviewLine } from './tree-scanner.ts';


// ── Types ──────────────────────────────────────────────

export interface TuiSelection {
    modules: string[];
    include: string[];
    ignore: string[];
    config?: { embedding: string; pruner: string; expander: string };
}

type Phase = 'main' | 'config';
type Pane = 'modules' | 'tree';

const MAX_W = 90;
const MAX_H = 36;


// ── Colors ─────────────────────────────────────────────

const C = {
    aurora:  '#7AA2F7',
    success: '#9ECE6A',
    error:   '#F7768E',
    warning: '#E0AF68',
    dim:     '#565F89',
    text:    '#C0CAF5',
    border:  '#3B4261',
    cyan:    '#7DCFFF',
    dir:     '#E0AF68',
} as const;


// ── Extension badges ──────────────────────────────────

const EXT_BADGES: Record<string, string> = {
    '.ts': 'TS', '.tsx': 'TX', '.js': 'JS', '.jsx': 'JX', '.mjs': 'JS',
    '.py': 'PY', '.go': 'GO', '.rs': 'RS', '.rb': 'RB', '.java': 'JV',
    '.c': 'C ', '.cpp': 'C+', '.h': 'H ', '.cs': 'C#', '.php': 'PH',
    '.swift': 'SW', '.kt': 'KT', '.lua': 'LU', '.zig': 'ZG',
    '.css': 'CS', '.scss': 'SC', '.html': 'HT', '.vue': 'VU', '.svelte': 'SV',
    '.json': '{}', '.yaml': 'YM', '.yml': 'YM', '.toml': 'TM',
    '.md': 'MD', '.sql': 'SQ', '.sh': 'SH', '.bash': 'SH', '.zsh': 'SH',
};
function extBadge(ext: string): string { return EXT_BADGES[ext] ?? '··'; }


// ── Embedding / Pruner ─────────────────────────────────

interface OptionItem { value: string; label: string; desc: string; badge?: string }

const EMBEDDINGS: OptionItem[] = [
    { value: 'perplexity-context', label: 'perplexity-context', desc: 'best accuracy',          badge: '★' },
    { value: 'perplexity',         label: 'perplexity',         desc: 'fast, high quality' },
    { value: 'openai',             label: 'openai',             desc: 'text-embedding-3-small' },
    { value: 'local',              label: 'local',              desc: 'offline, no API key' },
];

const PRUNERS: OptionItem[] = [
    { value: 'haiku', label: 'haiku', desc: 'AI-powered noise filter', badge: '★' },
    { value: 'none',  label: 'none',  desc: 'no pruning' },
];

const EXPANDERS: OptionItem[] = [
    { value: 'haiku', label: 'haiku', desc: 'discovers related context', badge: '★' },
    { value: 'none',  label: 'none',  desc: 'no expansion' },
];


// ── Center-cursor scroll (Aurora pattern) ─────────────

function centerScroll(cursor: number, total: number, viewH: number): number {
    if (total <= viewH) return 0;
    const half = Math.floor(viewH / 2);
    const offset = Math.max(0, cursor - half);
    return Math.min(offset, total - viewH);
}


// ── Tree Row ──────────────────────────────────────────

function TreeItemRow({ item, isCursor }: {
    item: FileTreeItem; isCursor: boolean;
}): React.ReactNode {
    const indent = '  '.repeat(item.depth);
    const excluded = !item.checked;
    const ptr = isCursor ? '▸ ' : '  ';

    if (item.isDir) {
        const arrow = item.expanded ? '▾' : '▸';
        const check = item.checked ? '✓' : '✗';
        const checkColor = item.checked ? C.success : C.error;
        const nameColor = excluded ? C.dim : isCursor ? C.aurora : C.dir;
        const count = String(item.fileCount);

        return (
            <Box height={1}>
                <Text wrap="truncate">
                    <Text color={isCursor ? C.aurora : C.dim}>{ptr}</Text>
                    <Text>{indent}</Text>
                    <Text color={C.dim}>{arrow} </Text>
                    <Text color={checkColor} bold>{check} </Text>
                    <Text color={nameColor} bold={isCursor}>{item.name}/</Text>
                    <Text color={C.dim}> {count}</Text>
                </Text>
            </Box>
        );
    }

    const badge = extBadge(item.ext);
    const color = excluded ? C.dim : getExtColor(item.ext);

    return (
        <Box height={1}>
            <Text wrap="truncate">
                <Text color={isCursor ? C.aurora : C.dim}>{ptr}</Text>
                <Text>{indent}</Text>
                <Text color={excluded ? C.dim : color} bold>{badge}</Text>
                <Text> </Text>
                <Text color={excluded ? C.dim : C.text}>{item.name}</Text>
            </Text>
        </Box>
    );
}


// ── Main Screen (sidebar + tree) ──────────────────────

function MainScreen({ scan, width, height, onConfirm }: {
    scan: ScanResult; width: number; height: number;
    onConfirm: (modules: string[], include: string[], ignore: string[]) => void;
}): React.ReactNode {
    const { exit } = useApp();
    const allMods = scan.modules;

    // Pane focus
    const [pane, setPane] = useState<Pane>('modules');

    // Module state — pre-populate from config if plugins exist
    const [checked, setChecked] = useState<Set<string>>(() => {
        const configPlugins = scan.config.plugins;
        if (configPlugins && configPlugins.length > 0) {
            // --setup: match existing config selection
            return new Set(configPlugins.filter(p => allMods.some(m => m.name === p)));
        }
        // Fresh: check all available modules
        return new Set(allMods.filter(m => m.available && m.checked).map(m => m.name));
    });
    const firstAvail = allMods.findIndex(m => m.available);
    const [modCursor, setModCursor] = useState(Math.max(0, firstAvail));

    // Tree state — pre-populate checked from config include patterns
    const [treeItems, setTreeItems] = useState<FileTreeItem[]>(() => buildFileTree(scan.repoPath, scan.config.include));
    const [treeCursor, setTreeCursor] = useState(0);

    // Docs & Git preview (lazy, memoized)
    const docsPreview = useMemo(() => scanDocsPreview(scan.repoPath), [scan.repoPath]);
    const gitPreview = useMemo(() => scanGitPreview(scan.repoPath), [scan.repoPath]);

    // Which module is focused determines Explorer content
    const focusedModName = allMods[modCursor]?.name ?? 'code';

    // Panel height = total height - header(3) - footer(2) - borders
    const panelH = Math.max(6, height - 7);
    const treeViewH = Math.max(3, panelH - 4); // border(2) + title(1) + title margin(1)

    const scrollOffset = useMemo(
        () => centerScroll(treeCursor, treeItems.length, treeViewH),
        [treeCursor, treeItems.length, treeViewH],
    );

    // Module nav (skip disabled)
    const modUp = () => setModCursor(p => {
        for (let i = p - 1; i >= 0; i--) if (allMods[i]!.available) return i;
        return p;
    });
    const modDown = () => setModCursor(p => {
        for (let i = p + 1; i < allMods.length; i++) if (allMods[i]!.available) return i;
        return p;
    });

    useInput((input, key) => {
        if (key.escape || input === 'q') { exit(); return; }
        if (key.tab) { setPane(p => p === 'modules' ? 'tree' : 'modules'); return; }

        if (key.return) {
            const selected = [...checked];
            if (selected.length === 0) return;
            const patterns = generatePatternsFromTree(treeItems);
            onConfirm(selected, patterns.include, patterns.ignore);
            return;
        }

        // ── Modules pane ──
        if (pane === 'modules') {
            if (key.upArrow || input === 'k') { modUp(); return; }
            if (key.downArrow || input === 'j') { modDown(); return; }
            if (input === ' ') {
                const mod = allMods[modCursor];
                if (!mod?.available) return;
                setChecked(prev => {
                    const next = new Set(prev);
                    if (next.has(mod.name)) next.delete(mod.name); else next.add(mod.name);
                    return next;
                });
                return;
            }
        }

        // ── Tree pane ──
        if (pane === 'tree') {
            if (key.upArrow || input === 'k') {
                setTreeCursor(p => Math.max(0, p - 1));
                return;
            }
            if (key.downArrow || input === 'j') {
                setTreeCursor(p => Math.min(treeItems.length - 1, p + 1));
                return;
            }
            if (key.rightArrow || input === 'l') {
                const item = treeItems[treeCursor];
                if (item?.isDir && !item.expanded) {
                    setTreeItems(prev => expandDir(prev, treeCursor, scan.repoPath));
                }
                return;
            }
            if (key.leftArrow || input === 'h') {
                const item = treeItems[treeCursor];
                if (item?.isDir && item.expanded) {
                    setTreeItems(prev => collapseDir(prev, treeCursor));
                }
                return;
            }
            if (input === ' ') {
                const item = treeItems[treeCursor];
                if (item?.isDir) setTreeItems(prev => toggleDir(prev, treeCursor));
                return;
            }
            if (input === 'a') { setTreeItems(prev => setAllDirs(prev, true)); return; }
            if (input === 'n') { setTreeItems(prev => setAllDirs(prev, false)); return; }
            if (input === 'i') {
                setTreeItems(prev => prev.map(it => ({ ...it, checked: !it.checked })));
                return;
            }
        }
    });

    const totalFiles = countTotalFiles(treeItems);
    const selectedDirs = treeItems.filter(i => i.depth === 0 && i.isDir && i.checked).length;
    const totalDirs = treeItems.filter(i => i.depth === 0 && i.isDir).length;
    const visible = treeItems.slice(scrollOffset, scrollOffset + treeViewH);
    const dbInfo = scan.db?.exists ? `${scan.db.sizeMB} MB` : 'new';
    const sidebarW = 30;

    return (
        <Box flexDirection="column" width={width}>
            {/* Repo info */}
            <Box paddingX={2} gap={2} marginTop={1} marginBottom={1}>
                <Text color={C.aurora} bold>BrainBank</Text>
                <Text color={C.dim}>·</Text>
                <Text color={C.text}>{scan.repoPath}</Text>
                <Text color={C.dim}>· 💾 {dbInfo}</Text>
            </Box>

            {/* Split panels — same height */}
            <Box flexDirection="row" gap={1} height={panelH}>
                {/* Left: Module sidebar */}
                <Box flexDirection="column" width={sidebarW}
                    borderStyle="round" borderColor={pane === 'modules' ? C.aurora : C.border}
                >
                    <Box paddingX={1}>
                        <Text color={pane === 'modules' ? C.aurora : C.dim} bold>Modules</Text>
                    </Box>
                    <Box flexDirection="column" paddingX={1} paddingY={1}>
                        {allMods.map((m, i) => {
                            const avail = m.available;
                            const isCur = i === modCursor;
                            const isChk = checked.has(m.name);
                            const box = !avail ? '─' : isChk ? '✓' : ' ';
                            const boxCol = !avail ? C.dim : isChk ? C.success : C.dim;
                            const curCol = isCur ? (pane === 'modules' ? C.aurora : C.dim) : 'transparent';

                            return (
                                <Box key={m.name} height={1}>
                                    <Text color={curCol}>{isCur ? '▸' : ' '} </Text>
                                    <Text color={boxCol}>[{box}] </Text>
                                    <Text color={avail ? C.text : C.dim}>
                                        {m.name.charAt(0).toUpperCase() + m.name.slice(1)}
                                    </Text>
                                </Box>
                            );
                        })}
                    </Box>
                    {/* Fill to match tree height */}
                    <Box flexGrow={1} />
                    <Box paddingX={1} paddingBottom={1} flexDirection="column">
                        {allMods.filter(m => m.available && checked.has(m.name)).map(m => (
                            <Box key={`s${m.name}`} height={1}>
                                <Text color={C.dim} wrap="truncate">{m.summary}</Text>
                            </Box>
                        ))}
                    </Box>
                </Box>

                {/* Right: Explorer — contextual based on sidebar cursor */}
                <Box flexDirection="column" flexGrow={1}
                    borderStyle="round" borderColor={pane === 'tree' ? C.aurora : C.border}
                    marginBottom={1}
                >
                    <Box paddingX={1} justifyContent="space-between" marginBottom={1}>
                        <Text>
                            <Text color={pane === 'tree' ? C.aurora : C.dim} bold>Explorer</Text>
                            <Text color={C.dim}> · </Text>
                            <Text color={C.text}>{focusedModName.charAt(0).toUpperCase() + focusedModName.slice(1)}</Text>
                        </Text>
                        {focusedModName === 'code' && (
                            <Text color={C.dim}>{selectedDirs}/{totalDirs} dirs · {totalFiles} files</Text>
                        )}
                    </Box>

                    {/* Code: interactive tree */}
                    {focusedModName === 'code' && (
                        <Box flexDirection="column" paddingLeft={1} height={treeViewH} overflow="hidden">
                            {visible.map((item, i) => {
                                const globalIdx = scrollOffset + i;
                                return (
                                    <TreeItemRow key={item.path} item={item}
                                        isCursor={pane === 'tree' && globalIdx === treeCursor}
                                    />
                                );
                            })}
                            {visible.length < treeViewH && Array.from(
                                { length: treeViewH - visible.length },
                                (_, i) => <Box key={`e${i}`} height={1}><Text> </Text></Box>,
                            )}
                        </Box>
                    )}

                    {/* Docs: static preview */}
                    {focusedModName === 'docs' && (
                        <Box flexDirection="column" paddingLeft={1} height={treeViewH} overflow="hidden">
                            {docsPreview.slice(0, treeViewH).map((line, i) => (
                                <Text key={`d${i}`} color={line.dim ? C.dim : line.color ?? C.text}
                                    bold={line.bold} wrap="truncate"
                                >{line.text}</Text>
                            ))}
                        </Box>
                    )}

                    {/* Git: static preview */}
                    {focusedModName === 'git' && (
                        <Box flexDirection="column" paddingLeft={1} height={treeViewH} overflow="hidden">
                            {gitPreview.slice(0, treeViewH).map((line, i) => (
                                <Text key={`g${i}`} color={line.dim ? C.dim : line.color ?? C.text}
                                    bold={line.bold} wrap="truncate"
                                >{line.text}</Text>
                            ))}
                        </Box>
                    )}

                    {focusedModName === 'code' && treeItems.length > treeViewH && (
                        <Box paddingX={2} justifyContent="flex-end">
                            <Text color={C.dim}>
                                {scrollOffset + 1}–{Math.min(scrollOffset + treeViewH, treeItems.length)}/{treeItems.length}
                            </Text>
                        </Box>
                    )}
                </Box>
            </Box>

            {/* Footer */}
            <Box paddingX={2} justifyContent="space-between" marginTop={1}>
                <Text color={C.dim}>
                    <Text color={C.aurora}>Tab</Text> pane
                    <Text color={C.dim}> · </Text>
                    <Text color={C.aurora}>↑↓</Text> move
                    <Text color={C.dim}> · </Text>
                    <Text color={C.aurora}>Space</Text> toggle
                    <Text color={C.dim}> · </Text>
                    <Text color={C.aurora}>→←</Text> expand
                    <Text color={C.dim}> · </Text>
                    <Text color={C.aurora}>a</Text> all
                    <Text color={C.dim}> · </Text>
                    <Text color={C.aurora}>n</Text> none
                    <Text color={C.dim}> · </Text>
                    <Text color={C.aurora}>i</Text> invert
                </Text>
                <Text color={C.aurora} bold>
                    Enter: {scan.config.exists ? 'Index ⚡' : 'Next →'}
                </Text>
            </Box>
        </Box>
    );
}


// ── Config Panel ───────────────────────────────────────

function ConfigPanel({ onDone }: {
    onDone: (embedding: string, pruner: string, expander: string) => void;
}): React.ReactNode {
    const { exit } = useApp();
    type Section = 'embedding' | 'pruner' | 'expander';
    const SECTIONS: Section[] = ['embedding', 'pruner', 'expander'];
    const [section, setSection] = useState<Section>('embedding');
    const [embIdx, setEmbIdx] = useState(0);
    const [prunerIdx, setPrunerIdx] = useState(0);
    const [expanderIdx, setExpanderIdx] = useState(0);

    useInput((input, key) => {
        if (key.escape || input === 'q') { exit(); return; }
        if (key.upArrow || input === 'k') {
            if (section === 'embedding') setEmbIdx(p => Math.max(0, p - 1));
            else if (section === 'pruner') setPrunerIdx(p => Math.max(0, p - 1));
            else setExpanderIdx(p => Math.max(0, p - 1));
            return;
        }
        if (key.downArrow || input === 'j') {
            if (section === 'embedding') setEmbIdx(p => Math.min(EMBEDDINGS.length - 1, p + 1));
            else if (section === 'pruner') setPrunerIdx(p => Math.min(PRUNERS.length - 1, p + 1));
            else setExpanderIdx(p => Math.min(EXPANDERS.length - 1, p + 1));
            return;
        }
        if (key.tab) {
            setSection(p => {
                const idx = SECTIONS.indexOf(p);
                return SECTIONS[(idx + 1) % SECTIONS.length]!;
            });
            return;
        }
        if (key.return) {
            onDone(EMBEDDINGS[embIdx]!.value, PRUNERS[prunerIdx]!.value, EXPANDERS[expanderIdx]!.value);
            return;
        }
    });

    const renderOpt = (item: OptionItem, i: number, cur: boolean, sel: boolean) => (
        <Box key={item.value} height={1}>
            <Text color={cur ? C.aurora : C.dim}>{cur ? '▸' : ' '} </Text>
            <Text color={sel ? C.success : C.dim}>{sel ? '●' : '○'} </Text>
            <Text color={cur ? C.text : C.dim} bold={cur}>{item.label.padEnd(22)}</Text>
            <Text color={C.dim}>{item.desc}</Text>
            {item.badge ? <Text color={C.warning}> {item.badge}</Text> : null}
        </Box>
    );

    return (
        <Box flexDirection="column" paddingX={1}>
            <Box justifyContent="center" marginBottom={1}>
                <Text color={C.cyan} bold>⚙ First-Time Setup</Text>
            </Box>
            <Box flexDirection="column" borderStyle="round"
                borderColor={section === 'embedding' ? C.aurora : C.border} paddingX={2} paddingY={1}
            >
                <Box marginBottom={1}>
                    <Text color={section === 'embedding' ? C.aurora : C.dim} bold>Embedding Provider</Text>
                </Box>
                {EMBEDDINGS.map((it, i) => renderOpt(it, i, section === 'embedding' && i === embIdx, i === embIdx))}
            </Box>
            <Box flexDirection="column" borderStyle="round"
                borderColor={section === 'pruner' ? C.aurora : C.border} paddingX={2} paddingY={1}
            >
                <Box marginBottom={1}>
                    <Text color={section === 'pruner' ? C.aurora : C.dim} bold>Noise Pruner</Text>
                </Box>
                {PRUNERS.map((it, i) => renderOpt(it, i, section === 'pruner' && i === prunerIdx, i === prunerIdx))}
            </Box>
            <Box flexDirection="column" borderStyle="round"
                borderColor={section === 'expander' ? C.aurora : C.border} paddingX={2} paddingY={1}
            >
                <Box marginBottom={1}>
                    <Text color={section === 'expander' ? C.aurora : C.dim} bold>Context Expander</Text>
                </Box>
                {EXPANDERS.map((it, i) => renderOpt(it, i, section === 'expander' && i === expanderIdx, i === expanderIdx))}
            </Box>
            <Box paddingX={1} marginTop={1}>
                <Text color={C.dim}>
                    <Text color={C.aurora}>↑↓</Text> select · <Text color={C.aurora}>Tab</Text> section · <Text color={C.aurora}>Enter</Text> start indexing
                </Text>
            </Box>
        </Box>
    );
}


// ── App Root ────────────────────────────────────────────

function IndexApp({ scan }: { scan: ScanResult }): React.ReactNode {
    const { exit } = useApp();
    const { stdout } = useStdout();
    const [rawW, setRawW] = useState(stdout?.columns || 100);
    const [rawH, setRawH] = useState(stdout?.rows || 30);
    const [phase, setPhase] = useState<Phase>('main');
    const [selectedModules, setSelectedModules] = useState<string[]>([]);
    const [patterns, setPatterns] = useState({ include: [] as string[], ignore: [] as string[] });

    const width = Math.min(rawW, MAX_W);
    const height = Math.min(rawH, MAX_H);

    useEffect(() => {
        if (!stdout) return;
        const onResize = () => { setRawW(stdout.columns); setRawH(stdout.rows); };
        stdout.on('resize', onResize);
        return () => { stdout.off('resize', onResize); };
    }, [stdout]);

    const handleMainConfirm = (modules: string[], include: string[], ignore: string[]) => {
        setSelectedModules(modules);
        setPatterns({ include, ignore });
        if (scan.config.exists) {
            _lastSelection = { modules, include, ignore };
            setTimeout(() => exit(), 50);
        } else {
            setPhase('config');
        }
    };

    const handleConfigDone = (embedding: string, pruner: string, expander: string) => {
        _lastSelection = { modules: selectedModules, ...patterns, config: { embedding, pruner, expander } };
        setTimeout(() => exit(), 50);
    };

    return (
        <Box flexDirection="column" width={width} height={height}>
            {phase === 'main' && (
                <MainScreen scan={scan} width={width} height={height}
                    onConfirm={handleMainConfirm}
                />
            )}
            {phase === 'config' && <ConfigPanel onDone={handleConfigDone} />}
        </Box>
    );
}


// ── Public API ─────────────────────────────────────────

let _lastSelection: TuiSelection | null = null;

export async function runIndexTui(scan: ScanResult): Promise<TuiSelection | null> {
    _lastSelection = null;
    const instance = render(<IndexApp scan={scan} />);
    await instance.waitUntilExit();
    return _lastSelection;
}

/**
 * tree-scanner.ts — Filesystem scanner for the index TUI.
 *
 * Builds interactive file tree data (dirs + files) for navigation.
 * Pure functions, no React, no state. Reuses existing language filters.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import picomatch from 'picomatch';
import { SUPPORTED_EXTENSIONS, isIgnoredDir } from '@/lib/languages.ts';


// ── Types ─────────────────────────────────────────────

/** A single item in the interactive file tree (dir or file). */
export interface FileTreeItem {
    /** Relative path from repo root. */
    path: string;
    /** Display name (basename). */
    name: string;
    /** Nesting depth (0 = top-level). */
    depth: number;
    /** Is this a directory? */
    isDir: boolean;
    /** File extension (e.g. '.ts'). Empty for dirs. */
    ext: string;
    /** Whether included for indexing. Only togglable on dirs. */
    checked: boolean;
    /** Whether children are visible (dirs only). */
    expanded: boolean;
    /** Has indexable content below (dirs only). */
    hasChildren: boolean;
    /** Indexable file count (dirs only, recursive). */
    fileCount: number;
}


// ── Extension colors (VSCode-inspired) ────────────────

const EXT_COLORS: Record<string, string> = {
    '.ts':     '#519ABA',
    '.tsx':    '#519ABA',
    '.js':     '#CBCB41',
    '.jsx':    '#61DAFB',
    '.mjs':    '#CBCB41',
    '.py':     '#4B8BBE',
    '.go':     '#7FD5EA',
    '.rs':     '#DEA584',
    '.rb':     '#CC3E44',
    '.java':   '#CC3E44',
    '.c':      '#599EFF',
    '.cpp':    '#599EFF',
    '.h':      '#926BD4',
    '.cs':     '#68217A',
    '.php':    '#777BB3',
    '.swift':  '#F05138',
    '.kt':     '#7F52FF',
    '.css':    '#42A5F5',
    '.scss':   '#F06292',
    '.html':   '#E44D26',
    '.vue':    '#8DC149',
    '.svelte': '#FF3E00',
    '.json':   '#CBCB41',
    '.yaml':   '#F44336',
    '.yml':    '#F44336',
    '.md':     '#519ABA',
    '.sql':    '#E0B040',
    '.sh':     '#89E051',
    '.bash':   '#89E051',
    '.zsh':    '#89E051',
    '.lua':    '#51A0CF',
    '.zig':    '#F69A1B',
};

/** Get the display color for a file extension. */
export function getExtColor(ext: string): string {
    return EXT_COLORS[ext] ?? '#7C8DA6';
}

/** Get a short icon-like label for the extension. */
export function getExtIcon(ext: string): string {
    switch (ext) {
        case '.ts': case '.tsx': return '⬡';
        case '.js': case '.jsx': case '.mjs': return '⬡';
        case '.py': return '◆';
        case '.go': return '◇';
        case '.rs': return '⛭';
        case '.md': return '◎';
        case '.json': case '.yaml': case '.yml': return '◉';
        case '.css': case '.scss': return '◈';
        case '.html': case '.vue': case '.svelte': return '◇';
        case '.sh': case '.bash': case '.zsh': return '⚙';
        default: return '○';
    }
}


// ── Build file tree ───────────────────────────────────

/**
 * Build the initial interactive tree — top-level dirs expanded,
 * showing both dirs and files. Returns a flat list.
 */
export function buildFileTree(repoPath: string, include?: string[]): FileTreeItem[] {
    const items: FileTreeItem[] = [];
    const entries = readSortedEntries(repoPath);

    // Build a matcher to determine initial checked state
    const hasInclude = include && include.length > 0;
    const isIncluded = hasInclude ? picomatch(include, { dot: true }) : null;
    // Extract base prefixes for dir-level checks (e.g. 'apps/admin/app' from 'apps/admin/app/**')
    const includeBases = hasInclude
        ? include.map(p => picomatch.scan(p).base).filter(b => b && b !== '.')
        : null;

    /** Check if a relative path (dir or file) should be checked based on include patterns. */
    function shouldCheck(relPath: string, isDir: boolean): boolean {
        if (!hasInclude) return true; // no include filter → check everything
        // For files: match against the include patterns directly
        if (!isDir) return isIncluded!(relPath);
        // For dirs: check if this dir is a prefix of any include base, or vice versa
        if (includeBases) {
            return includeBases.some(base =>
                relPath.startsWith(base) || base.startsWith(relPath),
            );
        }
        return true;
    }

    for (const entry of entries) {
        if (entry.isDir) {
            const dirPath = path.join(repoPath, entry.name);
            const stats = scanDirStats(dirPath);
            if (stats.total === 0) continue;

            const dirChecked = shouldCheck(entry.name, true);

            // Top-level dir — auto-expanded
            items.push({
                path: entry.name,
                name: entry.name,
                depth: 0,
                isDir: true,
                ext: '',
                checked: dirChecked,
                expanded: true,
                hasChildren: true,
                fileCount: stats.total,
            });

            // Add children (depth 1)
            const children = readSortedEntries(dirPath);
            for (const child of children) {
                const childRel = `${entry.name}/${child.name}`;

                if (child.isDir) {
                    const childAbs = path.join(dirPath, child.name);
                    const cs = scanDirStats(childAbs);
                    if (cs.total === 0) continue;

                    items.push({
                        path: childRel,
                        name: child.name,
                        depth: 1,
                        isDir: true,
                        ext: '',
                        checked: shouldCheck(childRel, true),
                        expanded: false,
                        hasChildren: cs.hasSubdirs || cs.total > 0,
                        fileCount: cs.total,
                    });
                } else {
                    const ext = path.extname(child.name).toLowerCase();
                    if (!SUPPORTED_EXTENSIONS[ext]) continue;

                    items.push({
                        path: childRel,
                        name: child.name,
                        depth: 1,
                        isDir: false,
                        ext,
                        checked: shouldCheck(childRel, false),
                        expanded: false,
                        hasChildren: false,
                        fileCount: 0,
                    });
                }
            }
        } else {
            // Root-level file
            const ext = path.extname(entry.name).toLowerCase();
            if (!SUPPORTED_EXTENSIONS[ext]) continue;

            items.push({
                path: entry.name,
                name: entry.name,
                depth: 0,
                isDir: false,
                ext,
                checked: shouldCheck(entry.name, false),
                expanded: false,
                hasChildren: false,
                fileCount: 0,
            });
        }
    }

    return items;
}


/** Expand a directory — insert its children after it. Returns new array. */
export function expandDir(items: FileTreeItem[], index: number, repoPath: string): FileTreeItem[] {
    const node = items[index];
    if (!node || !node.isDir || node.expanded) return items;

    const absDir = path.join(repoPath, node.path);
    const entries = readSortedEntries(absDir);
    const children: FileTreeItem[] = [];

    for (const entry of entries) {
        const childRel = `${node.path}/${entry.name}`;

        if (entry.isDir) {
            const childAbs = path.join(absDir, entry.name);
            const stats = scanDirStats(childAbs);
            if (stats.total === 0) continue;

            children.push({
                path: childRel,
                name: entry.name,
                depth: node.depth + 1,
                isDir: true,
                ext: '',
                checked: node.checked,
                expanded: false,
                hasChildren: stats.hasSubdirs || stats.total > 0,
                fileCount: stats.total,
            });
        } else {
            const ext = path.extname(entry.name).toLowerCase();
            if (!SUPPORTED_EXTENSIONS[ext]) continue;

            children.push({
                path: childRel,
                name: entry.name,
                depth: node.depth + 1,
                isDir: false,
                ext,
                checked: node.checked,
                expanded: false,
                hasChildren: false,
                fileCount: 0,
            });
        }
    }

    const next = [...items];
    next[index] = { ...node, expanded: true };
    next.splice(index + 1, 0, ...children);
    return next;
}


/** Collapse a directory — remove all deeper items after it. Returns new array. */
export function collapseDir(items: FileTreeItem[], index: number): FileTreeItem[] {
    const node = items[index];
    if (!node || !node.isDir || !node.expanded) return items;

    let removeCount = 0;
    for (let i = index + 1; i < items.length; i++) {
        if (items[i]!.depth <= node.depth) break;
        removeCount++;
    }

    const next = [...items];
    next[index] = { ...node, expanded: false };
    next.splice(index + 1, removeCount);
    return next;
}


/** Toggle a directory's checked state, cascading to visible children. */
export function toggleDir(items: FileTreeItem[], index: number): FileTreeItem[] {
    const node = items[index];
    if (!node || !node.isDir) return items;

    const newChecked = !node.checked;
    const next = [...items];
    next[index] = { ...node, checked: newChecked };

    // Cascade DOWN to children only
    for (let i = index + 1; i < next.length; i++) {
        if (next[i]!.depth <= node.depth) break;
        next[i] = { ...next[i]!, checked: newChecked };
    }

    return next;
}


/** Toggle an individual file's checked state. */
export function toggleFile(items: FileTreeItem[], index: number): FileTreeItem[] {
    const node = items[index];
    if (!node || node.isDir) return items;

    const next = [...items];
    next[index] = { ...node, checked: !node.checked };
    return next;
}


/** Set all dirs to checked or unchecked. */
export function setAllDirs(items: FileTreeItem[], checked: boolean): FileTreeItem[] {
    return items.map(item => item.isDir ? { ...item, checked } : { ...item, checked });
}


/** Generate include/ignore patterns from tree state. */
export function generatePatternsFromTree(
    items: FileTreeItem[],
    originalInclude?: string[],
): { include: string[]; ignore: string[] } {
    const include: string[] = [];
    const ignore: string[] = [];

    const allDirs = items.filter(i => i.isDir);
    const topDirs = allDirs.filter(i => i.depth === 0);

    // If everything is checked, no filtering needed
    if (topDirs.every(d => d.checked)) {
        const uncheckedSubs = allDirs.filter(d => !d.checked && d.depth > 0);
        if (uncheckedSubs.length === 0) return { include: [], ignore: [] };
        for (const item of uncheckedSubs) {
            ignore.push(`${item.path}/**`);
        }
        return { include, ignore };
    }

    // If nothing is checked, return empty
    if (allDirs.every(d => !d.checked)) {
        return { include: [], ignore: [] };
    }

    // Build lookup: for each dir path, which original patterns applied to it
    const originalByDir = new Map<string, string[]>();
    if (originalInclude && originalInclude.length > 0) {
        for (const pattern of originalInclude) {
            // Extract the base directory from the pattern
            const base = pattern.replace(/\/\*\*$/, '').replace(/\/\*$/, '');
            // Find which top-level (or depth-1) dir this pattern falls under
            const parts = base.split('/');
            // Map to all ancestor dirs
            for (let i = 1; i <= parts.length; i++) {
                const dirPath = parts.slice(0, i).join('/');
                const existing = originalByDir.get(dirPath) ?? [];
                existing.push(pattern);
                originalByDir.set(dirPath, existing);
            }
        }
    }

    /** Get visible children of a dir in the flat list */
    function getVisibleChildren(parentIdx: number): FileTreeItem[] {
        const parent = items[parentIdx]!;
        const children: FileTreeItem[] = [];
        for (let i = parentIdx + 1; i < items.length; i++) {
            if (items[i]!.depth <= parent.depth) break;
            if (items[i]!.depth === parent.depth + 1) children.push(items[i]!);
        }
        return children;
    }

    /** Check if a dir is a "full inclusion" — all its visible children are checked */
    function isFullInclusion(idx: number): boolean {
        const children = getVisibleChildren(idx);
        if (children.length === 0) return true;
        return children.filter(c => c.isDir).every(c => c.checked);
    }

    // Walk checked dirs and determine include patterns
    for (let i = 0; i < items.length; i++) {
        const item = items[i]!;
        if (!item.isDir || !item.checked) continue;

        // Skip if a REAL ancestor is also checked and is a full inclusion
        let coveredByParent = false;
        for (let j = i - 1; j >= 0; j--) {
            const ancestor = items[j]!;
            if (ancestor.isDir && ancestor.depth < item.depth
                && item.path.startsWith(ancestor.path + '/')
                && ancestor.checked) {
                if (isFullInclusion(j)) {
                    coveredByParent = true;
                }
                break;
            }
        }
        if (coveredByParent) continue;

        // Check if original patterns exist for this dir — preserve them
        const origPatterns = originalByDir.get(item.path);
        if (origPatterns && origPatterns.length > 0) {
            // Use original patterns that are scoped to or under this dir
            for (const p of origPatterns) {
                if (!include.includes(p)) {
                    include.push(p);
                }
            }
        } else {
            // New selection — generate fresh pattern
            include.push(`${item.path}/**`);
        }
    }

    // Build a set of included dir prefixes for coverage checks
    const includedPrefixes = new Set(include);

    // Handle individually checked files whose parent dir is NOT in the include set
    for (const item of items) {
        if (item.isDir || !item.checked) continue;
        // Check if this file is already covered by an included directory
        const covered = [...includedPrefixes].some(p => {
            const base = p.replace(/\/\*\*$/, '').replace(/\/\*$/, '');
            return item.path.startsWith(base + '/') || item.path === base;
        });
        if (!covered) {
            include.push(item.path);
        }
    }

    // Handle individually unchecked files inside checked directories
    for (const item of items) {
        if (item.isDir || item.checked) continue;
        const parentPath = item.path.split('/').slice(0, -1).join('/');
        const parentIncluded = includedPrefixes.has(`${parentPath}/**`);
        if (parentIncluded) {
            ignore.push(item.path);
        }
    }

    return { include, ignore };
}


/** Count total selected files in the tree. */
export function countSelectedFiles(items: FileTreeItem[]): number {
    let total = 0;
    for (const item of items) {
        if (!item.isDir && item.checked) total++;
        // Count expanded dirs' direct file count only if not expanded (avoid double count)
        if (item.isDir && item.checked && !item.expanded) total += item.fileCount;
    }
    return total;
}


/** Count total files in the tree. */
export function countTotalFiles(items: FileTreeItem[]): number {
    return items.filter(i => i.depth === 0 && i.isDir).reduce((s, i) => s + i.fileCount, 0)
        + items.filter(i => i.depth === 0 && !i.isDir).length;
}


// ── Internal helpers ──────────────────────────────────

interface DirStats {
    total: number;
    byLang: Map<string, number>;
    hasSubdirs: boolean;
}

function scanDirStats(dirPath: string): DirStats {
    const byLang = new Map<string, number>();
    let total = 0;
    let hasSubdirs = false;

    function walk(dir: string): void {
        for (const entry of readDirSafe(dir)) {
            if (isDirEntry(dir, entry)) {
                if (isIgnoredDir(entry.name) || entry.name.startsWith('.')) continue;
                hasSubdirs = true;
                walk(path.join(dir, entry.name));
            } else if (entry.isFile()) {
                const ext = path.extname(entry.name).toLowerCase();
                const lang = SUPPORTED_EXTENSIONS[ext];
                if (lang) { byLang.set(lang, (byLang.get(lang) ?? 0) + 1); total++; }
            }
        }
    }

    walk(dirPath);
    return { total, byLang, hasSubdirs };
}

interface SortedEntry { name: string; isDir: boolean }

function readSortedEntries(dir: string): SortedEntry[] {
    const raw = readDirSafe(dir);
    const entries: SortedEntry[] = [];

    for (const e of raw) {
        if (e.name.startsWith('.')) continue;
        if (isDirEntry(dir, e)) {
            if (isIgnoredDir(e.name)) continue;
            entries.push({ name: e.name, isDir: true });
        } else if (e.isFile()) {
            entries.push({ name: e.name, isDir: false });
        }
    }

    return entries.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
    });
}

function readDirSafe(dir: string): fs.Dirent[] {
    try { return fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return []; }
}

function isDirEntry(parentDir: string, entry: fs.Dirent): boolean {
    if (entry.isDirectory()) return true;
    if (entry.isSymbolicLink()) {
        try { return fs.statSync(path.join(parentDir, entry.name)).isDirectory(); }
        catch { return false; }
    }
    return false;
}


// ── Docs & Git preview ────────────────────────────────

export interface PreviewLine {
    text: string;
    color?: string;
    bold?: boolean;
    dim?: boolean;
}

/** Scan all markdown files and return preview lines. */
export function scanDocsPreview(repoPath: string): PreviewLine[] {
    const mdFiles: string[] = [];

    function walk(dir: string, rel: string): void {
        for (const entry of readDirSafe(dir)) {
            if (entry.name.startsWith('.')) continue;
            const fullPath = path.join(dir, entry.name);
            const relPath = rel ? `${rel}/${entry.name}` : entry.name;

            if (isDirEntry(dir, entry)) {
                if (isIgnoredDir(entry.name)) continue;
                walk(fullPath, relPath);
            } else if (entry.isFile() && entry.name.endsWith('.md')) {
                mdFiles.push(relPath);
            }
        }
    }

    walk(repoPath, '');
    mdFiles.sort();

    if (mdFiles.length === 0) {
        return [{ text: '  No markdown files found', dim: true }];
    }

    const lines: PreviewLine[] = [
        { text: `📄 ${mdFiles.length} markdown files`, bold: true },
        { text: '' },
    ];

    // Group by top-level dir
    const groups = new Map<string, string[]>();
    for (const f of mdFiles) {
        const parts = f.split('/');
        const group = parts.length > 1 ? parts[0]! : '(root)';
        const list = groups.get(group) || [];
        list.push(f);
        groups.set(group, list);
    }

    for (const [group, files] of groups) {
        if (group !== '(root)') {
            lines.push({ text: `  ${group}/`, bold: true, color: '#E0AF68' });
        }
        for (const f of files) {
            const name = group === '(root)' ? f : f.slice(group.length + 1);
            lines.push({ text: `    MD  ${name}`, color: '#519ABA' });
        }
        lines.push({ text: '' });
    }

    return lines;
}

/** Scan recent git commits and return preview lines. */
export function scanGitPreview(repoPath: string): PreviewLine[] {
    const gitDir = path.join(repoPath, '.git');
    if (!fs.existsSync(gitDir)) {
        return [{ text: '  No .git directory found', dim: true }];
    }

    try {
        const raw = execSync(
            'git log --oneline --format="%h %ar %s" -n 20',
            { cwd: repoPath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
        ).trim();

        const commits = raw.split('\n').filter(Boolean);
        if (commits.length === 0) {
            return [{ text: '  No commits found', dim: true }];
        }

        // Count total commits
        let totalStr = '';
        try {
            totalStr = execSync('git rev-list --count HEAD',
                { cwd: repoPath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
            ).trim();
        } catch { /* ignore */ }

        const lines: PreviewLine[] = [
            { text: `📜 ${totalStr || '?'} commits`, bold: true },
            { text: '' },
        ];

        for (const line of commits) {
            const spaceIdx = line.indexOf(' ');
            const hash = line.slice(0, spaceIdx);
            const rest = line.slice(spaceIdx + 1);
            // Split "X ago message" — find second space after time
            const timeMatch = rest.match(/^(.+? ago) (.+)$/);
            if (timeMatch) {
                lines.push({
                    text: `  ${hash}  ${timeMatch[2]}`,
                    color: '#C0CAF5',
                });
            } else {
                lines.push({ text: `  ${hash}  ${rest}`, dim: true });
            }
        }

        return lines;
    } catch {
        return [{ text: '  Failed to read git log', dim: true }];
    }
}

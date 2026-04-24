/**
 * brainbank scan — Lightweight repo scanner for the interactive index flow.
 *
 * Scans the filesystem WITHOUT initializing BrainBank. Returns a ScanResult
 * describing what's available to index via dynamic ScanModule descriptors.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import picomatch from 'picomatch';
import { SUPPORTED_EXTENSIONS, isIgnoredDir, isIgnoredFile } from '@/lib/languages.ts';


/** A single scannable module (plugin). */
export interface ScanModule {
    /** Plugin name (e.g. 'code', 'git', 'docs'). */
    name: string;
    /** Whether there's content available to index. */
    available: boolean;
    /** Human-readable summary (e.g. '1243 files (5 languages)'). */
    summary: string;
    /** Emoji icon for display. */
    icon: string;
    /** Whether checked by default in the prompt. */
    checked: boolean;
    /** Reason this module is disabled (shown in prompt). */
    disabled?: string;
    /** Detail lines for the scan tree (e.g. per-language breakdown). */
    details?: string[];
}

export interface ScanResult {
    repoPath: string;
    modules: ScanModule[];
    config: { exists: boolean; ignore?: string[]; include?: string[]; plugins?: string[] };
    db: { exists: boolean; sizeMB: number; lastModified?: Date } | null;
}


/** Scan a repo path and return what's available to index. */
export function scanRepo(repoPath: string): ScanResult {
    const resolved = path.resolve(repoPath);
    const config = scanConfig(resolved);

    return {
        repoPath: resolved,
        modules: scanModules(resolved, config),
        config,
        db: scanDb(resolved),
    };
}

/** Produce ScanModule descriptors for known plugin types. */
function scanModules(repoPath: string, config: ScanResult['config']): ScanModule[] {
    return [
        scanCodeModule(repoPath, config.include, config.ignore),
        scanGitModule(repoPath),
        scanDocsModule(repoPath),
    ];
}


/** Scan for indexable code files. Respects include/ignore from config. */
function scanCodeModule(repoPath: string, include?: string[], ignore?: string[]): ScanModule {
    const byLanguage = new Map<string, number>();
    let total = 0;

    // Build matchers from config patterns
    let isIncluded: ((p: string) => boolean) | null = null;
    let isIgnoredPat: ((p: string) => boolean) | null = null;
    let includeBases: string[] | null = null;
    if (include?.length) {
        isIncluded = picomatch(include, { dot: true });
        includeBases = include.map(p => picomatch.scan(p).base).filter(b => b && b !== '.');
    }
    if (ignore?.length) isIgnoredPat = picomatch(ignore, { dot: true });

    function walk(dir: string): void {
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
        catch { return; }

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            const isDir = entry.isDirectory() || (entry.isSymbolicLink() && (() => { try { return fs.statSync(fullPath).isDirectory(); } catch { return false; } })());
            if (isDir) {
                if (isIgnoredDir(entry.name)) continue;
                // Early prune: if include bases are set, skip dirs that can't match
                if (includeBases && includeBases.length > 0) {
                    const relDir = path.relative(repoPath, fullPath);
                    const canMatch = includeBases.some(base =>
                        relDir.startsWith(base) || base.startsWith(relDir),
                    );
                    if (!canMatch) continue;
                }
                walk(fullPath);
            } else if (entry.isFile()) {
                if (isIgnoredFile(entry.name)) continue;
                const ext = path.extname(entry.name).toLowerCase();
                const lang = SUPPORTED_EXTENSIONS[ext];
                if (!lang) continue;

                // Apply include/ignore filters using relative path
                const rel = path.relative(repoPath, fullPath);
                if (isIncluded && !isIncluded(rel)) continue;
                if (isIgnoredPat && isIgnoredPat(rel)) continue;

                byLanguage.set(lang, (byLanguage.get(lang) ?? 0) + 1);
                total++;
            }
        }
    }

    walk(repoPath);

    if (total === 0) {
        return { name: 'code', available: false, summary: 'no supported source files found', icon: '📁', checked: false, disabled: 'nothing to index' };
    }

    const langCount = byLanguage.size;
    const sorted = [...byLanguage.entries()].sort((a, b) => b[1] - a[1]);
    const maxShow = 7;
    const shown = sorted.slice(0, maxShow);
    const remaining = sorted.length - maxShow;

    const details: string[] = [];
    for (let i = 0; i < shown.length; i++) {
        const [lang, count] = shown[i];
        const isLast = i === shown.length - 1 && remaining <= 0;
        const prefix = isLast ? '└──' : '├──';
        details.push(`${prefix} ${lang.padEnd(14)} ${count} files`);
    }
    if (remaining > 0) {
        details.push(`└── ...and ${remaining} more`);
    }

    return {
        name: 'code',
        available: true,
        summary: `${total} files (${langCount} language${langCount > 1 ? 's' : ''})`,
        icon: '📁',
        checked: true,
        details,
    };
}

/** Scan for git history. */
function scanGitModule(repoPath: string): ScanModule {
    const stats = scanGitStats(repoPath);

    if (!stats) {
        return { name: 'git', available: false, summary: 'no .git directory found', icon: '📜', checked: false, disabled: 'not a git repo' };
    }

    const details: string[] = [];
    if (stats.lastMessage) {
        details.push(`Last: ${stats.lastMessage} (${stats.lastDate})`);
    }

    return {
        name: 'git',
        available: true,
        summary: `${stats.commitCount.toLocaleString()} commits`,
        icon: '📜',
        checked: true,
        details,
    };
}

/** Scan for document collections. */
function scanDocsModule(repoPath: string): ScanModule {
    const collections = scanDocsCollections(repoPath);

    if (collections.length === 0) {
        return { name: 'docs', available: false, summary: 'no documents found', icon: '📄', checked: false, disabled: 'no .md/.mdx files' };
    }

    const totalFiles = collections.reduce((s, d) => s + d.fileCount, 0);
    const details = collections.map((d, i) => {
        const isLast = i === collections.length - 1;
        const prefix = isLast ? '└──' : '├──';
        return `${prefix} ${d.name.padEnd(10)} → ${d.path} (${d.fileCount} files)`;
    });

    return {
        name: 'docs',
        available: true,
        summary: `${collections.length} collection${collections.length > 1 ? 's' : ''} (${totalFiles} files)`,
        icon: '📄',
        checked: true,
        details,
    };
}


/** Get git stats for this repo. */
function scanGitStats(repoPath: string): { commitCount: number; lastMessage: string; lastDate: string } | null {
    if (!fs.existsSync(path.join(repoPath, '.git'))) return null;
    return gitStats(repoPath);
}

/** Get git stats for a single directory. */
function gitStats(dir: string): { commitCount: number; lastMessage: string; lastDate: string } | null {
    try {
        const count = parseInt(execSync('git rev-list --count HEAD', { cwd: dir, encoding: 'utf-8' }).trim(), 10);
        const log = execSync('git log -1 --format="%s|%ar"', { cwd: dir, encoding: 'utf-8' }).trim();
        const [lastMessage, lastDate] = log.split('|');
        return { commitCount: count, lastMessage: lastMessage ?? '', lastDate: lastDate ?? '' };
    } catch {
        return null;
    }
}

/** Scan for document collections (config + auto-detect). */
function scanDocsCollections(repoPath: string): { name: string; path: string; fileCount: number }[] {
    const results: { name: string; path: string; fileCount: number }[] = [];
    const seen = new Set<string>();

    // 1. Read explicit collections from config.json
    const configPath = path.join(repoPath, '.brainbank', 'config.json');
    try {
        if (fs.existsSync(configPath)) {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
            const docsCfg = config?.docs as Record<string, unknown> | undefined;
            const collections = docsCfg?.collections as { name: string; path: string }[] | undefined;
            if (collections) {
                for (const coll of collections) {
                    const absPath = path.resolve(repoPath, coll.path);
                    results.push({ name: coll.name, path: coll.path, fileCount: countDocs(absPath) });
                    seen.add(absPath);
                }
            }
        }
    } catch {}

    // 2. Auto-detect .md/.mdx in the repo root and top-level dirs
    const rootDocs = countDocsShallow(repoPath);
    if (rootDocs > 0) {
        results.push({ name: '(root)', path: '.', fileCount: rootDocs });
    }

    try {
        for (const entry of fs.readdirSync(repoPath, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            if (isIgnoredDir(entry.name)) continue;
            if (entry.name.startsWith('.')) continue;

            const dirPath = path.join(repoPath, entry.name);
            if (seen.has(dirPath)) continue;

            const count = countDocs(dirPath);
            if (count > 0) {
                results.push({ name: entry.name, path: `./${entry.name}`, fileCount: count });
            }
        }
    } catch {}

    return results;
}

/** Count .md/.mdx files recursively in a directory. */
function countDocs(dir: string): number {
    let count = 0;
    try {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const ePath = path.join(dir, e.name);
            const isDir = e.isDirectory() || (e.isSymbolicLink() && (() => { try { return fs.statSync(ePath).isDirectory(); } catch { return false; } })());
            if (isDir) {
                if (isIgnoredDir(e.name)) continue;
                count += countDocs(ePath);
            } else if ((e.isFile() || e.isSymbolicLink()) && /\.mdx?$/i.test(e.name)) {
                count++;
            }
        }
    } catch {}
    return count;
}

/** Count .md/.mdx files in a directory (non-recursive, root level only). */
function countDocsShallow(dir: string): number {
    let count = 0;
    try {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (e.isFile() && /\.mdx?$/i.test(e.name)) count++;
        }
    } catch {}
    return count;
}

/** Check if config.json exists and read key fields. */
function scanConfig(repoPath: string): ScanResult['config'] {
    const configPath = path.join(repoPath, '.brainbank', 'config.json');
    if (!fs.existsSync(configPath)) return { exists: false };

    try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
        const codeCfg = config?.code as Record<string, unknown> | undefined;

        // Merge root-level and per-plugin include/ignore
        const rootInclude = config?.include as string[] | undefined;
        const rootIgnore = config?.ignore as string[] | undefined;
        const pluginInclude = codeCfg?.include as string[] | undefined;
        const pluginIgnore = codeCfg?.ignore as string[] | undefined;

        const include = [...(rootInclude ?? []), ...(pluginInclude ?? [])];
        const ignore = [...(rootIgnore ?? []), ...(pluginIgnore ?? [])];

        return {
            exists: true,
            ignore: ignore.length > 0 ? ignore : undefined,
            include: include.length > 0 ? include : undefined,
            plugins: config?.plugins as string[] | undefined,
        };
    } catch {
        return { exists: false };
    }
}

/** Check DB existence and size. */
function scanDb(repoPath: string): ScanResult['db'] {
    const dbPath = path.join(repoPath, '.brainbank', 'data', 'brainbank.db');
    if (!fs.existsSync(dbPath)) return { exists: false, sizeMB: 0 };

    try {
        const stat = fs.statSync(dbPath);
        return {
            exists: true,
            sizeMB: Math.round(stat.size / 1024 / 1024 * 10) / 10,
            lastModified: stat.mtime,
        };
    } catch {
        return { exists: false, sizeMB: 0 };
    }
}


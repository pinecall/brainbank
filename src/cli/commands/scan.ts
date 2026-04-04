/**
 * brainbank scan — Lightweight repo scanner for the interactive index flow.
 *
 * Scans the filesystem WITHOUT initializing BrainBank. Returns a ScanResult
 * describing what's available to index via dynamic ScanModule descriptors.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
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
    config: { exists: boolean; ignore?: string[]; plugins?: string[] };
    db: { exists: boolean; sizeMB: number; lastModified?: Date } | null;
    gitSubdirs: { name: string }[];
}


/** Scan a repo path and return what's available to index. */
export function scanRepo(repoPath: string): ScanResult {
    const resolved = path.resolve(repoPath);
    const gitSubdirs = scanGitSubdirs(resolved);

    return {
        repoPath: resolved,
        modules: scanModules(resolved, gitSubdirs),
        config: scanConfig(resolved),
        db: scanDb(resolved),
        gitSubdirs,
    };
}

/** Produce ScanModule descriptors for known plugin types. */
function scanModules(repoPath: string, gitSubdirs: { name: string }[]): ScanModule[] {
    return [
        scanCodeModule(repoPath),
        scanGitModule(repoPath, gitSubdirs),
        scanDocsModule(repoPath),
    ];
}


/** Scan for indexable code files. */
function scanCodeModule(repoPath: string): ScanModule {
    const byLanguage = new Map<string, number>();
    let total = 0;

    function walk(dir: string): void {
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
        catch { return; }

        for (const entry of entries) {
            if (entry.isDirectory()) {
                if (isIgnoredDir(entry.name)) continue;
                walk(path.join(dir, entry.name));
            } else if (entry.isFile()) {
                if (isIgnoredFile(entry.name)) continue;
                const ext = path.extname(entry.name).toLowerCase();
                const lang = SUPPORTED_EXTENSIONS[ext];
                if (!lang) continue;
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
function scanGitModule(repoPath: string, gitSubdirs: { name: string }[]): ScanModule {
    const stats = scanGitStats(repoPath, gitSubdirs);

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


/** Get git stats. Supports single repo and multi-repo aggregation. */
function scanGitStats(repoPath: string, gitSubdirs: { name: string }[]): { commitCount: number; lastMessage: string; lastDate: string } | null {
    if (fs.existsSync(path.join(repoPath, '.git'))) {
        return gitStats(repoPath);
    }

    if (gitSubdirs.length === 0) return null;

    let totalCommits = 0;
    let latestMessage = '';
    let latestDate = '';

    for (const sub of gitSubdirs) {
        const stats = gitStats(path.join(repoPath, sub.name));
        if (stats) {
            totalCommits += stats.commitCount;
            if (!latestMessage) {
                latestMessage = stats.lastMessage;
                latestDate = stats.lastDate;
            }
        }
    }

    return totalCommits > 0
        ? { commitCount: totalCommits, lastMessage: latestMessage, lastDate: latestDate }
        : null;
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
            if (e.isDirectory()) {
                if (isIgnoredDir(e.name)) continue;
                count += countDocs(path.join(dir, e.name));
            } else if (e.isFile() && /\.mdx?$/i.test(e.name)) {
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
        return {
            exists: true,
            ignore: codeCfg?.ignore as string[] | undefined,
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

/** Detect subdirectories with their own .git (mono-repo). Respects `repos` whitelist from config. */
function scanGitSubdirs(repoPath: string): ScanResult['gitSubdirs'] {
    if (fs.existsSync(path.join(repoPath, '.git'))) return [];

    try {
        let subdirs = fs.readdirSync(repoPath, { withFileTypes: true })
            .filter(e => e.isDirectory() && !e.name.startsWith('.'))
            .filter(e => fs.existsSync(path.join(repoPath, e.name, '.git')))
            .map(e => ({ name: e.name }));

        // Apply repos whitelist from config if present
        const configRepos = readReposFromConfig(repoPath);
        if (configRepos) {
            subdirs = subdirs.filter(s => configRepos.includes(s.name));
        }

        return subdirs;
    } catch {
        return [];
    }
}

/** Read the `repos` whitelist from .brainbank/config.json. Returns null if not set. */
function readReposFromConfig(repoPath: string): string[] | null {
    const configPath = path.join(repoPath, '.brainbank', 'config.json');
    try {
        if (!fs.existsSync(configPath)) return null;
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
        const repos = config.repos;
        if (Array.isArray(repos) && repos.every(r => typeof r === 'string')) {
            return repos as string[];
        }
        return null;
    } catch {
        return null;
    }
}

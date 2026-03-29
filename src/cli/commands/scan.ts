/**
 * brainbank scan — Lightweight repo scanner for the interactive index flow.
 *
 * Scans the filesystem WITHOUT initializing BrainBank. Returns a ScanResult
 * describing what's available to index (code files, git history, docs, config).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { SUPPORTED_EXTENSIONS, isIgnoredDir, isIgnoredFile } from '@/lib/languages.ts';

// ── Types ───────────────────────────────────────────

export interface ScanResult {
    repoPath: string;
    code: { total: number; byLanguage: Map<string, number> };
    git: { commitCount: number; lastMessage: string; lastDate: string } | null;
    docs: { name: string; path: string; fileCount: number }[];
    config: { exists: boolean; ignore?: string[]; plugins?: string[] };
    db: { exists: boolean; sizeMB: number; lastModified?: Date } | null;
    gitSubdirs: { name: string }[];
}

// ── Scanner ─────────────────────────────────────────

/** Scan a repo path and return what's available to index. */
export function scanRepo(repoPath: string): ScanResult {
    const resolved = path.resolve(repoPath);

    return {
        repoPath: resolved,
        code: scanCode(resolved),
        git: scanGit(resolved),
        docs: scanDocs(resolved),
        config: scanConfig(resolved),
        db: scanDb(resolved),
        gitSubdirs: scanGitSubdirs(resolved),
    };
}

/** Walk the repo and count source files by language. */
function scanCode(repoPath: string): ScanResult['code'] {
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
    return { total, byLanguage };
}

/** Check for git repo and get basic stats. Supports multi-repo. */
function scanGit(repoPath: string): ScanResult['git'] {
    // Single repo: .git at root
    if (fs.existsSync(path.join(repoPath, '.git'))) {
        return gitStats(repoPath);
    }

    // Multi-repo: aggregate from subdirectories with .git
    const subdirs = scanGitSubdirs(repoPath);
    if (subdirs.length === 0) return null;

    let totalCommits = 0;
    let latestMessage = '';
    let latestDate = '';

    for (const sub of subdirs) {
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
function gitStats(dir: string): ScanResult['git'] {
    try {
        const count = parseInt(execSync('git rev-list --count HEAD', { cwd: dir, encoding: 'utf-8' }).trim(), 10);
        const log = execSync('git log -1 --format="%s|%ar"', { cwd: dir, encoding: 'utf-8' }).trim();
        const [lastMessage, lastDate] = log.split('|');
        return { commitCount: count, lastMessage: lastMessage ?? '', lastDate: lastDate ?? '' };
    } catch {
        return null;
    }
}

/** Scan for documents: filesystem .md/.mdx files + config.json collections. */
function scanDocs(repoPath: string): ScanResult['docs'] {
    const results: ScanResult['docs'] = [];
    const seen = new Set<string>();

    // 1. Read explicit collections from config.json
    const configPath = path.join(repoPath, '.brainbank', 'config.json');
    try {
        if (fs.existsSync(configPath)) {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            const collections = config?.docs?.collections as { name: string; path: string }[] | undefined;
            if (collections) {
                for (const coll of collections) {
                    const absPath = path.resolve(repoPath, coll.path);
                    results.push({ name: coll.name, path: coll.path, fileCount: countDocs(absPath) });
                    seen.add(path.resolve(repoPath, coll.path));
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
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        return {
            exists: true,
            ignore: config?.code?.ignore as string[] | undefined,
            plugins: config?.plugins as string[] | undefined,
        };
    } catch {
        return { exists: false };
    }
}

/** Check DB existence and size. */
function scanDb(repoPath: string): ScanResult['db'] {
    const dbPath = path.join(repoPath, '.brainbank', 'brainbank.db');
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

/** Detect subdirectories with their own .git (mono-repo). */
function scanGitSubdirs(repoPath: string): ScanResult['gitSubdirs'] {
    if (fs.existsSync(path.join(repoPath, '.git'))) return [];

    try {
        return fs.readdirSync(repoPath, { withFileTypes: true })
            .filter(e => e.isDirectory() && !e.name.startsWith('.'))
            .filter(e => fs.existsSync(path.join(repoPath, e.name, '.git')))
            .map(e => ({ name: e.name }));
    } catch {
        return [];
    }
}

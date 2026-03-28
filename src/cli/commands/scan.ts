/**
 * brainbank scan — Lightweight repo scanner for the interactive index flow.
 *
 * Scans the filesystem WITHOUT initializing BrainBank. Returns a ScanResult
 * describing what's available to index (code files, git history, docs, config).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { SUPPORTED_EXTENSIONS, isIgnoredDir, isIgnoredFile } from '@/indexers/languages.ts';

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

/** Check for git repo and get basic stats. */
function scanGit(repoPath: string): ScanResult['git'] {
    if (!fs.existsSync(path.join(repoPath, '.git'))) return null;

    try {
        const count = parseInt(execSync('git rev-list --count HEAD', { cwd: repoPath, encoding: 'utf-8' }).trim(), 10);
        const log = execSync('git log -1 --format="%s|%ar"', { cwd: repoPath, encoding: 'utf-8' }).trim();
        const [lastMessage, lastDate] = log.split('|');
        return { commitCount: count, lastMessage: lastMessage ?? '', lastDate: lastDate ?? '' };
    } catch {
        return { commitCount: 0, lastMessage: '', lastDate: '' };
    }
}

/** Read config.json docs collections and count files. */
function scanDocs(repoPath: string): ScanResult['docs'] {
    const configPath = path.join(repoPath, '.brainbank', 'config.json');
    if (!fs.existsSync(configPath)) return [];

    try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        const collections = config?.docs?.collections as { name: string; path: string; pattern?: string }[] | undefined;
        if (!collections) return [];

        return collections.map(coll => {
            const absPath = path.resolve(repoPath, coll.path);
            let fileCount = 0;
            try {
                const walk = (dir: string) => {
                    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                        if (e.isDirectory()) walk(path.join(dir, e.name));
                        else if (e.isFile() && /\.mdx?$/i.test(e.name)) fileCount++;
                    }
                };
                if (fs.existsSync(absPath)) walk(absPath);
            } catch {}
            return { name: coll.name, path: coll.path, fileCount };
        });
    } catch {
        return [];
    }
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

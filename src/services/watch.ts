/**
 * BrainBank — Watch Mode
 * 
 * Auto-indexes on file changes using fs.watch.
 * Works with built-in indexers (code, git, docs) and custom indexers.
 * 
 * Built-in behavior:
 *   - Code files → re-indexes changed file
 *   - Doc files  → re-indexes changed collection
 * 
 * Custom indexers:
 *   - Implement `onFileChange(path, event)` to handle changes
 *   - Implement `watchPatterns()` to specify which files to watch
 * 
 * Usage:
 *   const watcher = brain.watch({ paths: ['.'] });
 *   watcher.close(); // stop watching
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { isSupported, isIgnoredDir, isIgnoredFile } from '../indexers/languages.ts';
import type { Indexer } from '../indexers/base.ts';

// ── Types ───────────────────────────────────────────

export interface WatchOptions {
    /** Paths to watch. Default: [config.repoPath] */
    paths?: string[];
    /** Debounce interval in ms. Default: 2000 */
    debounceMs?: number;
    /** Called when a file is re-indexed. */
    onIndex?: (filePath: string, indexer: string) => void;
    /** Called on errors. */
    onError?: (error: Error) => void;
}

export interface Watcher {
    /** Stop watching. */
    close(): void;
    /** Whether the watcher is active. */
    readonly active: boolean;
}

// ── Watch Engine ────────────────────────────────────

/**
 * Create a file watcher that auto-re-indexes on changes.
 * 
 * @param reindexFn  — called to re-index code+git (brain.index())
 * @param indexers   — registered indexers (for custom onFileChange hooks)
 * @param repoPath   — base repo path (for resolving relative paths)
 * @param options    — watch configuration
 */
export function createWatcher(
    reindexFn: () => Promise<void>,
    indexers: Map<string, Indexer>,
    repoPath: string,
    options: WatchOptions = {},
): Watcher {
    const {
        paths = [repoPath],
        debounceMs = 2000,
        onIndex,
        onError,
    } = options;

    let active = true;
    const watchers: fs.FSWatcher[] = [];
    const pending = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | null = null;

    // Collect custom watch patterns from indexers
    const customPatterns: { indexer: Indexer; patterns: string[] }[] = [];
    for (const indexer of indexers.values()) {
        if (indexer.watchPatterns) {
            customPatterns.push({ indexer, patterns: indexer.watchPatterns() });
        }
    }

    // Check if a file matches any custom indexer pattern
    function matchCustomIndexer(filePath: string): Indexer | null {
        const rel = path.relative(repoPath, filePath);
        for (const { indexer, patterns } of customPatterns) {
            for (const pattern of patterns) {
                if (matchGlob(rel, pattern)) return indexer;
            }
        }
        return null;
    }

    // Simple glob matching (supports **, *, and extension matching)
    function matchGlob(filePath: string, pattern: string): boolean {
        // **/*.ext → match any file with that extension
        if (pattern.startsWith('**/')) {
            const suffix = pattern.slice(3); // e.g. "*.csv"
            const ext = suffix.startsWith('*.') ? suffix.slice(1) : null; // e.g. ".csv"
            if (ext) return filePath.endsWith(ext);
            return path.basename(filePath) === suffix;
        }
        // *.ext → match extension in any directory
        if (pattern.startsWith('*.')) {
            return filePath.endsWith(pattern.slice(1));
        }
        return filePath === pattern;
    }

    // Process pending file changes
    async function flush() {
        if (pending.size === 0) return;

        const files = [...pending];
        pending.clear();

        // Group by handler
        let needsReindex = false;

        for (const filePath of files) {
            const absPath = path.resolve(repoPath, filePath);

            // Try custom indexers first
            const customIndexer = matchCustomIndexer(absPath);
            if (customIndexer?.onFileChange) {
                try {
                    const handled = await customIndexer.onFileChange(absPath, detectEvent(absPath));
                    if (handled) {
                        onIndex?.(filePath, customIndexer.name);
                        continue;
                    }
                } catch (err) {
                    onError?.(err instanceof Error ? err : new Error(String(err)));
                }
            }

            // Fall back to built-in re-index for supported code files
            if (isSupported(filePath)) {
                needsReindex = true;
                onIndex?.(filePath, 'code');
            }
        }

        // Batch re-index if any code files changed
        if (needsReindex) {
            try {
                await reindexFn();
            } catch (err) {
                onError?.(err instanceof Error ? err : new Error(String(err)));
            }
        }
    }

    function detectEvent(filePath: string): 'create' | 'update' | 'delete' {
        try {
            fs.accessSync(filePath);
            return 'update';
        } catch {
            return 'delete';
        }
    }

    // Should we watch this file?
    function shouldWatch(filename: string): boolean {
        if (!filename) return false;
        const parts = filename.split(path.sep);

        // Skip ignored directories
        for (const part of parts) {
            if (isIgnoredDir(part)) return false;
        }

        // Skip ignored files
        if (isIgnoredFile(path.basename(filename))) return false;

        // Accept supported code files
        if (isSupported(filename)) return true;

        // Accept files matching custom indexer patterns
        if (matchCustomIndexer(path.resolve(repoPath, filename))) return true;

        return false;
    }

    // Set up watchers
    for (const watchPath of paths) {
        const resolved = path.resolve(watchPath);
        try {
            // { recursive: true } only works on macOS + Windows; Linux needs chokidar or per-dir watchers
            const supportsRecursive = process.platform === 'darwin' || process.platform === 'win32';
            const watcher = fs.watch(resolved, { recursive: supportsRecursive }, (_event, filename) => {
                if (!active || !filename) return;
                if (!shouldWatch(filename)) return;

                pending.add(filename);

                // Debounce
                if (timer) clearTimeout(timer);
                timer = setTimeout(() => flush(), debounceMs);
            });

            watcher.on('error', (err) => {
                onError?.(err instanceof Error ? err : new Error(String(err)));
            });

            watchers.push(watcher);
        } catch (err) {
            onError?.(err instanceof Error ? err : new Error(String(err)));
        }
    }

    return {
        close() {
            active = false;
            if (timer) clearTimeout(timer);
            for (const w of watchers) w.close();
            watchers.length = 0;
        },
        get active() { return active; },
    };
}

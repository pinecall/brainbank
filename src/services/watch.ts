/**
 * BrainBank — Watcher
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
import { isSupported, isIgnoredDir, isIgnoredFile } from '@/lib/languages.ts';
import type { Plugin } from '@/plugin.ts';
import { isWatchable } from '@/plugin.ts';

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

// ── Watcher Class ───────────────────────────────────

/** File watcher that auto-re-indexes on changes. */
export class Watcher {
    private _active = true;
    private _watchers: fs.FSWatcher[] = [];
    private _pending = new Set<string>();
    private _timer: ReturnType<typeof setTimeout> | null = null;
    private _flushing = false;
    private _customPatterns: { indexer: Plugin; patterns: string[] }[] = [];

    constructor(
        private _reindexFn: () => Promise<void>,
        private _indexers: Map<string, Plugin>,
        private _repoPath: string,
        private _options: WatchOptions = {},
    ) {
        this._collectCustomPatterns();
        this._startWatching();
    }

    /** Whether the watcher is active. */
    get active(): boolean { return this._active; }

    /** Stop watching. */
    close(): void {
        this._active = false;
        if (this._timer) clearTimeout(this._timer);
        for (const w of this._watchers) w.close();
        this._watchers.length = 0;
    }

    // ── Private ─────────────────────────────────────

    /** Collect custom watch patterns from indexers. */
    private _collectCustomPatterns(): void {
        for (const indexer of this._indexers.values()) {
            if (isWatchable(indexer)) {
                this._customPatterns.push({
                    indexer,
                    patterns: indexer.watchPatterns(),
                });
            }
        }
    }

    /** Check if a file matches any custom indexer pattern. */
    private _matchCustomPlugin(filePath: string): Plugin | null {
        const rel = path.relative(this._repoPath, filePath);
        for (const { indexer, patterns } of this._customPatterns) {
            for (const pattern of patterns) {
                if (this._matchGlob(rel, pattern)) return indexer;
            }
        }
        return null;
    }

    /** Simple glob matching (supports **, *, and extension matching). */
    private _matchGlob(filePath: string, pattern: string): boolean {
        if (pattern.startsWith('**/')) {
            const suffix = pattern.slice(3);
            const ext = suffix.startsWith('*.') ? suffix.slice(1) : null;
            if (ext) return filePath.endsWith(ext);
            return path.basename(filePath) === suffix;
        }
        if (pattern.startsWith('*.')) {
            return filePath.endsWith(pattern.slice(1));
        }
        return filePath === pattern;
    }

    /** Process pending file changes (serialized — no concurrent flushes). */
    private async _processPending(): Promise<void> {
        if (this._flushing || this._pending.size === 0) return;
        this._flushing = true;

        const { onIndex, onError, debounceMs = 2000 } = this._options;

        try {
            const files = [...this._pending];
            this._pending.clear();

            let needsReindex = false;
            const codeFiles: string[] = [];

            for (const filePath of files) {
                const absPath = path.resolve(this._repoPath, filePath);

                const customIndexer = this._matchCustomPlugin(absPath);
                if (customIndexer && isWatchable(customIndexer)) {
                    try {
                        const handled = await customIndexer.onFileChange(absPath, this._detectEvent(absPath));
                        if (handled) {
                            onIndex?.(filePath, customIndexer.name);
                            continue;
                        }
                    } catch (err) {
                        onError?.(err instanceof Error ? err : new Error(String(err)));
                    }
                }

                if (isSupported(filePath)) {
                    needsReindex = true;
                    codeFiles.push(filePath);
                    onIndex?.(filePath, 'code');
                }
            }

            if (needsReindex) {
                try {
                    await this._reindexFn();
                } catch (err) {
                    // Re-queue code files so they retry on the next debounce
                    for (const f of codeFiles) this._pending.add(f);
                    onError?.(err instanceof Error ? err : new Error(String(err)));
                }
            }
        } finally {
            this._flushing = false;
            if (this._pending.size > 0) {
                this._timer = setTimeout(() => this._processPending(), debounceMs);
            }
        }
    }

    /** Detect whether a file still exists (update vs delete). */
    private _detectEvent(filePath: string): 'create' | 'update' | 'delete' {
        try {
            fs.accessSync(filePath);
            return 'update';
        } catch {
            return 'delete';
        }
    }

    /** Determine if a file should trigger re-indexing. */
    private _shouldWatch(filename: string): boolean {
        if (!filename) return false;
        const parts = filename.split(path.sep);

        for (const part of parts) {
            if (isIgnoredDir(part)) return false;
        }
        if (isIgnoredFile(path.basename(filename))) return false;
        if (isSupported(filename)) return true;
        if (this._matchCustomPlugin(path.resolve(this._repoPath, filename))) return true;

        return false;
    }

    /** Set up file system watchers. */
    private _startWatching(): void {
        const {
            paths = [this._repoPath],
            debounceMs = 2000,
            onError,
        } = this._options;

        for (const watchPath of paths) {
            const resolved = path.resolve(watchPath);
            try {
                const supportsRecursive = process.platform === 'darwin' || process.platform === 'win32';
                const watcher = fs.watch(resolved, { recursive: supportsRecursive }, (_event, filename) => {
                    if (!this._active || !filename) return;
                    if (!this._shouldWatch(filename)) return;

                    this._pending.add(filename);

                    if (this._timer) clearTimeout(this._timer);
                    this._timer = setTimeout(() => this._processPending(), debounceMs);
                });

                watcher.on('error', (err) => {
                    onError?.(err instanceof Error ? err : new Error(String(err)));
                });

                this._watchers.push(watcher);
            } catch (err) {
                onError?.(err instanceof Error ? err : new Error(String(err)));
            }
        }
    }
}

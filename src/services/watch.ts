/**
 * BrainBank — Watcher
 *
 * Thin coordinator for plugin-driven watching. Each plugin CAN drive its own
 * watching via WatchablePlugin.watch(). For IndexablePlugins that don't
 * implement WatchablePlugin, the Watcher provides a single shared fs.watch
 * tree with fan-out routing so each plugin only receives relevant events.
 *
 * Responsibilities:
 *   1. Call `plugin.watch(onEvent)` for each WatchablePlugin
 *   2. For IndexablePlugins without watch(), share one recursive fs.watch tree
 *   3. Route events to the correct plugin based on sub-repo scope
 *   4. Dedup macOS double-fire events (change+rename per save)
 *   5. Apply per-plugin debounce from `plugin.watchConfig()`
 *   6. On event: call `plugin.indexItems([id])` or `plugin.index()` for re-indexing
 *   7. Call `handle.stop()` on `close()`
 *
 *   const watcher = brain.watch({ debounceMs: 2000 });
 *   watcher.close(); // stop watching
 */

import type { Plugin } from '@/plugin.ts';
import type { WatchEvent, WatchHandle } from '@/types.ts';

import * as fs from 'node:fs';
import * as path from 'node:path';
import { isIndexable, isWatchable } from '@/plugin.ts';
import { isSupported, isIgnoredDir, matchesGlob } from '@/lib/languages.ts';

/** Doc file extensions that the docs plugin indexes. */
const DOC_EXTENSIONS = new Set(['.md', '.mdx', '.txt', '.rst']);


export interface WatchOptions {
    /** Default debounce for plugins that don't specify watchConfig. Default: 2000 */
    debounceMs?: number;
    /** Glob patterns to ignore (from config.json code.ignore). */
    ignore?: string[];
    /** Called when a source triggers re-indexing. */
    onIndex?: (sourceId: string, pluginName: string) => void;
    /** Called on errors. */
    onError?: (error: Error) => void;
}


/** Pending event batch for a single plugin. */
interface PluginBatch {
    plugin: Plugin;
    handle: WatchHandle;
    events: WatchEvent[];
    timer: ReturnType<typeof setTimeout> | null;
    flushing: boolean;
}


/** Plugin-driven watcher that coordinates re-indexing across all WatchablePlugins. */
export class Watcher {
    private _active = true;
    private _batches = new Map<string, PluginBatch>();
    private _reindexFn: () => Promise<void>;
    private _options: WatchOptions;
    private _keepalive: ReturnType<typeof setInterval> | null = null;

    constructor(
        reindexFn: () => Promise<void>,
        plugins: Plugin[],
        options: WatchOptions = {},
        repoPath?: string,
    ) {
        this._reindexFn = reindexFn;
        this._options = options;
        this._startWatching(plugins, repoPath);
    }

    /** Whether the watcher is active. */
    get active(): boolean { return this._active; }

    /** Stop all plugin watchers. */
    async close(): Promise<void> {
        this._active = false;

        if (this._keepalive) {
            clearInterval(this._keepalive);
            this._keepalive = null;
        }

        for (const batch of this._batches.values()) {
            if (batch.timer) clearTimeout(batch.timer);
            try {
                await batch.handle.stop();
            } catch (err) {
                this._options.onError?.(err instanceof Error ? err : new Error(String(err)));
            }
        }
        this._batches.clear();
    }


    /** Start watching for each WatchablePlugin, with shared fs.watch fallback. */
    private _startWatching(plugins: Plugin[], repoPath?: string): void {
        let hasAnyWatcher = false;
        const fallbackPlugins: Plugin[] = [];

        for (const plugin of plugins) {
            if (isWatchable(plugin)) {
                // Plugin-driven watching
                try {
                    const handle = plugin.watch((event) => this._onEvent(plugin, event));

                    this._batches.set(plugin.name, {
                        plugin,
                        handle,
                        events: [],
                        timer: null,
                        flushing: false,
                    });
                    hasAnyWatcher = true;
                } catch (err) {
                    this._options.onError?.(err instanceof Error ? err : new Error(String(err)));
                }
            } else if (isIndexable(plugin) && repoPath) {
                // Collect for shared fs.watch fallback
                fallbackPlugins.push(plugin);
            }
        }

        // Create a SINGLE shared fs.watch tree for all fallback plugins
        if (fallbackPlugins.length > 0 && repoPath) {
            const sharedHandle = this._startSharedFsWatch(fallbackPlugins, repoPath);
            if (sharedHandle) {
                // Register batches for each fallback plugin with the shared handle
                for (const plugin of fallbackPlugins) {
                    this._batches.set(plugin.name, {
                        plugin,
                        handle: sharedHandle,
                        events: [],
                        timer: null,
                        flushing: false,
                    });
                }
                hasAnyWatcher = true;
            }
        }

        // Keep the Node event loop alive even if no native watchers are active
        if (hasAnyWatcher) {
            this._keepalive = setInterval(() => {}, 60_000);
            this._keepalive.unref?.(); // allow graceful exit on SIGINT
        }
    }


    /**
     * Single shared recursive fs.watch that fans out events to multiple plugins.
     * Each event is routed based on file extension (docs → .md only, code → isSupported).
     */
    private _startSharedFsWatch(plugins: Plugin[], repoPath: string): WatchHandle | null {
        const watchers: fs.FSWatcher[] = [];
        const ignorePatterns = this._options.ignore ?? [];

        // Dedup: macOS fs.watch fires both 'change' + 'rename' for a single save.
        const recentEvents = new Map<string, number>();
        const DEDUP_MS = 100;

        // Pre-compute routing info per plugin
        const routes = plugins.map(plugin => {
            return { plugin, baseName: plugin.name };
        });

        const watchDir = (dir: string): void => {
            try {
                const watcher = fs.watch(dir, { persistent: true }, (_eventType, filename) => {
                    if (!filename || !this._active) return;
                    const fullPath = path.join(dir, filename);
                    const relPath = path.relative(repoPath, fullPath);
                    const ext = path.extname(fullPath).toLowerCase();

                    // Config ignore: skip files matching user-defined glob patterns
                    if (ignorePatterns.length > 0 && matchesGlob(relPath, ignorePatterns)) return;

                    // Dedup: skip if we already saw this file within DEDUP_MS
                    const now = Date.now();
                    const lastSeen = recentEvents.get(relPath);
                    if (lastSeen && now - lastSeen < DEDUP_MS) return;
                    recentEvents.set(relPath, now);

                    const event: WatchEvent = {
                        type: 'update',
                        sourceId: relPath,
                        sourceName: 'file',
                    };

                    // Fan out to matching plugins
                    for (const { plugin, baseName } of routes) {
                        // Extension-based routing
                        if (baseName === 'docs') {
                            // Docs plugin only cares about doc files
                            if (!DOC_EXTENSIONS.has(ext)) continue;
                        } else {
                            // Code/git plugins only care about supported source files
                            if (!isSupported(fullPath)) continue;
                        }

                        this._onEvent(plugin, event);
                    }
                });

                watcher.on('error', (err) => {
                    this._options.onError?.(err instanceof Error ? err : new Error(String(err)));
                });

                watchers.push(watcher);
            } catch {
                // Directory might not exist or be inaccessible — skip
            }

            // Recurse into subdirectories
            try {
                for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                    if (!entry.isDirectory()) continue;
                    if (isIgnoredDir(entry.name)) continue;
                    if (entry.name.startsWith('.')) continue;
                    // Skip directories matching config ignore patterns
                    const dirRel = path.relative(repoPath, path.join(dir, entry.name));
                    if (ignorePatterns.length > 0 && matchesGlob(dirRel + '/', ignorePatterns)) continue;
                    watchDir(path.join(dir, entry.name));
                }
            } catch {
                // Directory read failed — skip
            }
        };

        watchDir(repoPath);

        if (watchers.length === 0) return null;

        // Periodically clean up stale dedup entries to prevent memory leak
        const cleanupInterval = setInterval(() => {
            const cutoff = Date.now() - 10_000;
            for (const [key, ts] of recentEvents) {
                if (ts < cutoff) recentEvents.delete(key);
            }
        }, 30_000);
        cleanupInterval.unref?.();

        let stopped = false;
        return {
            get active() { return !stopped; },
            async stop() {
                if (stopped) return;
                stopped = true;
                clearInterval(cleanupInterval);
                for (const w of watchers) {
                    try { w.close(); } catch { /* safe to ignore */ }
                }
                watchers.length = 0;
            },
        };
    }


    /** Handle an incoming event from a plugin. */
    private _onEvent(plugin: Plugin, event: WatchEvent): void {
        if (!this._active) return;

        const batch = this._batches.get(plugin.name);
        if (!batch) return;

        batch.events.push(event);

        // Resolve debounce: plugin config > global options > 2000ms default
        const pluginDebounce = isWatchable(plugin)
            ? plugin.watchConfig?.()?.debounceMs
            : undefined;
        const debounceMs = pluginDebounce ?? this._options.debounceMs ?? 2000;

        // Check batch size limit
        const batchSize = isWatchable(plugin)
            ? plugin.watchConfig?.()?.batchSize
            : undefined;

        const shouldFlushNow = debounceMs === 0
            || (batchSize !== undefined && batch.events.length >= batchSize);

        if (shouldFlushNow) {
            if (batch.timer) clearTimeout(batch.timer);
            batch.timer = null;
            void this._flush(batch);
            return;
        }

        // Debounce: reset timer on each new event
        if (batch.timer) clearTimeout(batch.timer);
        batch.timer = setTimeout(() => void this._flush(batch), debounceMs);
    }

    /** Flush pending events for a plugin — trigger re-indexing. */
    private async _flush(batch: PluginBatch): Promise<void> {
        if (batch.flushing || batch.events.length === 0) return;
        batch.flushing = true;

        const { onIndex, onError } = this._options;

        try {
            const events = [...batch.events];
            batch.events.length = 0;

            const ids = events.map(e => e.sourceId);

            // Try granular re-index first, fall back to full re-index
            if (isIndexable(batch.plugin) && batch.plugin.indexItems) {
                await batch.plugin.indexItems(ids);
                for (const id of ids) {
                    onIndex?.(id, batch.plugin.name);
                }
            } else if (isIndexable(batch.plugin)) {
                await batch.plugin.index();
                for (const id of ids) {
                    onIndex?.(id, batch.plugin.name);
                }
            } else {
                // Plugin is watchable but not indexable — use global re-index
                await this._reindexFn();
                for (const id of ids) {
                    onIndex?.(id, batch.plugin.name);
                }
            }
        } catch (err) {
            onError?.(err instanceof Error ? err : new Error(String(err)));
        } finally {
            batch.flushing = false;

            // If new events arrived during flush, schedule another flush
            if (batch.events.length > 0 && this._active) {
                const debounceMs = this._options.debounceMs ?? 2000;
                batch.timer = setTimeout(() => void this._flush(batch), debounceMs);
            }
        }
    }
}

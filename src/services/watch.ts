/**
 * BrainBank — Watcher
 *
 * Thin coordinator for plugin-driven watching. The core does NOT do fs.watch
 * or know about file patterns — each plugin drives its own watching.
 *
 * Responsibilities:
 *   1. Call `plugin.watch(onEvent)` for each WatchablePlugin
 *   2. Collect the WatchHandle instances returned
 *   3. Apply per-plugin debounce from `plugin.watchConfig()`
 *   4. On event: call `plugin.indexItems([id])` or `plugin.index()` for re-indexing
 *   5. Call `handle.stop()` on `close()`
 *
 *   const watcher = brain.watch({ debounceMs: 2000 });
 *   watcher.close(); // stop watching
 */

import type { Plugin } from '@/plugin.ts';
import type { WatchEvent, WatchHandle } from '@/types.ts';

import { isIndexable, isWatchable } from '@/plugin.ts';


export interface WatchOptions {
    /** Default debounce for plugins that don't specify watchConfig. Default: 2000 */
    debounceMs?: number;
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

    constructor(
        reindexFn: () => Promise<void>,
        plugins: Plugin[],
        options: WatchOptions = {},
    ) {
        this._reindexFn = reindexFn;
        this._options = options;
        this._startWatching(plugins);
    }

    /** Whether the watcher is active. */
    get active(): boolean { return this._active; }

    /** Stop all plugin watchers. */
    async close(): Promise<void> {
        this._active = false;

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


    /** Start watching for each WatchablePlugin. */
    private _startWatching(plugins: Plugin[]): void {
        for (const plugin of plugins) {
            if (!isWatchable(plugin)) continue;

            try {
                const handle = plugin.watch((event) => this._onEvent(plugin, event));

                this._batches.set(plugin.name, {
                    plugin,
                    handle,
                    events: [],
                    timer: null,
                    flushing: false,
                });
            } catch (err) {
                // One plugin failing to start doesn't block others
                this._options.onError?.(err instanceof Error ? err : new Error(String(err)));
            }
        }
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

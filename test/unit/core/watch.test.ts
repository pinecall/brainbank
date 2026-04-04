/**
 * BrainBank — Watch Mode Tests
 *
 * Tests the plugin-driven Watcher:
 * - Plugin watch() is called for each WatchablePlugin
 * - onEvent triggers plugin re-indexing (index or indexItems)
 * - Per-plugin debounce from watchConfig()
 * - close() stops all handles
 * - onIndex callback receives (sourceId, pluginName)
 * - Error in one plugin doesn't crash others
 * - Debounce batches multiple rapid events
 */

import { Watcher } from '../../../src/services/watch.ts';
import { matchesGlob } from '../../../src/lib/languages.ts';
import type { Plugin, WatchablePlugin, IndexablePlugin } from '../../../src/plugin.ts';
import type { WatchEvent, WatchEventHandler, WatchHandle, WatchConfig } from '../../../src/types.ts';

export const name = 'Watch Mode';

/** Wait for a condition to be true, with timeout. */
function waitFor(conditionFn: () => boolean, timeoutMs = 5000, intervalMs = 50): Promise<boolean> {
    return new Promise((resolve) => {
        const start = Date.now();
        const check = () => {
            if (conditionFn()) return resolve(true);
            if (Date.now() - start > timeoutMs) return resolve(false);
            setTimeout(check, intervalMs);
        };
        check();
    });
}

/** Helper: create a minimal WatchablePlugin that fires events via its stored handler. */
function createWatchablePlugin(
    pluginName: string,
    opts: {
        watchConfig?: WatchConfig;
        indexFn?: () => Promise<{ indexed: number; skipped: number }>;
        indexItemsFn?: (ids: string[]) => Promise<{ indexed: number; skipped: number }>;
        watchThrows?: boolean;
    } = {},
): WatchablePlugin & IndexablePlugin & { _fire: (event: WatchEvent) => void; _handle: { active: boolean } } {
    let storedHandler: WatchEventHandler | null = null;
    const handle = { active: true };

    return {
        name: pluginName,
        async initialize() {},
        _fire(event: WatchEvent) { storedHandler?.(event); },
        _handle: handle,

        watch(onEvent: WatchEventHandler): WatchHandle {
            if (opts.watchThrows) throw new Error(`Plugin ${pluginName} failed to start`);
            storedHandler = onEvent;
            return {
                async stop() { handle.active = false; storedHandler = null; },
                get active() { return handle.active; },
            };
        },
        watchConfig() { return opts.watchConfig ?? {}; },

        async index() {
            if (opts.indexFn) return opts.indexFn();
            return { indexed: 1, skipped: 0 };
        },
        indexItems: opts.indexItemsFn
            ? async (ids: string[]) => opts.indexItemsFn!(ids)
            : undefined,
    };
}


export const tests = {
    async 'plugin watch() is called for each WatchablePlugin'(assert: { (cond: unknown, msg?: string): void; equal: (a: unknown, b: unknown, msg?: string) => void }) {
        let watchCalled = false;
        const plugin = createWatchablePlugin('test-plugin');

        // Wrap to detect the call
        const origWatch = plugin.watch.bind(plugin);
        plugin.watch = (onEvent: WatchEventHandler) => {
            watchCalled = true;
            return origWatch(onEvent);
        };

        const watcher = new Watcher(async () => {}, [plugin as Plugin]);
        assert(watchCalled, 'watch() should have been called on the plugin');
        await watcher.close();
    },

    async 'onEvent triggers plugin.index() for re-indexing'(assert: { (cond: unknown, msg?: string): void; equal: (a: unknown, b: unknown, msg?: string) => void }) {
        let indexCalled = 0;
        const plugin = createWatchablePlugin('code', {
            watchConfig: { debounceMs: 0 },
            indexFn: async () => { indexCalled++; return { indexed: 1, skipped: 0 }; },
        });

        const watcher = new Watcher(async () => {}, [plugin as Plugin], { debounceMs: 0 });

        plugin._fire({ type: 'update', sourceId: 'src/foo.ts', sourceName: 'file' });

        const triggered = await waitFor(() => indexCalled > 0, 2000);
        assert(triggered, 'plugin.index() should have been called');
        assert.equal(indexCalled, 1, 'index called exactly once');

        await watcher.close();
    },

    async 'indexItems called when available instead of full index'(assert: { (cond: unknown, msg?: string): void; ok: (cond: unknown, msg?: string) => void; deepEqual: (a: unknown, b: unknown, msg?: string) => void }) {
        const indexedIds: string[][] = [];
        let fullIndexCalled = false;

        const plugin = createWatchablePlugin('code', {
            watchConfig: { debounceMs: 0 },
            indexFn: async () => { fullIndexCalled = true; return { indexed: 1, skipped: 0 }; },
            indexItemsFn: async (ids) => { indexedIds.push(ids); return { indexed: ids.length, skipped: 0 }; },
        });

        const watcher = new Watcher(async () => {}, [plugin as Plugin], { debounceMs: 0 });

        plugin._fire({ type: 'update', sourceId: 'src/bar.ts', sourceName: 'file' });

        const triggered = await waitFor(() => indexedIds.length > 0, 2000);
        assert.ok(triggered, 'indexItems should have been called');
        assert.deepEqual(indexedIds[0], ['src/bar.ts'], 'should receive the sourceId');
        assert(!fullIndexCalled, 'full index() should NOT have been called');

        await watcher.close();
    },

    async 'per-plugin debounce batches events'(assert: { (cond: unknown, msg?: string): void; equal: (a: unknown, b: unknown, msg?: string) => void }) {
        let indexCallCount = 0;
        const plugin = createWatchablePlugin('code', {
            watchConfig: { debounceMs: 300 },
            indexFn: async () => { indexCallCount++; return { indexed: 1, skipped: 0 }; },
        });

        const watcher = new Watcher(async () => {}, [plugin as Plugin]);

        // Fire 5 rapid events — should batch into 1 flush
        for (let i = 0; i < 5; i++) {
            plugin._fire({ type: 'update', sourceId: `file${i}.ts`, sourceName: 'file' });
        }

        const triggered = await waitFor(() => indexCallCount > 0, 2000);
        assert(triggered, 'index should have been called');
        assert.equal(indexCallCount, 1, `should batch into 1 call (got ${indexCallCount})`);

        await watcher.close();
    },

    async 'close() stops all handles and sets active=false'(assert: { (cond: unknown, msg?: string): void }) {
        const plugin = createWatchablePlugin('code');

        const watcher = new Watcher(async () => {}, [plugin as Plugin]);
        assert(watcher.active, 'watcher should be active initially');

        await watcher.close();
        assert(!watcher.active, 'watcher should not be active after close');
        assert(!plugin._handle.active, 'plugin handle should not be active after close');
    },

    async 'onIndex callback receives sourceId and pluginName'(assert: { (cond: unknown, msg?: string): void; equal: (a: unknown, b: unknown, msg?: string) => void }) {
        const events: { sourceId: string; pluginName: string }[] = [];
        const plugin = createWatchablePlugin('my-plugin', {
            watchConfig: { debounceMs: 0 },
        });

        const watcher = new Watcher(
            async () => {},
            [plugin as Plugin],
            {
                debounceMs: 0,
                onIndex: (sourceId, pluginName) => events.push({ sourceId, pluginName }),
            },
        );

        plugin._fire({ type: 'create', sourceId: 'pr/123', sourceName: 'github:pr' });

        const gotCallback = await waitFor(() => events.length > 0, 2000);
        assert(gotCallback, 'onIndex callback should have been called');
        assert.equal(events[0].pluginName, 'my-plugin', 'pluginName should match');
        assert.equal(events[0].sourceId, 'pr/123', 'sourceId should match');

        await watcher.close();
    },

    async 'error in one plugin watch() does not crash others'(assert: { (cond: unknown, msg?: string): void }) {
        const errors: string[] = [];

        const failingPlugin = createWatchablePlugin('failing', { watchThrows: true });
        const goodPlugin = createWatchablePlugin('good');

        const watcher = new Watcher(
            async () => {},
            [failingPlugin as Plugin, goodPlugin as Plugin],
            { onError: (err) => errors.push(err.message) },
        );

        assert(errors.length > 0, 'should have captured the error from failing plugin');
        assert(goodPlugin._handle.active, 'good plugin should still be active');
        assert(watcher.active, 'watcher should still be active');

        await watcher.close();
    },

    async 'non-watchable plugins are silently skipped'(assert: { (cond: unknown, msg?: string): void; equal: (a: unknown, b: unknown, msg?: string) => void }) {
        // A plain Plugin with no watch() method
        const plainPlugin: Plugin = {
            name: 'plain',
            async initialize() {},
        };

        const watchablePlugin = createWatchablePlugin('watchable', {
            watchConfig: { debounceMs: 0 },
        });

        const events: string[] = [];
        const watcher = new Watcher(
            async () => {},
            [plainPlugin, watchablePlugin as Plugin],
            {
                debounceMs: 0,
                onIndex: (sourceId) => events.push(sourceId),
            },
        );

        watchablePlugin._fire({ type: 'update', sourceId: 'test.ts', sourceName: 'file' });

        const triggered = await waitFor(() => events.length > 0, 2000);
        assert(triggered, 'watchable plugin should still work');
        assert.equal(events[0], 'test.ts', 'should receive event from watchable plugin');

        await watcher.close();
    },

    async 'global reindexFn used when plugin is watchable but not indexable'(assert: { (cond: unknown, msg?: string): void }) {
        let globalReindexCalled = false;

        // A WatchablePlugin that is NOT IndexablePlugin (no index method)
        // Use a ref object so TypeScript doesn't narrow the handler to `never`
        const ref: { handler: WatchEventHandler | null } = { handler: null };
        const plugin: WatchablePlugin = {
            name: 'notifier',
            async initialize() {},
            watch(onEvent) {
                ref.handler = onEvent;
                return {
                    async stop() { ref.handler = null; },
                    get active() { return ref.handler !== null; },
                };
            },
            watchConfig() { return { debounceMs: 0 }; },
        };

        const watcher = new Watcher(
            async () => { globalReindexCalled = true; },
            [plugin as Plugin],
            { debounceMs: 0 },
        );

        // Fire an event via the stored handler
        ref.handler?.({ type: 'sync', sourceId: 'webhook', sourceName: 'external' });

        const triggered = await waitFor(() => globalReindexCalled, 2000);
        assert(triggered, 'global reindexFn should have been called as fallback');

        await watcher.close();
    },

    'matchesGlob matches double-star directory patterns'(assert: { (cond: unknown, msg?: string): void }) {
        assert(matchesGlob('test/unit/foo.ts', ['test/**']), 'test/** should match test/unit/foo.ts');
        assert(matchesGlob('dist/bundle.js', ['dist/**']), 'dist/** should match dist/bundle.js');
        assert(!matchesGlob('src/index.ts', ['test/**']), 'test/** should NOT match src/index.ts');
    },

    'matchesGlob matches extension glob patterns'(assert: { (cond: unknown, msg?: string): void }) {
        assert(matchesGlob('src/foo.test.ts', ['**/*.test.ts']), '**/*.test.ts should match src/foo.test.ts');
        assert(matchesGlob('deep/nested/bar.spec.ts', ['**/*.spec.ts']), '**/*.spec.ts should match nested');
        assert(!matchesGlob('src/foo.ts', ['**/*.test.ts']), '**/*.test.ts should NOT match src/foo.ts');
    },

    'matchesGlob returns false for empty patterns'(assert: { (cond: unknown, msg?: string): void }) {
        assert(!matchesGlob('src/foo.ts', []), 'empty patterns should never match');
    },

    'matchesGlob matches exact paths'(assert: { (cond: unknown, msg?: string): void }) {
        assert(matchesGlob('coverage/lcov.info', ['coverage/**']), 'coverage/** should match');
        assert(matchesGlob('.brainbank/data/db.db', ['.brainbank/**']), '.brainbank/** should match');
    },
};


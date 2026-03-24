/**
 * BrainBank — Watch Mode Tests
 *
 * Tests real fs.watch with temp files to verify:
 * - Custom indexer onFileChange is called on matching files
 * - Built-in code re-index is triggered for supported files
 * - Glob matching routes to the correct indexer
 * - Watcher close stops watching
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createWatcher } from '../../../src/services/watch.ts';
import type { Indexer } from '../../../src/indexers/base.ts';

export const name = 'Watch Mode';

/** Wait for a condition to be true, with timeout. */
function waitFor(conditionFn: () => boolean, timeoutMs = 5000, intervalMs = 100): Promise<boolean> {
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

/** Create a temp directory for watch tests. */
function tmpWatchDir(label: string): string {
    const dir = `/tmp/brainbank-watch-${label}-${Date.now()}`;
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

export const tests = {
    async 'custom indexer onFileChange is called for matching patterns'(assert: any) {
        const dir = tmpWatchDir('custom');
        const indexedFiles: string[] = [];

        // Custom indexer that watches .csv files
        const csvIndexer: Indexer = {
            name: 'csv',
            async initialize() {},
            watchPatterns() { return ['**/*.csv']; },
            async onFileChange(filePath, event) {
                indexedFiles.push(filePath);
                return true;
            },
        };

        const indexers = new Map<string, Indexer>([['csv', csvIndexer]]);
        let reindexCalled = false;

        const watcher = createWatcher(
            async () => { reindexCalled = true; },
            indexers,
            dir,
            { paths: [dir], debounceMs: 300 },
        );

        // Create a .csv file — should trigger custom indexer
        const csvPath = path.join(dir, 'data.csv');
        fs.writeFileSync(csvPath, 'name,value\nfoo,42');

        // Wait for debounce to fire
        const customFired = await waitFor(() => indexedFiles.length > 0, 3000);

        assert(customFired, 'custom indexer should have been called');
        assert(indexedFiles[0].endsWith('data.csv'), 'should have indexed data.csv');
        assert(!reindexCalled, 'built-in reindex should NOT have been called (custom handled it)');

        watcher.close();
        fs.rmSync(dir, { recursive: true, force: true });
    },

    async 'built-in reindex triggers for supported code files'(assert: any) {
        const dir = tmpWatchDir('code');
        let reindexCount = 0;

        const watcher = createWatcher(
            async () => { reindexCount++; },
            new Map(),
            dir,
            { paths: [dir], debounceMs: 300 },
        );

        // Create a .ts file — should trigger built-in reindex
        const tsPath = path.join(dir, 'hello.ts');
        fs.writeFileSync(tsPath, 'export const x = 1;');

        const triggered = await waitFor(() => reindexCount > 0, 3000);
        assert(triggered, 'reindex should have been called for .ts file');
        assert(reindexCount >= 1, 'reindex called at least once');

        watcher.close();
        fs.rmSync(dir, { recursive: true, force: true });
    },

    async 'ignored directories and files are skipped'(assert: any) {
        const dir = tmpWatchDir('ignored');
        let reindexCount = 0;

        const watcher = createWatcher(
            async () => { reindexCount++; },
            new Map(),
            dir,
            { paths: [dir], debounceMs: 300 },
        );

        // Create file inside node_modules — should be ignored
        const nmDir = path.join(dir, 'node_modules', 'pkg');
        fs.mkdirSync(nmDir, { recursive: true });
        fs.writeFileSync(path.join(nmDir, 'index.ts'), 'export const x = 1;');

        // Create a lockfile — should be ignored
        fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}');

        // Wait and check nothing was triggered
        await new Promise(r => setTimeout(r, 1000));
        assert.equal(reindexCount, 0, 'should NOT reindex ignored files');

        watcher.close();
        fs.rmSync(dir, { recursive: true, force: true });
    },

    async 'debounce batches multiple rapid changes'(assert: any) {
        const dir = tmpWatchDir('debounce');
        let reindexCount = 0;

        const watcher = createWatcher(
            async () => { reindexCount++; },
            new Map(),
            dir,
            { paths: [dir], debounceMs: 500 },
        );

        // Rapidly create 5 files
        for (let i = 0; i < 5; i++) {
            fs.writeFileSync(path.join(dir, `file${i}.ts`), `export const x = ${i};`);
        }

        // Wait for single debounced flush
        const triggered = await waitFor(() => reindexCount > 0, 3000);
        assert(triggered, 'reindex should have been called');
        // Should batch into 1 call (or very few), not 5
        assert(reindexCount <= 2, `should batch changes (got ${reindexCount} calls)`);

        watcher.close();
        fs.rmSync(dir, { recursive: true, force: true });
    },

    async 'watcher.close() stops watching'(assert: any) {
        const dir = tmpWatchDir('close');
        let reindexCount = 0;

        const watcher = createWatcher(
            async () => { reindexCount++; },
            new Map(),
            dir,
            { paths: [dir], debounceMs: 300 },
        );

        // Close immediately
        watcher.close();
        assert(!watcher.active, 'watcher should not be active after close');

        // Create a file — should NOT trigger anything
        fs.writeFileSync(path.join(dir, 'after-close.ts'), 'export const x = 1;');
        await new Promise(r => setTimeout(r, 800));
        assert.equal(reindexCount, 0, 'should NOT reindex after close');

        fs.rmSync(dir, { recursive: true, force: true });
    },

    async 'onIndex callback receives file and indexer name'(assert: any) {
        const dir = tmpWatchDir('callback');
        const events: { file: string; indexer: string }[] = [];

        const watcher = createWatcher(
            async () => {},
            new Map(),
            dir,
            {
                paths: [dir],
                debounceMs: 300,
                onIndex: (file, indexer) => events.push({ file, indexer }),
            },
        );

        // Create a .py file
        fs.writeFileSync(path.join(dir, 'script.py'), 'print("hello")');

        const gotCallback = await waitFor(() => events.length > 0, 3000);
        assert(gotCallback, 'onIndex callback should have been called');
        assert(events[0].indexer === 'code', 'indexer should be "code"');
        assert(events[0].file.includes('script.py'), 'file should contain script.py');

        watcher.close();
        fs.rmSync(dir, { recursive: true, force: true });
    },

    async 'custom indexer re-indexes updated file content'(assert: any) {
        const dir = tmpWatchDir('reindex');
        const indexed: { path: string; event: string }[] = [];

        const customIndexer: Indexer = {
            name: 'json-data',
            async initialize() {},
            watchPatterns() { return ['**/*.json']; },
            async onFileChange(filePath, event) {
                indexed.push({ path: filePath, event });
                return true;
            },
        };

        const indexers = new Map<string, Indexer>([['json-data', customIndexer]]);

        const watcher = createWatcher(
            async () => {},
            indexers,
            dir,
            { paths: [dir], debounceMs: 300 },
        );

        // Create file
        const jsonPath = path.join(dir, 'config.json');
        fs.writeFileSync(jsonPath, '{"version": 1}');

        const created = await waitFor(() => indexed.length > 0, 3000);
        assert(created, 'should detect file creation');

        // Update file
        indexed.length = 0;
        fs.writeFileSync(jsonPath, '{"version": 2}');

        const updated = await waitFor(() => indexed.length > 0, 3000);
        assert(updated, 'should detect file update');
        assert(indexed[0].event === 'update', 'event should be "update"');

        watcher.close();
        fs.rmSync(dir, { recursive: true, force: true });
    },
};

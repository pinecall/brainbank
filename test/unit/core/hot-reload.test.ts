/**
 * Unit Tests — ensureFresh + Hot-Reload
 *
 * Tests the multi-process coordination layer in BrainBank:
 * - ensureFresh() detects stale versions
 * - Hot-reload of HNSW indices from disk
 * - Version bumping after indexing
 * - Search methods call ensureFresh() implicitly
 */

import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import { BrainBank } from '../../../src/brainbank.ts';
import { bumpVersion, getVersions, getVersion } from '../../../src/db/metadata.ts';
import { SQLiteAdapter } from '../../../src/db/sqlite-adapter.ts';
import { docs } from '@brainbank/docs';
import type { EmbeddingProvider } from '../../../src/types.ts';

export const name = 'Hot-Reload & ensureFresh';

/** Deterministic mock embeddings — no model needed. */
class MockEmbedding implements EmbeddingProvider {
    readonly dims = 16;

    async embed(text: string): Promise<Float32Array> {
        const v = new Float32Array(16);
        for (let i = 0; i < 16; i++) {
            v[i] = Math.sin((text.charCodeAt(i % text.length) || 0) * (i + 1));
        }
        let norm = 0;
        for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
        norm = Math.sqrt(norm);
        if (norm > 0) for (let i = 0; i < v.length; i++) v[i] /= norm;
        return v;
    }

    async embedBatch(texts: string[]): Promise<Float32Array[]> {
        return Promise.all(texts.map(t => this.embed(t)));
    }

    async close(): Promise<void> {}
}

function makeDB() {
    return `/tmp/brainbank-hotreload-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
}

function cleanup(dbPath: string) {
    try { fs.unlinkSync(dbPath); } catch {}
    try { fs.unlinkSync(dbPath + '-wal'); } catch {}
    try { fs.unlinkSync(dbPath + '-shm'); } catch {}
    const dir = nodePath.dirname(dbPath);
    try {
        for (const f of fs.readdirSync(dir)) {
            if (f.startsWith('hnsw-') && f.endsWith('.index')) {
                fs.unlinkSync(nodePath.join(dir, f));
            }
        }
    } catch {}
    try {
        for (const f of fs.readdirSync(dir)) {
            if (f.endsWith('.lock')) {
                fs.unlinkSync(nodePath.join(dir, f));
            }
        }
    } catch {}
}

export const tests = {
    async 'ensureFresh is a no-op when not initialized'(assert: { ok: (v: unknown, msg?: string) => void }) {
        const db = makeDB();
        const brain = new BrainBank({ dbPath: db, embeddingProvider: new MockEmbedding(), embeddingDims: 16 });

        // Should not throw even when not initialized
        await brain.ensureFresh();
        assert.ok(true, 'ensureFresh before init should be a no-op');

        brain.close();
        cleanup(db);
    },

    async 'ensureFresh is a no-op when versions match'(assert: { ok: (v: unknown, msg?: string) => void }) {
        const db = makeDB();
        const brain = new BrainBank({ dbPath: db, embeddingProvider: new MockEmbedding(), embeddingDims: 16 });
        await brain.initialize();

        // No versions bumped since init — should be a no-op
        const events: string[] = [];
        brain.on('progress', (msg: string) => events.push(msg));

        await brain.ensureFresh();
        assert.ok(events.length === 0, 'should emit no events when versions match');

        brain.close();
        cleanup(db);
    },

    async 'ensureFresh detects version change and emits progress'(assert: { ok: (v: unknown, msg?: string) => void; gt: (a: number, b: number, msg?: string) => void }) {
        const db = makeDB();
        const brain = new BrainBank({ dbPath: db, embeddingProvider: new MockEmbedding(), embeddingDims: 16 });
        await brain.initialize();

        // Simulate another process bumping the version
        const rawDb = new SQLiteAdapter(db);
        bumpVersion(rawDb, 'kv');
        rawDb.close();

        const events: string[] = [];
        brain.on('progress', (msg: string) => events.push(msg));

        await brain.ensureFresh();
        assert.gt(events.length, 0, 'should emit progress events for hot-reload');
        assert.ok(events.some(e => e.includes('Hot-reload')), 'should mention hot-reload in event');
        assert.ok(events.some(e => e.includes('kv')), 'should mention the stale index name');

        brain.close();
        cleanup(db);
    },

    async 'ensureFresh is idempotent — second call is a no-op'(assert: { ok: (v: unknown, msg?: string) => void; equal: (a: unknown, b: unknown, msg?: string) => void }) {
        const db = makeDB();
        const brain = new BrainBank({ dbPath: db, embeddingProvider: new MockEmbedding(), embeddingDims: 16 });
        await brain.initialize();

        // Bump version externally
        const rawDb = new SQLiteAdapter(db);
        bumpVersion(rawDb, 'kv');
        rawDb.close();

        // First call detects staleness
        const events1: string[] = [];
        brain.on('progress', (msg: string) => events1.push(msg));
        await brain.ensureFresh();
        assert.ok(events1.length > 0, 'first call should detect staleness');

        // Second call — versions should match now
        brain.removeAllListeners('progress');
        const events2: string[] = [];
        brain.on('progress', (msg: string) => events2.push(msg));
        await brain.ensureFresh();
        assert.equal(events2.length, 0, 'second call should be a no-op');

        brain.close();
        cleanup(db);
    },

    async 'search calls ensureFresh implicitly'(assert: { ok: (v: unknown, msg?: string) => void }) {
        const db = makeDB();
        const brain = new BrainBank({ dbPath: db, embeddingProvider: new MockEmbedding(), embeddingDims: 16 });
        await brain.initialize();

        // Bump version externally
        const rawDb = new SQLiteAdapter(db);
        bumpVersion(rawDb, 'kv');
        rawDb.close();

        const events: string[] = [];
        brain.on('progress', (msg: string) => events.push(msg));

        // search() should trigger ensureFresh internally
        await brain.search('test query');
        assert.ok(events.some(e => e.includes('Hot-reload')), 'search() should trigger ensureFresh');

        brain.close();
        cleanup(db);
    },

    async 'hybridSearch calls ensureFresh implicitly'(assert: { ok: (v: unknown, msg?: string) => void }) {
        const db = makeDB();
        const brain = new BrainBank({ dbPath: db, embeddingProvider: new MockEmbedding(), embeddingDims: 16 });
        await brain.initialize();

        const rawDb = new SQLiteAdapter(db);
        bumpVersion(rawDb, 'kv');
        rawDb.close();

        const events: string[] = [];
        brain.on('progress', (msg: string) => events.push(msg));

        await brain.hybridSearch('test query');
        assert.ok(events.some(e => e.includes('Hot-reload')), 'hybridSearch() should trigger ensureFresh');

        brain.close();
        cleanup(db);
    },

    async 'searchBM25 calls ensureFresh implicitly'(assert: { ok: (v: unknown, msg?: string) => void }) {
        const db = makeDB();
        const brain = new BrainBank({ dbPath: db, embeddingProvider: new MockEmbedding(), embeddingDims: 16 });
        await brain.initialize();

        const rawDb = new SQLiteAdapter(db);
        bumpVersion(rawDb, 'kv');
        rawDb.close();

        const events: string[] = [];
        brain.on('progress', (msg: string) => events.push(msg));

        await brain.searchBM25('test query');
        assert.ok(events.some(e => e.includes('Hot-reload')), 'searchBM25() should trigger ensureFresh');

        brain.close();
        cleanup(db);
    },

    async 'getContext calls ensureFresh implicitly'(assert: { ok: (v: unknown, msg?: string) => void }) {
        const db = makeDB();
        const brain = new BrainBank({ dbPath: db, embeddingProvider: new MockEmbedding(), embeddingDims: 16 });
        await brain.initialize();

        const rawDb = new SQLiteAdapter(db);
        bumpVersion(rawDb, 'kv');
        rawDb.close();

        const events: string[] = [];
        brain.on('progress', (msg: string) => events.push(msg));

        await brain.getContext('test task');
        assert.ok(events.some(e => e.includes('Hot-reload')), 'getContext() should trigger ensureFresh');

        brain.close();
        cleanup(db);
    },

    async 'index() bumps version after completion'(assert: { ok: (v: unknown, msg?: string) => void; gt: (a: number, b: number, msg?: string) => void }) {
        const db = makeDB();
        const brain = new BrainBank({
            dbPath: db,
            embeddingProvider: new MockEmbedding(),
            embeddingDims: 16,
        }).use(docs());
        await brain.initialize();

        // Create temp docs and register
        const docsDir = `/tmp/brainbank-hotreload-docs-${Date.now()}`;
        fs.mkdirSync(docsDir, { recursive: true });
        fs.writeFileSync(`${docsDir}/test.md`, '# Test\n\nSome content for hot-reload testing.');
        const docsPlugin = brain.plugin('docs') as unknown as { addCollection: (c: Record<string, unknown>) => void };
        docsPlugin.addCollection({ name: 'test-docs', path: docsDir, pattern: '**/*.md' });

        // Index should bump version
        await brain.index({ modules: ['docs'] });

        // Check version was bumped
        const rawDb = new SQLiteAdapter(db);
        const version = getVersion(rawDb, 'docs');
        rawDb.close();

        assert.gt(version, 0, 'docs version should be bumped after indexing');

        brain.close();
        cleanup(db);
        fs.rmSync(docsDir, { recursive: true });
    },

    async 'close() clears loaded versions'(assert: { ok: (v: unknown, msg?: string) => void }) {
        const db = makeDB();
        const brain = new BrainBank({ dbPath: db, embeddingProvider: new MockEmbedding(), embeddingDims: 16 });
        await brain.initialize();
        brain.close();

        // After close, ensureFresh should be a no-op (not initialized)
        await brain.ensureFresh();
        assert.ok(true, 'ensureFresh after close should not throw');
        cleanup(db);
    },

    async 'ensureFresh handles multiple stale indices'(assert: { ok: (v: unknown, msg?: string) => void; gte: (a: number, b: number, msg?: string) => void }) {
        const db = makeDB();
        const brain = new BrainBank({ dbPath: db, embeddingProvider: new MockEmbedding(), embeddingDims: 16 });
        await brain.initialize();

        // Bump multiple indices externally
        const rawDb = new SQLiteAdapter(db);
        bumpVersion(rawDb, 'kv');
        bumpVersion(rawDb, 'code');
        bumpVersion(rawDb, 'git');
        rawDb.close();

        const events: string[] = [];
        brain.on('progress', (msg: string) => events.push(msg));

        await brain.ensureFresh();

        // Should detect at least the KV staleness (code/git have no HNSW loaded, but KV does)
        assert.gte(events.length, 1, 'should detect at least one stale index');

        brain.close();
        cleanup(db);
    },
};

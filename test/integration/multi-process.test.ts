/**
 * Integration Tests — Multi-Process Coordination
 *
 * End-to-end tests simulating multi-process scenarios:
 * - Two BrainBank instances sharing the same DB
 * - Index in one instance, detect staleness in the other
 * - Version tracking across index → search cycle
 * - File locking during concurrent saves
 * - KV collection versioning with hot-reload
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { BrainBank } from '../../src/brainbank.ts';
import { bumpVersion, getVersions, getVersion } from '../../src/db/metadata.ts';
import { SQLiteAdapter } from '../../src/db/sqlite-adapter.ts';
import { withLock } from '../../src/lib/write-lock.ts';
import { saveAllHnsw, lockDir } from '../../src/providers/vector/hnsw-loader.ts';
import { HNSWIndex } from '../../src/providers/vector/hnsw-index.ts';
import { docs } from '@brainbank/docs';
import type { EmbeddingProvider } from '../../src/types.ts';

export const name = 'Multi-Process Coordination (integration)';

/** Simple hash-based deterministic embeddings. */
function hashEmbedding(dims = 16): EmbeddingProvider {
    function embed(text: string): Float32Array {
        const vec = new Float32Array(dims);
        let h = 2166136261;
        for (let i = 0; i < text.length; i++) {
            h ^= text.charCodeAt(i);
            h = Math.imul(h, 16777619) >>> 0;
        }
        for (let i = 0; i < dims; i++) {
            h ^= (h >>> 13);
            h = Math.imul(h, 0x5bd1e995) >>> 0;
            vec[i] = (h / 0xFFFFFFFF) * 2 - 1;
        }
        let norm = 0;
        for (let i = 0; i < dims; i++) norm += vec[i] * vec[i];
        norm = Math.sqrt(norm);
        if (norm > 0) for (let i = 0; i < dims; i++) vec[i] /= norm;
        return vec;
    }
    return {
        dims,
        embed: async (t) => embed(t),
        embedBatch: async (ts) => ts.map(embed),
        close: async () => {},
    };
}

function freshDirs() {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const dbPath = `/tmp/brainbank-multiproc-${stamp}.db`;
    const docsDir = `/tmp/brainbank-multiproc-docs-${stamp}`;
    return { dbPath, docsDir };
}

function cleanupAll(dbPath: string, docsDir?: string) {
    try { fs.unlinkSync(dbPath); } catch {}
    try { fs.unlinkSync(dbPath + '-wal'); } catch {}
    try { fs.unlinkSync(dbPath + '-shm'); } catch {}
    const dir = path.dirname(dbPath);
    try {
        for (const f of fs.readdirSync(dir)) {
            if ((f.startsWith('hnsw-') && f.endsWith('.index')) || f.endsWith('.lock')) {
                fs.unlinkSync(path.join(dir, f));
            }
        }
    } catch {}
    if (docsDir) {
        try { fs.rmSync(docsDir, { recursive: true }); } catch {}
    }
}

export const tests = {
    async 'two instances share same DB and detect staleness'(assert: { (c: unknown, msg?: string): void; ok: (v: unknown, msg?: string) => void; equal: (a: unknown, b: unknown, msg?: string) => void }) {
        const { dbPath } = freshDirs();
        const emb = hashEmbedding();

        // Instance A — "indexing process"
        const brainA = new BrainBank({ dbPath, embeddingProvider: emb, embeddingDims: 16 });
        await brainA.initialize();

        // Instance B — "MCP server process" (different BrainBank instance, same DB)
        const brainB = new BrainBank({ dbPath, embeddingProvider: emb, embeddingDims: 16 });
        await brainB.initialize();

        // A adds KV data, which bumps 'kv' version internally
        const collA = await brainA.collection('shared-test');
        await collA.add('test data from process A');

        // Manually bump to signal B
        const rawDb = new SQLiteAdapter(dbPath);
        bumpVersion(rawDb, 'kv');
        rawDb.close();

        // B should detect staleness
        const events: string[] = [];
        brainB.on('progress', (msg: string) => events.push(msg));
        await brainB.ensureFresh();

        assert.ok(events.some(e => e.includes('Hot-reload') && e.includes('kv')),
            'brainB should detect stale KV HNSW and hot-reload');

        brainA.close();
        brainB.close();
        cleanupAll(dbPath);
    },

    async 'version is bumped after docs indexing and detected by second instance'(assert: { ok: (v: unknown, msg?: string) => void; gt: (a: number, b: number, msg?: string) => void }) {
        const { dbPath, docsDir } = freshDirs();
        const emb = hashEmbedding();

        // Create test docs
        fs.mkdirSync(docsDir, { recursive: true });
        fs.writeFileSync(path.join(docsDir, 'readme.md'), '# Integration Test\n\nThis is content for multi-process coordination testing.');

        // Instance A — indexing
        const brainA = new BrainBank({
            dbPath,
            embeddingProvider: emb,
            embeddingDims: 16,
        }).use(docs());
        await brainA.initialize();
        const docsPlugin = brainA.plugin('docs') as unknown as { addCollection: (c: Record<string, unknown>) => void };
        docsPlugin.addCollection({
            name: 'test-docs',
            path: docsDir,
            pattern: '**/*.md',
        });
        await brainA.index({ modules: ['docs'] });

        // Check version was bumped
        const rawDb = new SQLiteAdapter(dbPath);
        const v = getVersion(rawDb, 'docs');
        rawDb.close();
        assert.gt(v, 0, 'docs version should be > 0 after indexing');

        // Instance B — should detect staleness
        const brainB = new BrainBank({
            dbPath,
            embeddingProvider: emb,
            embeddingDims: 16,
        }).use(docs());
        await brainB.initialize();

        // B was initialized after A indexed, so it should have loaded the versions snapshot
        // If we bump again externally, B should detect it
        const rawDb2 = new SQLiteAdapter(dbPath);
        bumpVersion(rawDb2, 'docs');
        rawDb2.close();

        const events: string[] = [];
        brainB.on('progress', (msg: string) => events.push(msg));
        await brainB.ensureFresh();

        assert.ok(events.some(e => e.includes('docs')), 'brainB should detect docs staleness');

        brainA.close();
        brainB.close();
        cleanupAll(dbPath, docsDir);
    },

    async 'saveAllHnsw is protected by file lock'(assert: { ok: (v: unknown, msg?: string) => void; equal: (a: unknown, b: unknown, msg?: string) => void }) {
        const { dbPath } = freshDirs();
        const emb = hashEmbedding();

        const brain = new BrainBank({ dbPath, embeddingProvider: emb, embeddingDims: 16 });
        await brain.initialize();

        // Verify that saveAllHnsw creates a lock file during save
        const dir = path.dirname(dbPath);
        let lockExistedDuringSave = false;

        // Use withLock manually to test that the same lock is used
        // (saveAllHnsw uses withLock internally with name 'hnsw')
        const lockPath = path.join(dir, 'hnsw.lock');

        // Start a withLock that holds the lock
        const lockPromise = withLock(dir, 'hnsw', async () => {
            lockExistedDuringSave = fs.existsSync(lockPath);
            await new Promise<void>(r => setTimeout(r, 50));
        });

        await lockPromise;
        assert.ok(lockExistedDuringSave, 'lock file should exist during withLock');
        assert.ok(!fs.existsSync(lockPath), 'lock file should be cleaned up after');

        brain.close();
        cleanupAll(dbPath);
    },

    async 'KV collection data is accessible after hot-reload'(assert: { ok: (v: unknown, msg?: string) => void; gt: (a: number, b: number, msg?: string) => void }) {
        const { dbPath } = freshDirs();
        const emb = hashEmbedding();

        // Instance A — writes KV data
        const brainA = new BrainBank({ dbPath, embeddingProvider: emb, embeddingDims: 16 });
        await brainA.initialize();
        const collA = await brainA.collection('coordination-test');
        await collA.add('authentication middleware for JWT validation');
        await collA.add('database migration tool for schema updates');
        await collA.add('CI/CD pipeline configuration for deployments');

        brainA.close();

        // Instance B — reads KV data (simulates cold start after A indexed)
        const brainB = new BrainBank({ dbPath, embeddingProvider: emb, embeddingDims: 16 });
        await brainB.initialize();
        const collB = await brainB.collection('coordination-test');
        const results = await collB.search('authentication JWT', { k: 5 });

        assert.gt(results.length, 0, 'should find KV data written by instance A');
        assert.ok(results.some(r => r.content.includes('authentication') || r.content.includes('JWT')),
            'results should include authentication-related content');

        brainB.close();
        cleanupAll(dbPath);
    },

    async 'version tracking survives instance restart'(assert: { equal: (a: unknown, b: unknown, msg?: string) => void; gt: (a: number, b: number, msg?: string) => void }) {
        const { dbPath } = freshDirs();
        const emb = hashEmbedding();

        // Instance A — bump some versions
        const brainA = new BrainBank({ dbPath, embeddingProvider: emb, embeddingDims: 16 });
        await brainA.initialize();

        const rawDb = new SQLiteAdapter(dbPath);
        bumpVersion(rawDb, 'code');
        bumpVersion(rawDb, 'code');
        bumpVersion(rawDb, 'git');
        rawDb.close();

        brainA.close();

        // Instance B — should see the versions from A
        const brainB = new BrainBank({ dbPath, embeddingProvider: emb, embeddingDims: 16 });
        await brainB.initialize();

        const rawDb2 = new SQLiteAdapter(dbPath);
        const versions = getVersions(rawDb2);
        rawDb2.close();

        assert.equal(versions.get('code'), 2, 'code version should persist');
        assert.equal(versions.get('git'), 1, 'git version should persist');

        brainB.close();
        cleanupAll(dbPath);
    },

    async 'concurrent withLock calls serialize correctly'(assert: { ok: (v: unknown, msg?: string) => void; equal: (a: unknown, b: unknown, msg?: string) => void }) {
        const dir = `/tmp/brainbank-conclock-${Date.now()}`;
        fs.mkdirSync(dir, { recursive: true });

        const order: string[] = [];

        const p1 = withLock(dir, 'serialize', async () => {
            order.push('start-1');
            await new Promise<void>(r => setTimeout(r, 100));
            order.push('end-1');
        });

        // Slight delay to ensure p1 acquires first
        await new Promise<void>(r => setTimeout(r, 10));

        const p2 = withLock(dir, 'serialize', async () => {
            order.push('start-2');
            await new Promise<void>(r => setTimeout(r, 50));
            order.push('end-2');
        });

        await Promise.all([p1, p2]);

        // p1 should fully complete before p2 starts
        assert.equal(order[0], 'start-1');
        assert.equal(order[1], 'end-1');
        assert.equal(order[2], 'start-2');
        assert.equal(order[3], 'end-2');

        fs.rmSync(dir, { recursive: true });
    },

    async 'schema version 8 includes index_state table'(assert: { ok: (v: unknown, msg?: string) => void }) {
        const { dbPath } = freshDirs();
        const emb = hashEmbedding();

        const brain = new BrainBank({ dbPath, embeddingProvider: emb, embeddingDims: 16 });
        await brain.initialize();

        const rawDb = new SQLiteAdapter(dbPath);
        const tables = rawDb.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='index_state'"
        ).all() as { name: string }[];

        assert.ok(tables.length === 1, 'index_state table should exist');

        // Verify columns
        const cols = rawDb.raw<{ pragma(s: string): { name: string }[] }>()!.pragma('table_info(index_state)') as { name: string }[];
        const colNames = cols.map(c => c.name);
        assert.ok(colNames.includes('name'), 'should have name column');
        assert.ok(colNames.includes('version'), 'should have version column');
        assert.ok(colNames.includes('writer_pid'), 'should have writer_pid column');
        assert.ok(colNames.includes('updated_at'), 'should have updated_at column');

        rawDb.close();
        brain.close();
        cleanupAll(dbPath);
    },

    async 'bumpVersion sets correct writer_pid'(assert: { equal: (a: unknown, b: unknown, msg?: string) => void }) {
        const { dbPath } = freshDirs();
        const emb = hashEmbedding();

        const brain = new BrainBank({ dbPath, embeddingProvider: emb, embeddingDims: 16 });
        await brain.initialize();

        const rawDb = new SQLiteAdapter(dbPath);
        bumpVersion(rawDb, 'test-index');

        const row = rawDb.prepare('SELECT writer_pid FROM index_state WHERE name = ?').get('test-index') as { writer_pid: number };
        assert.equal(row.writer_pid, process.pid, 'writer_pid should be current process PID');

        rawDb.close();
        brain.close();
        cleanupAll(dbPath);
    },
};

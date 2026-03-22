/**
 * BrainBank — Integration Tests
 *
 * These tests exercise the REAL pipeline end-to-end:
 * - Real SQLite database with WAL mode
 * - Real HNSW vector search with content-aware embeddings
 * - Real BM25 keyword search on FTS5 indices
 * - Real tag filtering + TTL auto-prune
 * - Real file system watch mode with custom indexers
 *
 * Uses a content-aware hash embedding that produces distinct vectors
 * per text, so vector search returns meaningful ranked results
 * without requiring the @xenova/transformers model download.
 *
 * Run with: npm test -- --integration
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { BrainBank } from '../../src/core/brainbank.ts';
import type { EmbeddingProvider } from '../../src/types.ts';
import type { Indexer, IndexerContext } from '../../src/modules/types.ts';

export const name = 'Integration — Full Pipeline';

// ── Content-Aware Embedding ─────────────────────────
// Hash-based: same text → same vector, different text → different vector.
// This gives real vector search differentiation vs the all-0.1 mock.

function hashEmbedding(dims = 384): EmbeddingProvider {
    function hash(text: string): Float32Array {
        const vec = new Float32Array(dims);
        for (let i = 0; i < text.length; i++) {
            const idx = i % dims;
            vec[idx] += text.charCodeAt(i) * (i + 1) * 0.001;
        }
        // Normalize
        let norm = 0;
        for (let i = 0; i < dims; i++) norm += vec[i] * vec[i];
        norm = Math.sqrt(norm) || 1;
        for (let i = 0; i < dims; i++) vec[i] /= norm;
        return vec;
    }
    return {
        dims,
        async embed(text: string) { return hash(text); },
        async embedBatch(texts: string[]) { return texts.map(t => hash(t)); },
        async close() {},
    };
}

function tmpDb(label: string): string {
    return `/tmp/brainbank-integ-${label}-${Date.now()}.db`;
}

function tmpDir(label: string): string {
    const dir = `/tmp/brainbank-integ-${label}-${Date.now()}`;
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function wait(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
}

function waitFor(conditionFn: () => boolean, timeoutMs = 5000): Promise<boolean> {
    return new Promise((resolve) => {
        const start = Date.now();
        const check = () => {
            if (conditionFn()) return resolve(true);
            if (Date.now() - start > timeoutMs) return resolve(false);
            setTimeout(check, 100);
        };
        check();
    });
}

// ── Shared state ────────────────────────────────────

let brain: BrainBank;
let dbPath: string;

export const tests = {

    // ── Bootstrap ────────────────────────────────────

    async 'initialize full pipeline'(assert: any) {
        dbPath = tmpDb('pipeline');
        brain = new BrainBank({ dbPath, embeddingProvider: hashEmbedding() });
        await brain.initialize();

        assert(brain.isInitialized, 'should be initialized');
    },

    // ── Collections End-to-End ───────────────────────

    async 'add items with tags and metadata, verify stored'(assert: any) {
        const col = brain.collection('errors');

        await col.add('NullPointerException in UserService.getUser()', {
            tags: ['critical', 'java'],
            metadata: { file: 'UserService.java', line: 42 },
        });
        await col.add('Connection timeout to database on read query', {
            tags: ['warning', 'db'],
            metadata: { file: 'DatabasePool.ts', line: 87 },
        });
        await col.add('Authentication token expired for user session', {
            tags: ['critical', 'auth'],
            metadata: { file: 'AuthMiddleware.ts', line: 15 },
        });
        await col.add('Out of memory error in image processing pipeline', {
            tags: ['critical', 'infra'],
            metadata: { file: 'ImageWorker.ts', line: 230 },
        });

        assert.equal(col.count(), 4);

        const items = col.list();
        assert.equal(items.length, 4);
        // Check metadata is preserved
        const nullPtr = items.find(i => i.content.includes('NullPointer'));
        assert(nullPtr, 'should find null pointer item');
        assert.equal(nullPtr!.metadata.file, 'UserService.java');
        assert.equal(nullPtr!.metadata.line, 42);
        assert.deepEqual(nullPtr!.tags, ['critical', 'java']);
    },

    async 'vector search returns ranked results by similarity'(assert: any) {
        const col = brain.collection('errors');

        // Query semantically close to "NullPointer"
        const results = await col.search('NullPointerException user service', { k: 4, mode: 'vector' });
        assert.gt(results.length, 0, 'should have vector results');
        // Top result should be the most similar
        assert(results[0].content.includes('NullPointer'), 'top result should be NullPointer');
        assert.gt(results[0].score!, 0, 'score should be positive');
        // Results should be in descending score order
        for (let i = 1; i < results.length; i++) {
            assert.gte(results[i - 1].score!, results[i].score!, 'scores should be descending');
        }
    },

    async 'keyword search via BM25 matches exact terms'(assert: any) {
        const col = brain.collection('errors');

        const results = await col.search('database timeout', { k: 4, mode: 'keyword' });
        assert.gt(results.length, 0, 'should have keyword results');
        assert(results[0].content.includes('database'), 'top hit should contain "database"');
    },

    async 'hybrid search combines both signals'(assert: any) {
        const col = brain.collection('errors');

        const results = await col.search('token authentication expired', { k: 4, mode: 'hybrid' });
        assert.gt(results.length, 0, 'should have hybrid results');
        const hasAuth = results.some(r => r.content.includes('Authentication') || r.content.includes('token'));
        assert(hasAuth, 'should find auth-related item via hybrid');
    },

    // ── Tag Filtering End-to-End ────────────────────

    async 'search with tag filter returns only matching'(assert: any) {
        const col = brain.collection('errors');

        // Single tag
        const criticals = await col.search('error', { tags: ['critical'], mode: 'keyword', minScore: 0 });
        assert(criticals.every(r => r.tags.includes('critical')), 'all should have critical tag');

        // Multiple tags (AND)
        const criticalAuth = await col.search('error', { tags: ['critical', 'auth'], mode: 'keyword', minScore: 0 });
        assert(criticalAuth.every(r =>
            r.tags.includes('critical') && r.tags.includes('auth')
        ), 'all should have both tags');
        assert(criticalAuth.length <= criticals.length, 'AND filter should narrow results');
    },

    async 'list with tag filter returns correct subset'(assert: any) {
        const col = brain.collection('errors');

        const dbItems = col.list({ tags: ['db'] });
        assert.equal(dbItems.length, 1);
        assert(dbItems[0].content.includes('database'));

        const criticalItems = col.list({ tags: ['critical'] });
        assert.equal(criticalItems.length, 3, 'should have 3 critical items');

        const javaItems = col.list({ tags: ['java'] });
        assert.equal(javaItems.length, 1);
    },

    // ── TTL End-to-End ──────────────────────────────

    async 'TTL: expired items are auto-pruned on list and search'(assert: any) {
        const col = brain.collection('ttl_integ');

        await col.add('temporary note', { ttl: '1s' });
        await col.add('permanent note');

        // Both exist immediately
        assert.equal(col.count(), 2);

        // Wait for expiry
        await wait(1500);

        // List auto-prunes
        const items = col.list();
        assert.equal(items.length, 1, 'expired item should be pruned');
        assert.equal(items[0].content, 'permanent note');

        // Search also auto-prunes
        const hits = await col.search('note', { mode: 'keyword', minScore: 0 });
        assert(hits.every(h => h.content === 'permanent note'), 'search should not return expired items');
    },

    // ── Multi-Collection Isolation ──────────────────

    async 'collections are isolated from each other'(assert: any) {
        const errors = brain.collection('errors');
        const notes = brain.collection('meeting_notes');

        await notes.add('Sprint planning for Q2 roadmap discussion');
        await notes.add('Architecture review of microservices migration');

        // Counts are independent
        assert.equal(errors.count(), 4);
        assert.equal(notes.count(), 2);

        // Search in one should not leak to other
        const noteResults = await notes.search('authentication', { k: 5, mode: 'keyword', minScore: 0 });
        for (const r of noteResults) {
            assert.equal(r.collection, 'meeting_notes');
        }

        // listCollectionNames includes both
        const names = brain.listCollectionNames();
        assert(names.includes('errors'));
        assert(names.includes('meeting_notes'));
        assert(names.includes('ttl_integ'));
    },

    // ── Batch Operations ────────────────────────────

    async 'addMany stores batch with tags and creates searchable vectors'(assert: any) {
        const col = brain.collection('batch_items');

        const ids = await col.addMany([
            { content: 'React component rendering issue', tags: ['frontend'] },
            { content: 'PostgreSQL query optimization needed', tags: ['backend', 'db'] },
            { content: 'CSS flexbox alignment bug', tags: ['frontend', 'css'] },
            { content: 'Redis cache invalidation failure', tags: ['backend', 'cache'] },
        ]);

        assert.equal(ids.length, 4);
        assert.equal(col.count(), 4);

        // Vector search on batch data
        const hits = await col.search('CSS flexbox layout', { k: 2, mode: 'vector' });
        assert.gt(hits.length, 0);
        assert(hits[0].content.includes('flexbox'), 'should find CSS item');

        // Tag filter on batch data
        const frontend = col.list({ tags: ['frontend'] });
        assert.equal(frontend.length, 2, 'should have 2 frontend items');
    },

    // ── Trim & Prune ────────────────────────────────

    async 'trim keeps only N most recent items'(assert: any) {
        const col = brain.collection('trim_integ');

        await col.add('first');
        await wait(50);
        await col.add('second');
        await wait(50);
        await col.add('third');
        await wait(50);
        await col.add('fourth');

        assert.equal(col.count(), 4);
        await col.trim({ keep: 2 });

        const items = col.list();
        assert.equal(items.length, 2);
        assert(items.some(i => i.content === 'fourth'), 'most recent should survive');
        assert(items.some(i => i.content === 'third'), 'second most recent should survive');
    },

    async 'remove deletes item and its vectors'(assert: any) {
        const col = brain.collection('remove_integ');

        const id1 = await col.add('keep this');
        const id2 = await col.add('delete this');

        assert.equal(col.count(), 2);
        col.remove(id2);
        assert.equal(col.count(), 1);

        const items = col.list();
        assert.equal(items[0].content, 'keep this');
    },

    async 'clear removes all items in collection'(assert: any) {
        const col = brain.collection('clear_integ');

        await col.add('item 1');
        await col.add('item 2');
        assert.equal(col.count(), 2);

        col.clear();
        assert.equal(col.count(), 0);
    },

    // ── Watch Mode End-to-End ────────────────────────

    async 'watch: custom indexer detects create and update'(assert: any) {
        const dir = tmpDir('watch-e2e');
        const watchDb = tmpDb('watch-e2e');
        const events: { path: string; event: string }[] = [];

        const logIndexer: Indexer = {
            name: 'logs',
            async initialize() {},
            watchPatterns() { return ['**/*.log']; },
            async onFileChange(filePath, event) {
                events.push({ path: path.basename(filePath), event });
                return true;
            },
        };

        const watchBrain = new BrainBank({
            dbPath: watchDb,
            repoPath: dir,
            embeddingProvider: hashEmbedding(),
        });
        watchBrain.use(logIndexer);
        await watchBrain.initialize();

        const watcher = watchBrain.watch({ paths: [dir], debounceMs: 300 });

        // Create file
        const logPath = path.join(dir, 'app.log');
        fs.writeFileSync(logPath, 'INFO: started');
        const created = await waitFor(() => events.length > 0, 3000);
        assert(created, 'should detect log file creation');

        // Update file
        events.length = 0;
        fs.writeFileSync(logPath, 'ERROR: crash');
        const updated = await waitFor(() => events.length > 0, 3000);
        assert(updated, 'should detect log file update');
        assert.equal(events[0].event, 'update');

        watcher.close();
        watchBrain.close();
        fs.rmSync(dir, { recursive: true, force: true });
    },

    // ── Cleanup ──────────────────────────────────────

    async 'cleanup'(assert: any) {
        brain.close();
        assert(!brain.isInitialized);
        try { fs.unlinkSync(dbPath); } catch {}
        try { fs.unlinkSync(dbPath + '-wal'); } catch {}
        try { fs.unlinkSync(dbPath + '-shm'); } catch {}
    },
};

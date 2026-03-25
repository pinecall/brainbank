/**
 * BrainBank — Reembed Tests
 * 
 * Tests the re-embedding engine: regenerating vectors with a new provider
 * without re-parsing files, git, or documents.
 */

import { BrainBank, Database, mockEmbedding, tmpDb } from '../../helpers.ts';
import type { EmbeddingProvider } from '../../helpers.ts';

export const name = 'Re-embedding';

export const tests = {
    async 'reembed regenerates kv vectors with new provider'(assert: any) {
        const dbPath = tmpDb('reembed-kv');

        // Phase 1: index with provider A (fills 0.1)
        const brain1 = new BrainBank({ dbPath, embeddingProvider: mockEmbedding(384), embeddingDims: 384 });
        await brain1.initialize();
        const kb = brain1.collection('test');
        await kb.add('Authentication uses JWT tokens');
        await kb.add('Database uses PostgreSQL');
        assert.equal(kb.count(), 2);
        brain1.close();

        // Phase 2: reembed with provider B (fills 0.5 — different embeddings)
        const providerB: EmbeddingProvider = {
            dims: 384,
            async embed(_: string) { return new Float32Array(384).fill(0.5); },
            async embedBatch(txts: string[]) { return txts.map(() => new Float32Array(384).fill(0.5)); },
            async close() {},
        };
        const brain2 = new BrainBank({ dbPath, embeddingProvider: providerB, embeddingDims: 384 });
        await brain2.initialize();

        const result = await brain2.reembed();
        assert(result.kv >= 2, `should reembed >= 2 kv items, got ${result.kv}`);
        assert(result.total >= 2, `total should be >= 2, got ${result.total}`);

        brain2.close();
    },

    async 'reembed preserves text and FTS'(assert: any) {
        const dbPath = tmpDb('reembed-preserve');

        const brain = new BrainBank({ dbPath, embeddingProvider: mockEmbedding(), embeddingDims: 384 });
        await brain.initialize();
        const kb = brain.collection('preserve');
        await kb.add('JWT authentication middleware', { type: 'auth' });
        await kb.add('PostgreSQL connection pool', { type: 'db' });

        // Re-embed
        await brain.reembed();

        // Text and FTS should still work
        const items = kb.list();
        assert.equal(items.length, 2);
        assert.equal(items[0].content.includes('JWT') || items[1].content.includes('JWT'), true);

        // Keyword search should still find results
        const hits = await kb.search('JWT', { mode: 'keyword', minScore: 0 });
        assert(hits.length > 0, 'FTS should still find JWT after reembed');

        brain.close();
    },

    async 'reembed returns zero counts for empty tables'(assert: any) {
        const brain = new BrainBank({ dbPath: tmpDb('reembed-empty'), embeddingProvider: mockEmbedding() });
        await brain.initialize();

        const result = await brain.reembed();
        assert.equal(result.total, 0);
        assert.equal(result.code, 0);
        assert.equal(result.git, 0);
        assert.equal(result.docs, 0);
        assert.equal(result.kv, 0);

        brain.close();
    },

    async 'embedding_meta tracks provider info'(assert: any) {
        const dbPath = tmpDb('reembed-meta');
        const brain = new BrainBank({ dbPath, embeddingProvider: mockEmbedding(384), embeddingDims: 384 });
        await brain.initialize();

        // Check metadata was stored
        const db = new Database(dbPath);
        const provider = db.prepare("SELECT value FROM embedding_meta WHERE key = 'provider'").get() as any;
        const dims = db.prepare("SELECT value FROM embedding_meta WHERE key = 'dims'").get() as any;

        assert(provider, 'provider should be stored');
        assert.equal(dims?.value, '384');

        db.close();
        brain.close();
    },

    async 'reembed throws if not initialized'(assert: any) {
        const brain = new BrainBank({ dbPath: tmpDb('reembed-noinit'), embeddingProvider: mockEmbedding() });

        let threw = false;
        try {
            await brain.reembed();
        } catch (e: any) {
            threw = true;
            assert.includes(e.message, 'Not initialized');
        }
        assert(threw, 'should throw if not initialized');
    },

    async 'reembed produces clean HNSW without duplicates'(assert: any) {
        const dbPath = tmpDb('reembed-clean-hnsw');

        // Phase 1: add items with provider A
        const brain1 = new BrainBank({ dbPath, embeddingProvider: mockEmbedding(384), embeddingDims: 384 });
        await brain1.initialize();
        const col1 = brain1.collection('test');
        await col1.add('item one');
        await col1.add('item two');
        await col1.add('item three');
        assert.equal(col1.count(), 3);
        brain1.close();

        // Phase 2: reembed with provider B
        const providerB: EmbeddingProvider = {
            dims: 384,
            async embed(_: string) { return new Float32Array(384).fill(0.7); },
            async embedBatch(txts: string[]) { return txts.map(() => new Float32Array(384).fill(0.7)); },
            async close() {},
        };
        const brain2 = new BrainBank({ dbPath, embeddingProvider: providerB, embeddingDims: 384 });
        await brain2.initialize();
        const result = await brain2.reembed();

        // HNSW should have exactly 3 items, not 6 (duplicates from stale index)
        assert.equal(result.kv, 3, 'should reembed exactly 3 kv items');

        // Search should still work
        const col2 = brain2.collection('test');
        const hits = await col2.search('item', { k: 10, mode: 'vector', minScore: 0 });
        assert(hits.length <= 3, `should return at most 3 results, got ${hits.length}`);

        brain2.close();
    },

    async 'reembed search uses new embeddings'(assert: any) {
        const dbPath = tmpDb('reembed-search');

        // Phase 1: provider A (fills 0.1)
        const brain1 = new BrainBank({ dbPath, embeddingProvider: mockEmbedding(384), embeddingDims: 384 });
        await brain1.initialize();
        const col1 = brain1.collection('data');
        await col1.add('hello world');
        brain1.close();

        // Phase 2: provider B (fills 0.9 — very different from A)
        const providerB: EmbeddingProvider = {
            dims: 384,
            async embed(_: string) { return new Float32Array(384).fill(0.9); },
            async embedBatch(txts: string[]) { return txts.map(() => new Float32Array(384).fill(0.9)); },
            async close() {},
        };
        const brain2 = new BrainBank({ dbPath, embeddingProvider: providerB, embeddingDims: 384 });
        await brain2.initialize();
        await brain2.reembed();

        // After reembed, vector search with B-style query should find the item
        const col2 = brain2.collection('data');
        const hits = await col2.search('hello', { k: 1, mode: 'vector', minScore: 0 });
        assert.equal(hits.length, 1, 'should find item with new embeddings');

        brain2.close();
    },

    async 'reembed handles dimension mismatch (384 → 128)'(assert: any) {
        const dbPath = tmpDb('reembed-dims');

        // Phase 1: index with 384-dim provider
        const brain1 = new BrainBank({ dbPath, embeddingProvider: mockEmbedding(384), embeddingDims: 384 });
        await brain1.initialize();
        const col1 = brain1.collection('data');
        await col1.add('dimension test item');
        assert.equal(col1.count(), 1);
        brain1.close();

        // Phase 2: reopen with 128-dim provider (different dims) — needs force
        const provider128: EmbeddingProvider = {
            dims: 128,
            async embed(_: string) { return new Float32Array(128).fill(0.3); },
            async embedBatch(txts: string[]) { return txts.map(() => new Float32Array(128).fill(0.3)); },
            async close() {},
        };
        const brain2 = new BrainBank({ dbPath, embeddingProvider: provider128, embeddingDims: 128 });
        await brain2.initialize({ force: true });

        const result = await brain2.reembed();
        assert(result.kv >= 1, `should reembed >= 1 kv items, got ${result.kv}`);

        // Search with new dims should work
        const col2 = brain2.collection('data');
        const hits = await col2.search('dimension', { k: 1, mode: 'vector', minScore: 0 });
        assert.equal(hits.length, 1, 'should find item after dims change');

        brain2.close();
    },

    async 'initialize throws on dimension mismatch'(assert: any) {
        const dbPath = tmpDb('reembed-mismatch-throw');

        // Phase 1: index with 384-dim provider
        const brain1 = new BrainBank({ dbPath, embeddingProvider: mockEmbedding(384), embeddingDims: 384 });
        await brain1.initialize();
        await brain1.collection('data').add('some content');
        brain1.close();

        // Phase 2: reopen with different dims — should throw
        const brain2 = new BrainBank({ dbPath, embeddingProvider: mockEmbedding(128), embeddingDims: 128 });
        let threw = false;
        try {
            await brain2.initialize();
        } catch (e: any) {
            threw = true;
            assert.includes(e.message, 'dimension mismatch');
            assert.includes(e.message, 'reembed');
        }
        assert(threw, 'should throw on dimension mismatch');
    },
};

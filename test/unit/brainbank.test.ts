/**
 * Unit Tests — BrainBank Orchestrator
 * 
 * Tests modular initialization with .use() pattern.
 * Uses a mock embedding provider (no model download required).
 */

import * as fs from 'node:fs';
import { BrainBank } from '../../src/core/brainbank.ts';
import { memory } from '../../src/modules/memory.ts';
import { conversations } from '../../src/modules/conversations.ts';
import { docs } from '../../src/modules/docs.ts';
import type { EmbeddingProvider } from '../../src/types.ts';

export const name = 'BrainBank Orchestrator';

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
    const path = `/tmp/brainbank-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    return path;
}

function cleanup(path: string) {
    try { fs.unlinkSync(path); } catch {}
    try { fs.unlinkSync(path + '-wal'); } catch {}
    try { fs.unlinkSync(path + '-shm'); } catch {}
}

export const tests = {
    async 'constructor does not initialize immediately'(assert: any) {
        const db = makeDB();
        const brain = new BrainBank({ dbPath: db, embeddingProvider: new MockEmbedding(), embeddingDims: 16 });
        assert.ok(!brain.isInitialized);
        brain.close();
        cleanup(db);
    },

    async 'initialize creates DB with modules'(assert: any) {
        const db = makeDB();
        const brain = new BrainBank({ dbPath: db, embeddingProvider: new MockEmbedding(), embeddingDims: 16 })
            .use(memory())
            .use(conversations());
        await brain.initialize();
        assert.ok(brain.isInitialized);
        assert.ok(fs.existsSync(db));
        assert.ok(brain.has('memory'));
        assert.ok(brain.has('conversations'));
        brain.close();
        cleanup(db);
    },

    async 'conversations-only mode works'(assert: any) {
        const db = makeDB();
        const brain = new BrainBank({
            dbPath: db,
            embeddingProvider: new MockEmbedding(),
            embeddingDims: 16,
        }).use(conversations());

        await brain.initialize();
        assert.ok(brain.isInitialized);
        assert.ok(brain.has('conversations'));
        assert.ok(!brain.has('code'));
        assert.ok(!brain.has('git'));
        assert.ok(!brain.has('memory'));
        brain.close();
        cleanup(db);
    },

    async 'missing module throws clear error'(assert: any) {
        const db = makeDB();
        const brain = new BrainBank({
            dbPath: db,
            embeddingProvider: new MockEmbedding(),
            embeddingDims: 16,
        }).use(conversations());
        await brain.initialize();

        let threw = false;
        try { await brain.indexCode(); } catch (e: any) {
            threw = true;
            assert.includes(e.message, 'code');
            assert.includes(e.message, 'not loaded');
        }
        assert.ok(threw, 'should throw for missing module');

        brain.close();
        cleanup(db);
    },

    async 'learn and searchPatterns roundtrip'(assert: any) {
        const db = makeDB();
        const brain = new BrainBank({
            dbPath: db,
            embeddingProvider: new MockEmbedding(),
            embeddingDims: 16,
        }).use(memory());
        await brain.initialize();

        const id = await brain.learn({
            taskType: 'api',
            task: 'Add JWT authentication',
            approach: 'Use middleware pattern with token validation',
            successRate: 0.95,
        });
        assert.gt(id, 0);

        const results = await brain.searchPatterns('authentication JWT token');
        assert.gt(results.length, 0);
        assert.includes(results[0].approach, 'middleware');

        brain.close();
        cleanup(db);
    },

    async 'stats only includes loaded modules'(assert: any) {
        const db = makeDB();
        const brain = new BrainBank({
            dbPath: db,
            embeddingProvider: new MockEmbedding(),
            embeddingDims: 16,
        })
            .use(memory())
            .use(conversations());
        await brain.initialize();
        const s = brain.stats();

        assert.ok(!('code' in s), 'should NOT have code stats');
        assert.ok(!('git' in s), 'should NOT have git stats');
        assert.ok('memory' in s, 'should have memory stats');
        assert.ok('conversations' in s, 'should have conversations stats');

        brain.close();
        cleanup(db);
    },

    async 'documents mode: addCollection and searchDocs'(assert: any) {
        const db = makeDB();
        const brain = new BrainBank({
            dbPath: db,
            embeddingProvider: new MockEmbedding(),
            embeddingDims: 16,
        }).use(docs());
        await brain.initialize();

        // Create a temp docs directory
        const docsDir = `/tmp/brainbank-docs-test-${Date.now()}`;
        fs.mkdirSync(docsDir, { recursive: true });
        fs.writeFileSync(`${docsDir}/guide.md`, '# Getting Started\n\nThis is a guide for setting up authentication with JWT tokens.\n\n## Installation\n\nRun npm install jsonwebtoken to get started.');
        fs.writeFileSync(`${docsDir}/api.md`, '# API Reference\n\nThe login endpoint accepts POST requests with email and password.');

        await brain.addCollection({ name: 'docs', path: docsDir, pattern: '**/*.md' });

        const collections = brain.listCollections();
        assert.equal(collections.length, 1);
        assert.equal(collections[0].name, 'docs');

        const result = await brain.indexDocs();
        assert.ok(result.docs, 'should have docs result');
        assert.equal(result.docs.indexed, 2);

        const searchResults = await brain.searchDocs('authentication JWT');
        assert.gt(searchResults.length, 0);
        assert.equal(searchResults[0].type, 'document');

        brain.close();
        cleanup(db);
        fs.rmSync(docsDir, { recursive: true });
    },

    async 'close sets initialized to false'(assert: any) {
        const db = makeDB();
        const brain = new BrainBank({ dbPath: db, embeddingProvider: new MockEmbedding(), embeddingDims: 16 })
            .use(memory());
        await brain.initialize();
        assert.ok(brain.isInitialized);
        brain.close();
        assert.ok(!brain.isInitialized);
        cleanup(db);
    },

    async 'double initialize is idempotent'(assert: any) {
        const db = makeDB();
        const brain = new BrainBank({ dbPath: db, embeddingProvider: new MockEmbedding(), embeddingDims: 16 })
            .use(conversations());
        await brain.initialize();
        await brain.initialize();
        assert.ok(brain.isInitialized);
        brain.close();
        cleanup(db);
    },

    async '.use() is chainable'(assert: any) {
        const db = makeDB();
        const brain = new BrainBank({ dbPath: db, embeddingProvider: new MockEmbedding(), embeddingDims: 16 })
            .use(memory())
            .use(conversations())
            .use(docs());

        assert.deepEqual(brain.modules.sort(), ['conversations', 'docs', 'memory']);

        await brain.initialize();
        brain.close();
        cleanup(db);
    },

    async '.use() after initialize throws'(assert: any) {
        const db = makeDB();
        const brain = new BrainBank({ dbPath: db, embeddingProvider: new MockEmbedding(), embeddingDims: 16 })
            .use(memory());
        await brain.initialize();

        let threw = false;
        try { brain.use(conversations()); } catch (e: any) {
            threw = true;
            assert.includes(e.message, 'after initialization');
        }
        assert.ok(threw, 'should throw when adding module after initialize');

        brain.close();
        cleanup(db);
    },

    async 'no modules still creates DB'(assert: any) {
        const db = makeDB();
        const brain = new BrainBank({ dbPath: db, embeddingProvider: new MockEmbedding(), embeddingDims: 16 });
        await brain.initialize();
        assert.ok(brain.isInitialized);
        assert.ok(fs.existsSync(db));
        assert.deepEqual(brain.modules, []);
        brain.close();
        cleanup(db);
    },
};

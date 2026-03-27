/**
 * Unit Tests — BrainBank Orchestrator
 * 
 * Tests modular initialization with .use() pattern and collections.
 * Uses a mock embedding provider (no model download required).
 */

import * as fs from 'node:fs';
import { BrainBank } from '../../../src/brainbank.ts';
import { docs } from '../../../src/indexers/docs/docs-plugin.ts';
import type { EmbeddingProvider } from '../../../src/types.ts';

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

    async 'initialize creates DB with indexers'(assert: any) {
        const db = makeDB();
        const brain = new BrainBank({ dbPath: db, embeddingProvider: new MockEmbedding(), embeddingDims: 16 })
            .use(docs());
        await brain.initialize();
        assert.ok(brain.isInitialized);
        assert.ok(fs.existsSync(db));
        assert.ok(brain.has('docs'));
        brain.close();
        cleanup(db);
    },

    async 'collection() works after initialize'(assert: any) {
        const db = makeDB();
        const brain = new BrainBank({
            dbPath: db,
            embeddingProvider: new MockEmbedding(),
            embeddingDims: 16,
        });
        await brain.initialize();

        const errors = brain.collection('errors');
        assert.equal(errors.name, 'errors');
        assert.equal(errors.count(), 0);

        const id = await errors.add('Test error message', { type: 'test' });
        assert.gt(id, 0);
        assert.equal(errors.count(), 1);

        const names = brain.listCollectionNames();
        assert.includes(names, 'errors');

        brain.close();
        cleanup(db);
    },

    async 'missing indexer throws clear error'(assert: any) {
        const db = makeDB();
        const brain = new BrainBank({
            dbPath: db,
            embeddingProvider: new MockEmbedding(),
            embeddingDims: 16,
        });
        await brain.initialize();

        let threw = false;
        try { await brain.indexCode(); } catch (e: any) {
            threw = true;
            assert.includes(e.message, 'code');
            assert.includes(e.message, 'not loaded');
        }
        assert.ok(threw, 'should throw for missing indexer');

        brain.close();
        cleanup(db);
    },

    async 'stats only includes loaded indexers'(assert: any) {
        const db = makeDB();
        const brain = new BrainBank({
            dbPath: db,
            embeddingProvider: new MockEmbedding(),
            embeddingDims: 16,
        })
            .use(docs());
        await brain.initialize();
        const s = brain.stats();

        assert.ok(!('code' in s), 'should NOT have code stats');
        assert.ok(!('git' in s), 'should NOT have git stats');
        assert.ok('documents' in s, 'should have docs stats');

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
        const brain = new BrainBank({ dbPath: db, embeddingProvider: new MockEmbedding(), embeddingDims: 16 });
        await brain.initialize();
        assert.ok(brain.isInitialized);
        brain.close();
        assert.ok(!brain.isInitialized);
        cleanup(db);
    },

    async 'double initialize is idempotent'(assert: any) {
        const db = makeDB();
        const brain = new BrainBank({ dbPath: db, embeddingProvider: new MockEmbedding(), embeddingDims: 16 });
        await brain.initialize();
        await brain.initialize();
        assert.ok(brain.isInitialized);
        brain.close();
        cleanup(db);
    },

    async '.use() is chainable'(assert: any) {
        const db = makeDB();
        const brain = new BrainBank({ dbPath: db, embeddingProvider: new MockEmbedding(), embeddingDims: 16 })
            .use(docs());

        assert.deepEqual(brain.plugins.sort(), ['docs']);

        await brain.initialize();
        brain.close();
        cleanup(db);
    },

    async '.use() after initialize throws'(assert: any) {
        const db = makeDB();
        const brain = new BrainBank({ dbPath: db, embeddingProvider: new MockEmbedding(), embeddingDims: 16 });
        await brain.initialize();

        let threw = false;
        try { brain.use(docs()); } catch (e: any) {
            threw = true;
            assert.includes(e.message, 'after initialization');
        }
        assert.ok(threw, 'should throw when adding indexer after initialize');

        brain.close();
        cleanup(db);
    },

    async 'no indexers still creates DB'(assert: any) {
        const db = makeDB();
        const brain = new BrainBank({ dbPath: db, embeddingProvider: new MockEmbedding(), embeddingDims: 16 });
        await brain.initialize();
        assert.ok(brain.isInitialized);
        assert.ok(fs.existsSync(db));
        assert.deepEqual(brain.plugins, []);
        brain.close();
        cleanup(db);
    },

    async 'indexer() resolves by name'(assert: any) {
        const db = makeDB();
        const brain = new BrainBank({ dbPath: db, embeddingProvider: new MockEmbedding(), embeddingDims: 16 })
            .use(docs());
        await brain.initialize();

        // .indexers returns registered names
        assert.deepEqual(brain.plugins, ['docs']);
        // .has() and .plugin() work
        assert.ok(brain.has('docs'));
        assert.ok(brain.plugin('docs'));

        brain.close();
        cleanup(db);
    },

    async 'index({ modules: ["docs"] }) only indexes docs'(assert: any) {
        const db = makeDB();
        const brain = new BrainBank({ dbPath: db, embeddingProvider: new MockEmbedding(), embeddingDims: 16 })
            .use(docs());
        await brain.initialize();

        // Create temp docs
        const docsDir = `/tmp/brainbank-modules-test-${Date.now()}`;
        fs.mkdirSync(docsDir, { recursive: true });
        fs.writeFileSync(`${docsDir}/test.md`, '# Test\n\nSome content for testing modules filter.');

        await brain.addCollection({ name: 'test-docs', path: docsDir, pattern: '**/*.md' });

        const result = await brain.index({ modules: ['docs'] });

        // Should have docs but NOT code or git (no code/git indexers loaded)
        assert.ok(result.docs, 'should have docs result');
        assert.ok(!result.code, 'should NOT have code result');
        assert.ok(!result.git, 'should NOT have git result');
        assert.ok(result.docs!['test-docs'], 'should have test-docs collection');
        assert.equal(result.docs!['test-docs'].indexed, 1);

        brain.close();
        cleanup(db);
        fs.rmSync(docsDir, { recursive: true });
    },

    async 'index({ modules: ["code"] }) skips docs even if loaded'(assert: any) {
        const db = makeDB();
        const brain = new BrainBank({ dbPath: db, embeddingProvider: new MockEmbedding(), embeddingDims: 16 })
            .use(docs());
        await brain.initialize();

        const docsDir = `/tmp/brainbank-skip-test-${Date.now()}`;
        fs.mkdirSync(docsDir, { recursive: true });
        fs.writeFileSync(`${docsDir}/skip.md`, '# Skip\n\nThis should not be indexed.');

        await brain.addCollection({ name: 'skip-docs', path: docsDir, pattern: '**/*.md' });

        const result = await brain.index({ modules: ['code'] });

        // code indexer not loaded so result.code is undefined, but docs should also be undefined
        assert.ok(!result.code, 'no code indexer loaded');
        assert.ok(!result.docs, 'docs should be skipped with modules: ["code"]');
        assert.ok(!result.git, 'git should be skipped');

        brain.close();
        cleanup(db);
        fs.rmSync(docsDir, { recursive: true });
    },

    async 'index() with no modules param indexes everything available'(assert: any) {
        const db = makeDB();
        const brain = new BrainBank({ dbPath: db, embeddingProvider: new MockEmbedding(), embeddingDims: 16 })
            .use(docs());
        await brain.initialize();

        const docsDir = `/tmp/brainbank-all-test-${Date.now()}`;
        fs.mkdirSync(docsDir, { recursive: true });
        fs.writeFileSync(`${docsDir}/all.md`, '# All\n\nDefault should index this.');

        await brain.addCollection({ name: 'all-docs', path: docsDir, pattern: '**/*.md' });

        const result = await brain.index();

        // Only docs loaded, so only docs should have results
        assert.ok(result.docs, 'should have docs result with default modules');
        assert.ok(result.docs!['all-docs'], 'should have all-docs collection');
        assert.equal(result.docs!['all-docs'].indexed, 1);

        brain.close();
        cleanup(db);
        fs.rmSync(docsDir, { recursive: true });
    },

    async 'listCollectionNames() before init throws'(assert: any) {
        const db = makeDB();
        const brain = new BrainBank({ dbPath: db, embeddingProvider: new MockEmbedding(), embeddingDims: 16 });

        let threw = false;
        try { brain.listCollectionNames(); } catch (e: any) {
            threw = true;
            assert.includes(e.message, 'Not initialized');
        }
        assert.ok(threw, 'should throw before initialization');

        brain.close();
        cleanup(db);
    },

    async 'stats() before init throws'(assert: any) {
        const db = makeDB();
        const brain = new BrainBank({ dbPath: db, embeddingProvider: new MockEmbedding(), embeddingDims: 16 });

        let threw = false;
        try { brain.stats(); } catch (e: any) {
            threw = true;
            assert.includes(e.message, 'Not initialized');
        }
        assert.ok(threw, 'should throw before initialization');

        brain.close();
        cleanup(db);
    },

    async 'listCollections() before init throws'(assert: any) {
        const db = makeDB();
        const brain = new BrainBank({ dbPath: db, embeddingProvider: new MockEmbedding(), embeddingDims: 16 })
            .use(docs());

        let threw = false;
        try { brain.listCollections(); } catch (e: any) {
            threw = true;
            assert.includes(e.message, 'Not initialized');
        }
        assert.ok(threw, 'should throw before initialization');

        brain.close();
        cleanup(db);
    },

    async 'per-plugin embeddingProvider override works'(assert: any) {
        const db = makeDB();

        // Different-dimension mock (32d instead of 16d)
        class Mock32 implements EmbeddingProvider {
            readonly dims = 32;
            async embed(text: string): Promise<Float32Array> {
                const v = new Float32Array(32);
                for (let i = 0; i < 32; i++) {
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

        const perPluginEmbed = new Mock32();
        const brain = new BrainBank({
            dbPath: db,
            embeddingProvider: new MockEmbedding(),  // global: 16d
            embeddingDims: 16,
        }).use(docs({ embeddingProvider: perPluginEmbed })); // docs: 32d

        await brain.initialize();

        // Create temp docs
        const docsDir = `/tmp/brainbank-perplugin-${Date.now()}`;
        fs.mkdirSync(docsDir, { recursive: true });
        fs.writeFileSync(`${docsDir}/test.md`, '# Per-Plugin Test\n\nThis document tests per-plugin embedding overrides with different dimensions.');

        await brain.addCollection({ name: 'test', path: docsDir, pattern: '**/*.md' });
        const result = await brain.indexDocs();
        assert.ok(result.test, 'should have indexed test collection');
        assert.equal(result.test.indexed, 1);

        // Search should work through the per-plugin 32d embedding
        const hits = await brain.searchDocs('per-plugin embedding');
        assert.gt(hits.length, 0, 'should find results with per-plugin embedding');

        brain.close();
        cleanup(db);
        fs.rmSync(docsDir, { recursive: true });
    },
};

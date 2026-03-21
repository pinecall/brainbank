/**
 * Unit Tests — BrainBank Orchestrator
 * 
 * Uses a mock embedding provider (no model download required).
 */

import * as fs from 'node:fs';
import { BrainBank } from '../../src/core/brainbank.ts';
import type { EmbeddingProvider } from '../../src/types.ts';

export const name = 'BrainBank Orchestrator';

const TEST_DB = '/tmp/brainbank-test-main.db';

/** Deterministic mock embeddings — no model needed. */
class MockEmbedding implements EmbeddingProvider {
    readonly dims = 16;

    async embed(text: string): Promise<Float32Array> {
        const v = new Float32Array(16);
        for (let i = 0; i < 16; i++) {
            v[i] = Math.sin((text.charCodeAt(i % text.length) || 0) * (i + 1));
        }
        // Normalize
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

function cleanup() {
    try { fs.unlinkSync(TEST_DB); } catch {}
    try { fs.unlinkSync(TEST_DB + '-wal'); } catch {}
    try { fs.unlinkSync(TEST_DB + '-shm'); } catch {}
}

export const tests = {
    async 'constructor does not initialize immediately'(assert: any) {
        cleanup();
        const brain = new BrainBank({
            dbPath: TEST_DB,
            embeddingProvider: new MockEmbedding(),
            embeddingDims: 16,
        });
        assert.ok(!brain.isInitialized, 'should not be initialized yet');
        brain.close();
    },

    async 'initialize creates DB and indices'(assert: any) {
        cleanup();
        const brain = new BrainBank({
            dbPath: TEST_DB,
            embeddingProvider: new MockEmbedding(),
            embeddingDims: 16,
        });
        await brain.initialize();
        assert.ok(brain.isInitialized, 'should be initialized');
        assert.ok(fs.existsSync(TEST_DB), 'DB file should exist');
        brain.close();
    },

    async 'stats returns correct structure'(assert: any) {
        cleanup();
        const brain = new BrainBank({
            dbPath: TEST_DB,
            embeddingProvider: new MockEmbedding(),
            embeddingDims: 16,
        });
        await brain.initialize();
        const s = brain.stats();

        assert.ok('code' in s, 'should have code stats');
        assert.ok('git' in s, 'should have git stats');
        assert.ok('memory' in s, 'should have memory stats');
        assert.equal(s.code.files, 0);
        assert.equal(s.code.chunks, 0);
        assert.equal(s.git.commits, 0);
        assert.equal(s.memory.patterns, 0);
        brain.close();
    },

    async 'learn and searchPatterns roundtrip'(assert: any) {
        cleanup();
        const brain = new BrainBank({
            dbPath: TEST_DB,
            embeddingProvider: new MockEmbedding(),
            embeddingDims: 16,
        });
        await brain.initialize();

        const id = await brain.learn({
            taskType: 'api',
            task: 'Add JWT authentication',
            approach: 'Use middleware pattern with token validation',
            successRate: 0.95,
        });

        assert.gt(id, 0, 'should return positive ID');

        const results = await brain.searchPatterns('authentication JWT token');
        assert.gt(results.length, 0, 'should find the learned pattern');
        assert.includes(results[0].approach, 'middleware');
        brain.close();
    },

    async 'close sets initialized to false'(assert: any) {
        cleanup();
        const brain = new BrainBank({
            dbPath: TEST_DB,
            embeddingProvider: new MockEmbedding(),
            embeddingDims: 16,
        });
        await brain.initialize();
        assert.ok(brain.isInitialized);
        brain.close();
        assert.ok(!brain.isInitialized);
    },

    async 'config is accessible and readonly'(assert: any) {
        cleanup();
        const brain = new BrainBank({
            repoPath: '/my/repo',
            dbPath: TEST_DB,
            embeddingProvider: new MockEmbedding(),
            embeddingDims: 16,
        });
        assert.equal(brain.config.repoPath, '/my/repo');
        assert.equal(brain.config.dbPath, TEST_DB);
        brain.close();
    },

    async 'double initialize is idempotent'(assert: any) {
        cleanup();
        const brain = new BrainBank({
            dbPath: TEST_DB,
            embeddingProvider: new MockEmbedding(),
            embeddingDims: 16,
        });
        await brain.initialize();
        await brain.initialize(); // second call should not throw
        assert.ok(brain.isInitialized);
        brain.close();
    },
};

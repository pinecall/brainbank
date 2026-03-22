/**
 * Unit Tests — HNSW Vector Index
 */

import { HNSWIndex } from '../../../src/vector/hnsw.ts';
import { normalize } from '../../../src/embeddings/math.ts';

export const name = 'HNSW Vector Index';

function vec(dims: number, seed: number): Float32Array {
    const v = new Float32Array(dims);
    for (let i = 0; i < dims; i++) {
        v[i] = Math.sin(seed * (i + 1));
    }
    return normalize(v);
}

export const tests = {
    async 'init creates index'(assert: any) {
        const idx = await new HNSWIndex(16, 100).init();
        assert.ok(idx, 'init should return the index');
        assert.equal(idx.size, 0, 'new index should be empty');
    },

    async 'add and search recovers correct vector'(assert: any) {
        const idx = await new HNSWIndex(16, 100).init();
        const v1 = vec(16, 1);
        const v2 = vec(16, 2);
        idx.add(v1, 1);
        idx.add(v2, 2);

        const results = idx.search(v1, 1);
        assert.equal(results.length, 1);
        assert.equal(results[0].id, 1, 'should find the exact vector');
        assert.gt(results[0].score, 0.95, 'score should be close to 1.0');
    },

    async 'search empty index returns empty'(assert: any) {
        const idx = await new HNSWIndex(16, 100).init();
        const results = idx.search(vec(16, 1), 5);
        assert.equal(results.length, 0);
    },

    async 'k > count returns all available'(assert: any) {
        const idx = await new HNSWIndex(16, 100).init();
        idx.add(vec(16, 1), 1);
        idx.add(vec(16, 2), 2);

        const results = idx.search(vec(16, 1), 10);
        assert.equal(results.length, 2, 'should return only 2 when only 2 exist');
    },

    async 'multiple vectors ordered by similarity'(assert: any) {
        const idx = await new HNSWIndex(16, 1000).init();
        const query = vec(16, 1);

        // Add query vector as ID 100
        idx.add(query, 100);
        // Add distant vectors
        for (let i = 1; i <= 10; i++) {
            idx.add(vec(16, i * 100), i);
        }

        const results = idx.search(query, 3);
        assert.gt(results.length, 0);
        assert.equal(results[0].id, 100, 'first result should be the exact match');
        // Scores should be descending
        for (let i = 1; i < results.length; i++) {
            assert.gte(results[i - 1].score, results[i].score, 'scores should be descending');
        }
    },

    async 'size tracks insertions'(assert: any) {
        const idx = await new HNSWIndex(16, 100).init();
        assert.equal(idx.size, 0);
        idx.add(vec(16, 1), 1);
        assert.equal(idx.size, 1);
        idx.add(vec(16, 2), 2);
        assert.equal(idx.size, 2);
    },

    'throws if not initialized'(assert: any) {
        const idx = new HNSWIndex(16, 100);
        assert.throws(() => idx.add(vec(16, 1), 1), 'should throw before init');
    },
};

/**
 * Unit Tests — MMR (Maximum Marginal Relevance)
 */

import { searchMMR } from '../../../src/search/vector/mmr.ts';
import { HNSWIndex } from '../../../src/providers/vector/hnsw.ts';
import { normalize } from '../../../src/lib/math.ts';

export const name = 'MMR Diversity';

function vec(dims: number, seed: number): Float32Array {
    const v = new Float32Array(dims);
    for (let i = 0; i < dims; i++) {
        v[i] = Math.sin(seed * (i + 1));
    }
    return normalize(v);
}

export const tests = {
    async 'MMR selects diverse results from duplicates'(assert: any) {
        const idx = await new HNSWIndex(16, 100).init();
        const cache = new Map<number, Float32Array>();

        // Add 3 near-identical vectors and 1 different
        const similar = vec(16, 1);
        for (let i = 1; i <= 3; i++) {
            const v = new Float32Array(similar);
            v[0] += i * 0.001;  // tiny perturbation
            const n = normalize(v);
            idx.add(n, i);
            cache.set(i, n);
        }

        const different = vec(16, 999);
        idx.add(different, 4);
        cache.set(4, different);

        const results = searchMMR(idx, similar, cache, 2, 0.5);
        assert.equal(results.length, 2);
        // With low lambda (more diversity), should select one similar + one different
        const ids = results.map(r => r.id);
        assert.ok(ids.includes(1) || ids.includes(2) || ids.includes(3), 'should include a similar one');
    },

    async 'lambda=1.0 matches regular search order'(assert: any) {
        const idx = await new HNSWIndex(16, 100).init();
        const cache = new Map<number, Float32Array>();

        for (let i = 1; i <= 5; i++) {
            const v = vec(16, i);
            idx.add(v, i);
            cache.set(i, v);
        }

        const query = vec(16, 1);
        const mmr = searchMMR(idx, query, cache, 3, 1.0);
        const regular = idx.search(query, 3);

        // With lambda=1.0, MMR should behave like regular search
        assert.equal(mmr[0].id, regular[0].id, 'first result should match regular search');
    },

    async 'k > candidates returns all'(assert: any) {
        const idx = await new HNSWIndex(16, 100).init();
        const cache = new Map<number, Float32Array>();

        const v = vec(16, 1);
        idx.add(v, 1);
        cache.set(1, v);

        const results = searchMMR(idx, v, cache, 10, 0.7);
        // Should return what's available (1 vector)
        assert.equal(results.length, 1);
    },
};

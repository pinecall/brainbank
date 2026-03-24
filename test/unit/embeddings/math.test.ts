/**
 * Unit Tests — Math Utilities
 */

import { cosineSimilarity, cosineSimilarityFull, normalize, euclideanDistance } from '../../../src/lib/math.ts';

export const name = 'Math Utilities';

export const tests = {
    'cosineSimilarity of identical normalized vectors is 1.0'(assert: any) {
        const v = normalize(new Float32Array([1, 2, 3]));
        const sim = cosineSimilarity(v, v);
        assert.gt(sim, 0.999, 'identical vectors should have sim ~1.0');
    },

    'cosineSimilarity of orthogonal vectors is 0.0'(assert: any) {
        const a = normalize(new Float32Array([1, 0, 0]));
        const b = normalize(new Float32Array([0, 1, 0]));
        const sim = cosineSimilarity(a, b);
        assert.lt(Math.abs(sim), 0.001, 'orthogonal vectors should have sim ~0');
    },

    'cosineSimilarity of opposite vectors is -1.0'(assert: any) {
        const a = normalize(new Float32Array([1, 0, 0]));
        const b = normalize(new Float32Array([-1, 0, 0]));
        const sim = cosineSimilarity(a, b);
        assert.lt(sim, -0.999, 'opposite vectors should have sim ~-1.0');
    },

    'cosineSimilarityFull handles unnormalized vectors'(assert: any) {
        const a = new Float32Array([3, 0, 0]);
        const b = new Float32Array([5, 0, 0]);
        const sim = cosineSimilarityFull(a, b);
        assert.gt(sim, 0.999, 'parallel vectors of different magnitude should have sim ~1.0');
    },

    'normalize produces unit vector'(assert: any) {
        const v = new Float32Array([3, 4, 0]);
        const n = normalize(v);
        // Magnitude should be ~1.0
        let mag = 0;
        for (let i = 0; i < n.length; i++) mag += n[i] * n[i];
        assert.gt(Math.sqrt(mag), 0.999);
        assert.lt(Math.sqrt(mag), 1.001);
    },

    'normalize of zero vector returns zero vector'(assert: any) {
        const n = normalize(new Float32Array([0, 0, 0]));
        assert.equal(n[0], 0);
        assert.equal(n[1], 0);
        assert.equal(n[2], 0);
    },

    'euclideanDistance of same vector is 0'(assert: any) {
        const v = new Float32Array([1, 2, 3]);
        assert.lt(euclideanDistance(v, v), 0.001);
    },

    'euclideanDistance is correct for known values'(assert: any) {
        const a = new Float32Array([0, 0]);
        const b = new Float32Array([3, 4]);
        const dist = euclideanDistance(a, b);
        assert.equal(Math.round(dist), 5);
    },

    'dimension mismatch throws'(assert: any) {
        assert.throws(() => {
            cosineSimilarity(new Float32Array([1, 2]), new Float32Array([1, 2, 3]));
        }, 'should throw on dimension mismatch');
    },

    'empty vector cosineSimilarity returns 0'(assert: any) {
        const a = new Float32Array([]);
        const b = new Float32Array([]);
        assert.equal(cosineSimilarity(a, b), 0);
    },
};

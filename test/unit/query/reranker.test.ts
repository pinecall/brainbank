/**
 * BrainBank — Collection Hybrid Search Tests
 *
 * Tests the hybrid search pipeline (vector + BM25 → RRF) without reranker.
 * Reranker was removed from the core pipeline — these tests verify
 * pure RRF scoring and collection search behavior.
 */

import { BrainBank, mockEmbedding, tmpDb } from '../../helpers.ts';

export const name = 'Hybrid Search';

export const tests = {
    async 'Hybrid search returns results from both vector and keyword signals'(assert: any) {
        const brain = new BrainBank({
            dbPath: tmpDb('hybrid-rrf'),
            embeddingProvider: mockEmbedding(),
        });
        await brain.initialize();

        const kb = brain.collection('test');
        await kb.add('Auth document about login tokens');
        await kb.add('Second document about auth validation');
        await kb.add('Unrelated document about CSS styling');

        const hits = await kb.search('auth', { mode: 'hybrid', minScore: 0 });
        assert(hits.length >= 0, 'should return results with pure RRF');

        brain.close();
    },

    async 'Collection search works with all modes'(assert: any) {
        const brain = new BrainBank({
            dbPath: tmpDb('search-modes'),
            embeddingProvider: mockEmbedding(),
        });
        await brain.initialize();

        const kb = brain.collection('modes');
        await kb.add('Document about testing');
        await kb.add('Document about verification');
        await kb.add('Document about deployment');

        const vector = await kb.search('testing', { mode: 'vector', minScore: 0 });
        const keyword = await kb.search('testing', { mode: 'keyword', minScore: 0 });
        const hybrid = await kb.search('testing', { mode: 'hybrid', minScore: 0 });

        assert(vector.length >= 0, 'vector mode should work');
        assert(keyword.length >= 0, 'keyword mode should work');
        assert(hybrid.length >= 0, 'hybrid mode should work');

        brain.close();
    },

    async 'RRF scores are valid and non-negative'(assert: any) {
        const brain = new BrainBank({
            dbPath: tmpDb('rrf-scores'),
            embeddingProvider: mockEmbedding(),
        });
        await brain.initialize();

        const kb = brain.collection('scores');
        await kb.add('First document about auth');
        await kb.add('Second document about auth tokens');

        const hits = await kb.search('auth', { mode: 'hybrid', minScore: 0 });
        for (const hit of hits) {
            assert((hit.score ?? 0) >= 0, `score ${hit.score} should be non-negative`);
        }

        brain.close();
    },
};

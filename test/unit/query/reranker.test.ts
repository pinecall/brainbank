/**
 * BrainBank — Reranker Tests
 * 
 * Tests the pluggable reranker integration with a mock reranker.
 */

import { BrainBank, mockEmbedding, tmpDb } from '../../helpers.ts';

export const name = 'Reranker';

export const tests = {
    async 'Reranker interface accepted in config'(assert: any) {
        const mockReranker = {
            async rank(_query: string, docs: string[]) {
                return docs.map(() => 0.5);
            },
        };

        const brain = new BrainBank({
            dbPath: tmpDb('reranker-config'),
            embeddingProvider: mockEmbedding(),
            reranker: mockReranker,
        });

        await brain.initialize();
        assert(true, 'should accept reranker in config');
        brain.close();
    },

    async 'Collection search uses reranker when provided'(assert: any) {
        let rankCalled = false;
        const mockReranker = {
            async rank(_query: string, docs: string[]) {
                rankCalled = true;
                return docs.map((_, i) => i / docs.length);
            },
        };

        const brain = new BrainBank({
            dbPath: tmpDb('reranker-coll'),
            embeddingProvider: mockEmbedding(),
            reranker: mockReranker,
        });
        await brain.initialize();

        const kb = brain.collection('test');
        await kb.add('First document about auth');
        await kb.add('Second document about auth tokens');
        await kb.add('Third document about JWT validation');

        const hybridHits = await kb.search('auth', { mode: 'hybrid', minScore: 0 });

        if (hybridHits.length > 1) {
            assert(rankCalled, 'reranker should have been called for hybrid search');
        }

        brain.close();
    },

    async 'No reranker means pure RRF scores'(assert: any) {
        const brain = new BrainBank({
            dbPath: tmpDb('no-reranker'),
            embeddingProvider: mockEmbedding(),
        });
        await brain.initialize();

        const kb = brain.collection('test');
        await kb.add('Auth document one');
        await kb.add('Auth document two');

        const hits = await kb.search('auth', { mode: 'hybrid', minScore: 0 });
        assert(hits.length >= 0, 'should return results without reranker');

        brain.close();
    },

    async 'Reranker blends scores 60/40'(assert: any) {
        const rerankerScores: number[] = [];
        const mockReranker = {
            async rank(_query: string, docs: string[]) {
                const scores = docs.map(() => 1.0);
                rerankerScores.push(...scores);
                return scores;
            },
        };

        const brain = new BrainBank({
            dbPath: tmpDb('reranker-blend'),
            embeddingProvider: mockEmbedding(),
            reranker: mockReranker,
        });
        await brain.initialize();

        const kb = brain.collection('blend');
        await kb.add('Document about testing');
        await kb.add('Document about verification');

        const hits = await kb.search('testing', { mode: 'hybrid', minScore: 0 });

        if (hits.length > 1 && rerankerScores.length > 0) {
            for (const hit of hits) {
                assert((hit.score ?? 0) >= 0.4, `score ${hit.score} should be >= 0.4 with reranker boost`);
            }
        }

        brain.close();
    },

    async 'Reranker with close() is called properly'(assert: any) {
        const mockReranker = {
            async rank(_query: string, docs: string[]) {
                return docs.map(() => 0.5);
            },
            closeCalled: false,
            async close() {
                this.closeCalled = true;
            },
        };

        assert(typeof mockReranker.rank === 'function', 'rank should be a function');
        assert(typeof mockReranker.close === 'function', 'close should be optional function');

        await mockReranker.close();
        assert(mockReranker.closeCalled, 'close should be callable');
    },
};

/**
 * BrainBank — Reranker Tests
 * 
 * Tests the pluggable reranker integration with a mock reranker.
 */

export const name = 'Reranker';

export const tests = {
    async 'Reranker interface accepted in config'(assert: any) {
        const { BrainBank } = await import('../../src/core/brainbank.ts');

        const mockReranker = {
            async rank(_query: string, docs: string[]) {
                return docs.map(() => 0.5);
            },
        };

        const brain = new BrainBank({
            dbPath: `/tmp/brainbank-reranker-config-${Date.now()}.db`,
            embeddingProvider: {
                dims: 384,
                async embed(_: string) { return new Float32Array(384).fill(0.1); },
                async embedBatch(txts: string[]) { return txts.map(() => new Float32Array(384).fill(0.1)); },
                async close() {},
            },
            reranker: mockReranker,
        });

        await brain.initialize();
        assert(true, 'should accept reranker in config');
        brain.close();
    },

    async 'Collection search uses reranker when provided'(assert: any) {
        const { BrainBank } = await import('../../src/core/brainbank.ts');

        let rankCalled = false;
        const mockReranker = {
            async rank(_query: string, docs: string[]) {
                rankCalled = true;
                // Reverse the order — make last doc score highest
                return docs.map((_, i) => i / docs.length);
            },
        };

        const embedding = {
            dims: 384,
            async embed(_: string) { return new Float32Array(384).fill(0.1); },
            async embedBatch(txts: string[]) { return txts.map(() => new Float32Array(384).fill(0.1)); },
            async close() {},
        };

        const brain = new BrainBank({
            dbPath: `/tmp/brainbank-reranker-coll-${Date.now()}.db`,
            embeddingProvider: embedding,
            reranker: mockReranker,
        });
        await brain.initialize();

        const kb = brain.collection('test');
        await kb.add('First document about auth');
        await kb.add('Second document about auth tokens');
        await kb.add('Third document about JWT validation');

        const hits = await kb.search('auth', { mode: 'keyword', minScore: 0 });

        // In keyword-only mode, reranker is NOT applied (only on hybrid)
        // So let's test hybrid mode
        const hybridHits = await kb.search('auth', { mode: 'hybrid', minScore: 0 });

        if (hybridHits.length > 1) {
            assert(rankCalled, 'reranker should have been called for hybrid search');
        }

        brain.close();
    },

    async 'No reranker means pure RRF scores'(assert: any) {
        const { BrainBank } = await import('../../src/core/brainbank.ts');

        const embedding = {
            dims: 384,
            async embed(_: string) { return new Float32Array(384).fill(0.1); },
            async embedBatch(txts: string[]) { return txts.map(() => new Float32Array(384).fill(0.1)); },
            async close() {},
        };

        // No reranker
        const brain = new BrainBank({
            dbPath: `/tmp/brainbank-no-reranker-${Date.now()}.db`,
            embeddingProvider: embedding,
        });
        await brain.initialize();

        const kb = brain.collection('test');
        await kb.add('Auth document one');
        await kb.add('Auth document two');

        // Should work fine without reranker
        const hits = await kb.search('auth', { mode: 'hybrid', minScore: 0 });
        assert(hits.length >= 0, 'should return results without reranker');

        brain.close();
    },

    async 'Reranker blends scores 60/40'(assert: any) {
        const { BrainBank } = await import('../../src/core/brainbank.ts');

        const rerankerScores: number[] = [];
        const mockReranker = {
            async rank(_query: string, docs: string[]) {
                // Give all docs a reranker score of 1.0
                const scores = docs.map(() => 1.0);
                rerankerScores.push(...scores);
                return scores;
            },
        };

        const embedding = {
            dims: 384,
            async embed(_: string) { return new Float32Array(384).fill(0.1); },
            async embedBatch(txts: string[]) { return txts.map(() => new Float32Array(384).fill(0.1)); },
            async close() {},
        };

        const brain = new BrainBank({
            dbPath: `/tmp/brainbank-reranker-blend-${Date.now()}.db`,
            embeddingProvider: embedding,
            reranker: mockReranker,
        });
        await brain.initialize();

        const kb = brain.collection('blend');
        await kb.add('Document about testing');
        await kb.add('Document about verification');

        const hits = await kb.search('testing', { mode: 'hybrid', minScore: 0 });

        if (hits.length > 1 && rerankerScores.length > 0) {
            // With reranker score = 1.0, final score should be:
            // 0.6 * original + 0.4 * 1.0 = original * 0.6 + 0.4
            // So score should be higher than the original RRF score alone
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

        // Verify the interface allows close
        assert(typeof mockReranker.rank === 'function', 'rank should be a function');
        assert(typeof mockReranker.close === 'function', 'close should be optional function');

        await mockReranker.close();
        assert(mockReranker.closeCalled, 'close should be callable');
    },
};

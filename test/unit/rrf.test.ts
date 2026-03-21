/**
 * BrainBank — Reciprocal Rank Fusion Tests
 */

import { reciprocalRankFusion } from '../../src/query/rrf.ts';

export const name = 'Reciprocal Rank Fusion';

export const tests = {
    'fuses two ranked lists correctly'(assert: any) {
        const vectorResults = [
            { type: 'code' as const, score: 0.95, content: 'auth.ts', filePath: 'src/auth.ts', metadata: { startLine: 1, endLine: 20 } },
            { type: 'code' as const, score: 0.80, content: 'user.ts', filePath: 'src/user.ts', metadata: { startLine: 1, endLine: 15 } },
        ];

        const bm25Results = [
            { type: 'code' as const, score: 0.90, content: 'auth.ts', filePath: 'src/auth.ts', metadata: { startLine: 1, endLine: 20 } },
            { type: 'code' as const, score: 0.70, content: 'middleware.ts', filePath: 'src/middleware.ts', metadata: { startLine: 1, endLine: 10 } },
        ];

        const fused = reciprocalRankFusion([vectorResults, bm25Results]);

        // auth.ts appears in both lists → should have highest RRF score
        assert.equal(fused[0].filePath, 'src/auth.ts');
        assert.equal(fused.length, 3);
    },

    'deduplicates across search systems'(assert: any) {
        const list1 = [
            { type: 'commit' as const, score: 0.9, content: 'fix auth', metadata: { hash: 'abc123', shortHash: 'abc' } },
        ];
        const list2 = [
            { type: 'commit' as const, score: 0.8, content: 'fix auth', metadata: { hash: 'abc123', shortHash: 'abc' } },
        ];

        const fused = reciprocalRankFusion([list1, list2]);
        assert.equal(fused.length, 1);
        assert.equal(fused[0].score, 1.0);
    },

    'respects maxResults limit'(assert: any) {
        const big = Array.from({ length: 20 }, (_, i) => ({
            type: 'code' as const,
            score: 1 - i * 0.05,
            content: `file${i}.ts`,
            filePath: `src/file${i}.ts`,
            metadata: { startLine: 1, endLine: 10 },
        }));

        const fused = reciprocalRankFusion([big], 60, 5);
        assert.equal(fused.length, 5);
    },

    'handles empty input'(assert: any) {
        const fused = reciprocalRankFusion([]);
        assert.equal(fused.length, 0);

        const fused2 = reciprocalRankFusion([[], []]);
        assert.equal(fused2.length, 0);
    },

    'items in multiple lists rank higher'(assert: any) {
        const shared = { type: 'code' as const, score: 0.5, content: 'shared.ts', filePath: 'src/shared.ts', metadata: { startLine: 1, endLine: 5 } };
        const unique1 = { type: 'code' as const, score: 0.99, content: 'unique1.ts', filePath: 'src/unique1.ts', metadata: { startLine: 1, endLine: 5 } };
        const unique2 = { type: 'code' as const, score: 0.99, content: 'unique2.ts', filePath: 'src/unique2.ts', metadata: { startLine: 1, endLine: 5 } };

        const fused = reciprocalRankFusion([
            [unique1, shared],  // shared is rank 2 in list 1
            [unique2, shared],  // shared is rank 2 in list 2
        ]);

        // shared appears in both lists → RRF boosts it: 2 × 1/(k+2) > 1 × 1/(k+1)
        assert.equal(fused[0].filePath, 'src/shared.ts');
    },
};

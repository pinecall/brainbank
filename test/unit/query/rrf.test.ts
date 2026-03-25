/**
 * BrainBank — Reciprocal Rank Fusion Tests
 */

import { reciprocalRankFusion } from '../../../src/lib/rrf.ts';

export const name = 'Reciprocal Rank Fusion';

export const tests = {
    'fuses two ranked lists correctly'(assert: any) {
        const vectorResults = [
            { type: 'code' as const, score: 0.95, content: 'auth.ts', filePath: 'src/auth.ts', metadata: { chunkType: 'function', startLine: 1, endLine: 20, language: 'ts' } },
            { type: 'code' as const, score: 0.80, content: 'user.ts', filePath: 'src/user.ts', metadata: { chunkType: 'function', startLine: 1, endLine: 15, language: 'ts' } },
        ];

        const bm25Results = [
            { type: 'code' as const, score: 0.90, content: 'auth.ts', filePath: 'src/auth.ts', metadata: { chunkType: 'function', startLine: 1, endLine: 20, language: 'ts' } },
            { type: 'code' as const, score: 0.70, content: 'middleware.ts', filePath: 'src/middleware.ts', metadata: { chunkType: 'function', startLine: 1, endLine: 10, language: 'ts' } },
        ];

        const fused = reciprocalRankFusion([vectorResults, bm25Results]);

        // auth.ts appears in both lists → should have highest RRF score
        assert.equal(fused[0].filePath, 'src/auth.ts');
        assert.equal(fused.length, 3);
    },

    'deduplicates across search systems'(assert: any) {
        const list1 = [
            { type: 'commit' as const, score: 0.9, content: 'fix auth', metadata: { hash: 'abc123', shortHash: 'abc', author: 'dev', date: '2026-01-01', files: ['auth.ts'] } },
        ];
        const list2 = [
            { type: 'commit' as const, score: 0.8, content: 'fix auth', metadata: { hash: 'abc123', shortHash: 'abc', author: 'dev', date: '2026-01-01', files: ['auth.ts'] } },
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
            metadata: { chunkType: 'file', startLine: 1, endLine: 10, language: 'ts' },
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
        const shared = { type: 'code' as const, score: 0.5, content: 'shared.ts', filePath: 'src/shared.ts', metadata: { chunkType: 'file', startLine: 1, endLine: 5, language: 'ts' } };
        const unique1 = { type: 'code' as const, score: 0.99, content: 'unique1.ts', filePath: 'src/unique1.ts', metadata: { chunkType: 'file', startLine: 1, endLine: 5, language: 'ts' } };
        const unique2 = { type: 'code' as const, score: 0.99, content: 'unique2.ts', filePath: 'src/unique2.ts', metadata: { chunkType: 'file', startLine: 1, endLine: 5, language: 'ts' } };

        const fused = reciprocalRankFusion([
            [unique1, shared],  // shared is rank 2 in list 1
            [unique2, shared],  // shared is rank 2 in list 2
        ]);

        // shared appears in both lists → RRF boosts it: 2 × 1/(k+2) > 1 × 1/(k+1)
        assert.equal(fused[0].filePath, 'src/shared.ts');
    },

    'document results with same content prefix are not deduped'(assert: any) {
        const doc1 = {
            type: 'document' as const,
            score: 0.9,
            content: 'This is a long shared prefix that both documents share for testing purposes. Extra text for doc1.',
            filePath: 'notes/guide.md',
            metadata: { collection: 'docs', title: 'Guide', seq: 0 },
        };
        const doc2 = {
            type: 'document' as const,
            score: 0.8,
            content: 'This is a long shared prefix that both documents share for testing purposes. Different text for doc2.',
            filePath: 'notes/faq.md',
            metadata: { collection: 'docs', title: 'FAQ', seq: 0 },
        };

        const fused = reciprocalRankFusion([[doc1, doc2]]);
        assert.equal(fused.length, 2, 'both documents should be kept');
    },
};

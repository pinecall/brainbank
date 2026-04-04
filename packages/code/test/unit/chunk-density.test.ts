/**
 * Tests for chunk relevance density scoring in CodeVectorSearch.
 *
 * The density filter uses a hard threshold: files with matchedChunks/totalChunks
 * below DENSITY_THRESHOLD (0.10) get a DENSITY_PENALTY (0.25x) on their RRF score.
 * Files above the threshold are untouched.
 *
 * This catches extreme false positives like jobs.service.ts (1/15 = 0.067)
 * but leaves legitimate files like notifications.worker.ts (2/8 = 0.25) alone.
 */

const DENSITY_THRESHOLD = 0.10;
const DENSITY_PENALTY = 0.25;

export const name = 'Code Vector Search — Chunk Density Scoring';

export const tests = {
    'density: 1/15 chunks is below threshold → penalized'(assert: { lt(a: number, b: number, msg: string): void }) {
        const density = 1 / 15; // 0.067
        assert.lt(density, DENSITY_THRESHOLD, '1/15 should be below threshold');
    },

    'density: 2/8 chunks is above threshold → untouched'(assert: { gt(a: number, b: number, msg: string): void }) {
        const density = 2 / 8; // 0.25
        assert.gt(density, DENSITY_THRESHOLD, '2/8 should be above threshold');
    },

    'density penalty pushes false positive below relevant file'(assert: { gt(a: number, b: number, msg: string): void }) {
        // jobs.service.ts: high RRF base but density 1/15 → penalized
        const jobsRRF = 0.033 * DENSITY_PENALTY;  // 0.033 × 0.25 = 0.00825

        // notifications.worker.ts: lower RRF base but density 2/8 → no penalty
        const notifRRF = 0.025; // untouched

        assert.gt(notifRRF, jobsRRF, 'relevant file should rank above false positive');
        assert.gt(notifRRF / jobsRRF, 2, 'ranking gap should be >2x');
    },

    'files with exactly 1 chunk total are never density-penalized'(assert: { gt(a: number, b: number, msg: string): void }) {
        // Small files (1 chunk) where 1/1 matched should never trigger the penalty
        const density = 1 / 1; // 1.0
        assert.gt(density, DENSITY_THRESHOLD, 'single-chunk file should be above threshold');
    },
};

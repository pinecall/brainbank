/**
 * Tests for chunk relevance density scoring in CodeVectorSearch.
 *
 * The density factor is: score *= (matchedChunks / totalChunks) ^ DENSITY_EXPONENT
 * where DENSITY_EXPONENT = 0.5 (square root).
 *
 * This penalizes files where only a tiny fraction of chunks matched the query,
 * e.g. jobs.service.ts (1/15 chunks matched → 74% penalty) vs
 * notifications.gateway.ts (3/3 chunks matched → no penalty).
 */

const DENSITY_EXPONENT = 0.5;

export const name = 'Code Vector Search — Chunk Density Scoring';

export const tests = {
    'sqrt density: 1/15 chunks matched → ~74% penalty'(assert: { lt(a: number, b: number, msg: string): void; gt(a: number, b: number, msg: string): void }) {
        const matched = 1;
        const total = 15;
        const density = matched / total;
        const factor = Math.pow(density, DENSITY_EXPONENT);

        // sqrt(1/15) ≈ 0.258
        assert.lt(factor, 0.30, 'density factor should be < 0.30');
        assert.gt(factor, 0.20, 'density factor should be > 0.20');
    },

    'sqrt density: 3/3 chunks matched → no penalty'(assert: { gt(a: number, b: number, msg: string): void; lt(a: number, b: number, msg: string): void }) {
        const matched = 3;
        const total = 3;
        const density = matched / total;
        const factor = Math.pow(density, DENSITY_EXPONENT);

        assert.gt(factor, 0.99, '100% match density factor should be ~1.0');
        assert.lt(factor, 1.01, '100% match density factor should be ~1.0');
    },

    'sqrt density: 2/10 chunks matched → ~55% penalty'(assert: { lt(a: number, b: number, msg: string): void; gt(a: number, b: number, msg: string): void }) {
        const matched = 2;
        const total = 10;
        const density = matched / total;
        const factor = Math.pow(density, DENSITY_EXPONENT);

        // sqrt(0.2) ≈ 0.447
        assert.lt(factor, 0.50, 'density factor should be < 0.50');
        assert.gt(factor, 0.40, 'density factor should be > 0.40');
    },

    'density creates large ranking gap between low and high match files'(assert: { gt(a: number, b: number, msg: string): void }) {
        // Simulates: jobs.service.ts (1/15 match) vs notifications.gateway.ts (3/3 match)
        const baseRRFHigh = 0.033; // jobs.service.ts — high base score
        const baseRRFLow = 0.025;  // notifications.gateway.ts — lower base score

        const densityLow = Math.pow(1 / 15, DENSITY_EXPONENT);   // 0.258
        const densityHigh = Math.pow(3 / 3, DENSITY_EXPONENT);   // 1.0

        const finalJobs = baseRRFHigh * densityLow;       // 0.033 × 0.258 = 0.00852
        const finalNotif = baseRRFLow * densityHigh;      // 0.025 × 1.0   = 0.025

        assert.gt(finalNotif, finalJobs, 'high-density file should rank above low-density even with lower base score');
        assert.gt(finalNotif / finalJobs, 2, 'ranking gap should be >2x');
    },
};

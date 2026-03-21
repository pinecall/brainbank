/**
 * Unit Tests — Configuration
 */

import { resolveConfig, DEFAULTS } from '../../src/core/config.ts';

export const name = 'Configuration';

export const tests = {
    'defaults are correct'(assert: any) {
        const cfg = resolveConfig();
        assert.equal(cfg.repoPath, '.');
        assert.equal(cfg.dbPath, '.brainbank/brainbank.db');
        assert.equal(cfg.gitDepth, 500);
        assert.equal(cfg.maxFileSize, 512_000);
        assert.equal(cfg.maxDiffBytes, 8192);
        assert.equal(cfg.hnswM, 16);
        assert.equal(cfg.hnswEfConstruction, 200);
        assert.equal(cfg.hnswEfSearch, 50);
        assert.equal(cfg.embeddingDims, 384);
        assert.equal(cfg.maxElements, 2_000_000);
    },

    'partial override works'(assert: any) {
        const cfg = resolveConfig({ repoPath: '/my/repo', gitDepth: 100 });
        assert.equal(cfg.repoPath, '/my/repo');
        assert.equal(cfg.gitDepth, 100);
        // Unspecified fields use defaults
        assert.equal(cfg.hnswM, 16);
        assert.equal(cfg.embeddingDims, 384);
    },

    'embeddingProvider is passed through'(assert: any) {
        const fakeProvider = { dims: 768, embed: async () => new Float32Array(768), embedBatch: async () => [], close: async () => {} };
        const cfg = resolveConfig({ embeddingProvider: fakeProvider as any });
        assert.ok(cfg.embeddingProvider, 'embeddingProvider should be set');
        assert.equal(cfg.embeddingProvider!.dims, 768);
    },

    'all default values are non-null'(assert: any) {
        for (const [key, val] of Object.entries(DEFAULTS)) {
            if (key === 'embeddingProvider') continue;
            assert.ok(val !== null && val !== undefined, `DEFAULTS.${key} should not be null`);
        }
    },
};

/**
 * Unit Tests — Configuration
 */

import { resolveConfig, DEFAULTS, DEFAULT_FEATURES } from '../../src/core/config.ts';

export const name = 'Configuration';

export const tests = {
    'defaults are correct'(assert: any) {
        const cfg = resolveConfig();
        assert.equal(cfg.repoPath, '.');
        assert.equal(cfg.dbPath, '.brainbank/brainbank.db');
        assert.equal(cfg.gitDepth, 500);
        assert.equal(cfg.maxFileSize, 512_000);
        assert.equal(cfg.hnswM, 16);
        assert.equal(cfg.embeddingDims, 384);
    },

    'default features are correct'(assert: any) {
        const cfg = resolveConfig();
        assert.equal(cfg.features.code, true);
        assert.equal(cfg.features.git, true);
        assert.equal(cfg.features.documents, false);
        assert.equal(cfg.features.conversations, true);
        assert.equal(cfg.features.patterns, true);
    },

    'partial feature override works'(assert: any) {
        const cfg = resolveConfig({
            features: { code: false, documents: true },
        });
        assert.equal(cfg.features.code, false);
        assert.equal(cfg.features.documents, true);
        // Unspecified keep defaults
        assert.equal(cfg.features.git, true);
        assert.equal(cfg.features.conversations, true);
        assert.equal(cfg.features.patterns, true);
    },

    'conversations-only mode'(assert: any) {
        const cfg = resolveConfig({
            features: { code: false, git: false, documents: false, patterns: false, conversations: true },
        });
        assert.equal(cfg.features.code, false);
        assert.equal(cfg.features.git, false);
        assert.equal(cfg.features.documents, false);
        assert.equal(cfg.features.patterns, false);
        assert.equal(cfg.features.conversations, true);
    },

    'partial config override works'(assert: any) {
        const cfg = resolveConfig({ repoPath: '/my/repo', gitDepth: 100 });
        assert.equal(cfg.repoPath, '/my/repo');
        assert.equal(cfg.gitDepth, 100);
        assert.equal(cfg.hnswM, 16);
    },

    'embeddingProvider is passed through'(assert: any) {
        const fakeProvider = { dims: 768, embed: async () => new Float32Array(768), embedBatch: async () => [], close: async () => {} };
        const cfg = resolveConfig({ embeddingProvider: fakeProvider as any });
        assert.ok(cfg.embeddingProvider, 'embeddingProvider should be set');
        assert.equal(cfg.embeddingProvider!.dims, 768);
    },

    'DEFAULT_FEATURES export matches DEFAULTS.features'(assert: any) {
        assert.deepEqual(DEFAULT_FEATURES, DEFAULTS.features);
    },
};

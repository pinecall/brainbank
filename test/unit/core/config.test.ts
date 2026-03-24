/**
 * Unit Tests — Configuration
 */

import * as path from 'node:path';
import { resolveConfig, DEFAULTS } from '../../../src/config/defaults.ts';

export const name = 'Configuration';

export const tests = {
    'defaults are correct'(assert: any) {
        const cfg = resolveConfig();
        // repoPath is resolved to absolute, dbPath is relative to repoPath
        assert.equal(cfg.repoPath, path.resolve('.'));
        assert.equal(cfg.dbPath, path.join(path.resolve('.'), '.brainbank/brainbank.db'));
        assert.equal(cfg.gitDepth, 500);
        assert.equal(cfg.maxFileSize, 512_000);
        assert.equal(cfg.hnswM, 16);
        assert.equal(cfg.embeddingDims, 384);
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

    'config without features field succeeds'(assert: any) {
        const cfg = resolveConfig({});
        assert.equal(cfg.repoPath, path.resolve('.'));
        // No features field — modules are composed via .use() now
        assert.ok(!('features' in cfg), 'should not have features field');
    },
};

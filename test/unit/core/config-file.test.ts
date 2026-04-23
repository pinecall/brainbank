/**
 * Unit Test — Project Config (config.json)
 *
 * Tests the factory's config loading: JSON parsing, per-plugin
 * embedding resolution, docs collection registration.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { BrainBank } from '../../../src/brainbank.ts';
import { docs } from '@brainbank/docs';
import type { EmbeddingProvider } from '../../../src/types.ts';
import type { ProjectConfig } from '../../../src/cli/factory/index.ts';
import { registerConfigCollections } from '../../../src/cli/factory/index.ts';

export const name = 'Project Config';

class MockEmbedding implements EmbeddingProvider {
    readonly dims = 16;
    async embed(text: string): Promise<Float32Array> {
        const v = new Float32Array(16);
        for (let i = 0; i < 16; i++) {
            v[i] = Math.sin((text.charCodeAt(i % text.length) || 0) * (i + 1));
        }
        let norm = 0;
        for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
        norm = Math.sqrt(norm);
        if (norm > 0) for (let i = 0; i < v.length; i++) v[i] /= norm;
        return v;
    }
    async embedBatch(texts: string[]): Promise<Float32Array[]> {
        return Promise.all(texts.map(t => this.embed(t)));
    }
    async close(): Promise<void> {}
}

function makeDB() {
    return `/tmp/brainbank-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
}

function cleanup(p: string) {
    try { fs.unlinkSync(p); } catch {}
    try { fs.unlinkSync(p + '-wal'); } catch {}
    try { fs.unlinkSync(p + '-shm'); } catch {}
}

export const tests = {
    async 'config.json schema is valid TypeScript type'(assert: unknown) {
        const a = assert as Record<string, Function>;
        // Verify the ProjectConfig type is exported and usable
        const config: ProjectConfig = {
            plugins: ['code', 'git', 'docs'],
            code: { embedding: 'openai', maxFileSize: 1024 },
            git: { embedding: 'local', depth: 100, maxDiffBytes: 4096 },
            docs: {
                embedding: 'perplexity-context',
                collections: [
                    { name: 'wiki', path: './docs', pattern: '**/*.md' },
                ],
            },
            embedding: 'openai',
            maxFileSize: 512000,
        };

        a.equal(config.plugins!.length, 3);
        const codeCfg = config.code as Record<string, unknown>;
        a.equal(codeCfg.embedding, 'openai');
        const gitCfg = config.git as Record<string, unknown>;
        a.equal(gitCfg.depth, 100);
        const docsCfg = config.docs as Record<string, unknown>;
        const collections = docsCfg.collections as unknown[];
        a.equal(collections.length, 1);
        a.equal(config.embedding, 'openai');
    },

    async 'registerConfigCollections registers docs from config'(assert: any) {
        const db = makeDB();
        const brain = new BrainBank({
            dbPath: db,
            embeddingProvider: new MockEmbedding(),
            embeddingDims: 16,
        }).use(docs());
        await brain.initialize();

        // Create temp docs
        const docsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-config-docs-'));
        fs.writeFileSync(path.join(docsDir, 'test.md'), '# Config Test\n\nThis tests auto-registration.');

        const config: ProjectConfig = {
            docs: {
                collections: [
                    { name: 'test-coll', path: docsDir, pattern: '**/*.md' },
                ],
            },
        };

        await registerConfigCollections(brain, '.', config);

        const collections = (brain.plugin('docs') as any)!.listCollections();
        assert.equal(collections.length, 1);
        assert.equal(collections[0].name, 'test-coll');

        brain.close();
        cleanup(db);
        fs.rmSync(docsDir, { recursive: true, force: true });
    },

    async 'registerConfigCollections skips when no config'(assert: any) {
        const db = makeDB();
        const brain = new BrainBank({
            dbPath: db,
            embeddingProvider: new MockEmbedding(),
            embeddingDims: 16,
        }).use(docs());
        await brain.initialize();

        await registerConfigCollections(brain, '.', null);
        const collections = (brain.plugin('docs') as any)!.listCollections();
        assert.equal(collections.length, 0);

        brain.close();
        cleanup(db);
    },

    async 'registerConfigCollections registers multiple collections'(assert: any) {
        const db = makeDB();
        const brain = new BrainBank({
            dbPath: db,
            embeddingProvider: new MockEmbedding(),
            embeddingDims: 16,
        }).use(docs());
        await brain.initialize();

        const dir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-coll1-'));
        const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-coll2-'));
        fs.writeFileSync(path.join(dir1, 'a.md'), '# A');
        fs.writeFileSync(path.join(dir2, 'b.md'), '# B');

        const config: ProjectConfig = {
            docs: {
                collections: [
                    { name: 'first', path: dir1 },
                    { name: 'second', path: dir2, pattern: '**/*.md' },
                ],
            },
        };

        await registerConfigCollections(brain, '.', config);

        const collections = (brain.plugin('docs') as any)!.listCollections();
        assert.equal(collections.length, 2);
        const names = collections.map((c: any) => c.name).sort();
        assert.deepEqual(names, ['first', 'second']);

        brain.close();
        cleanup(db);
        fs.rmSync(dir1, { recursive: true, force: true });
        fs.rmSync(dir2, { recursive: true, force: true });
    },

};

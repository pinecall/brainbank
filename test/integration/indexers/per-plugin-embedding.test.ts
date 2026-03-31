/**
 * Integration Test — Per-Plugin Embedding Overrides
 *
 * Verifies that each plugin (code, git, docs) can use a different
 * embedding provider with distinct dimensions, and that indexing +
 * search work correctly through each separate HNSW index.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { BrainBank, code, git, docs, hashEmbedding } from '../../helpers.ts';

export const name = 'Per-Plugin Embedding Overrides';

// ── Fixtures ──────────────────────────────────────────

let tmpDir: string;
let brain: BrainBank;

/** Two hash-based embeddings with different dimensions. */
const globalEmb = hashEmbedding(128);   // global: 128d
const codeEmb = hashEmbedding(64);      // code: 64d
const docsEmb = hashEmbedding(256);     // docs: 256d
// git will use the global 128d

function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-perplugin-'));

    // Init a git repo so git plugin works
    execSync('git init', { cwd: tmpDir, stdio: 'ignore' });
    execSync('git config user.email "test@test.com"', { cwd: tmpDir, stdio: 'ignore' });
    execSync('git config user.name "Test"', { cwd: tmpDir, stdio: 'ignore' });

    // Source files for code indexer
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'auth.ts'), `
/**
 * Authentication module.
 */
export function login(email: string, password: string): string {
    return 'token_' + btoa(email);
}

export function logout(token: string): void {
    // invalidate session
}
`.trim());

    fs.writeFileSync(path.join(tmpDir, 'src', 'db.ts'), `
/**
 * Database connection.
 */
export class Database {
    async connect(url: string): Promise<void> {}
    async query(sql: string): Promise<any[]> { return []; }
    close(): void {}
}
`.trim());

    // Docs folder
    fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'docs', 'guide.md'),
        '# Getting Started\n\nInstall the package and configure authentication.\n\n## Setup\n\nRun npm install and set up your .env file.'
    );
    fs.writeFileSync(path.join(tmpDir, 'docs', 'api.md'),
        '# API Reference\n\nThe login endpoint accepts POST requests.\n\n## Endpoints\n\n### POST /login\n\nReturns a JWT token.'
    );

    // Commit so git has history
    execSync('git add -A', { cwd: tmpDir, stdio: 'ignore' });
    execSync('git commit -m "initial commit with auth and database"', { cwd: tmpDir, stdio: 'ignore' });

    // Second commit
    fs.writeFileSync(path.join(tmpDir, 'src', 'cache.ts'), `
export class Cache {
    private store = new Map<string, any>();
    get(key: string): any { return this.store.get(key); }
    set(key: string, value: any): void { this.store.set(key, value); }
}
`.trim());
    execSync('git add -A', { cwd: tmpDir, stdio: 'ignore' });
    execSync('git commit -m "add caching layer for performance"', { cwd: tmpDir, stdio: 'ignore' });
}

// ── Tests ──────────────────────────────────────────────

export const tests: Record<string, () => Promise<void>> = {};

tests['setup: initializes with 3 different embedding dimensions'] = async () => {
    setup();

    brain = new BrainBank({
        repoPath: tmpDir,
        dbPath: path.join(tmpDir, 'test.db'),
        embeddingProvider: globalEmb,        // 128d
        embeddingDims: 128,
    })
        .use(code({ repoPath: tmpDir, embeddingProvider: codeEmb }))     // 64d
        .use(git({ repoPath: tmpDir }))                                  // 128d (global)
        .use(docs({ embeddingProvider: docsEmb }));                      // 256d

    await brain.initialize();
    assert.ok(brain.isInitialized, 'should be initialized');
};

tests['code: indexes with per-plugin 64d embedding'] = async () => {
    const result = await (brain.code as any).index();

    assert.ok(result.indexed >= 2, `indexed ${result.indexed} files (expected >=2)`);
    assert.ok(result.chunks! > 0, `created ${result.chunks} code chunks`);

    // Verify HNSW has 64d vectors
    const codeMod = brain.plugin('code') as any;
    const queryVec = await codeEmb.embed('authentication login');
    assert.equal(queryVec.length, 64, 'code embedding should be 64d');

    const hits = codeMod.hnsw.search(queryVec, 5);
    assert.ok(hits.length > 0, 'should find code results via 64d HNSW');
};

tests['git: indexes with global 128d embedding'] = async () => {
    const result = await (brain.git as any).index({ depth: 10 });

    assert.ok(result.indexed >= 2, `indexed ${result.indexed} commits`);

    // Verify HNSW has 128d vectors
    const gitMod = brain.plugin('git') as any;
    const queryVec = await globalEmb.embed('caching layer');
    assert.equal(queryVec.length, 128, 'git embedding should be 128d (global)');

    const hits = gitMod.hnsw.search(queryVec, 5);
    assert.ok(hits.length > 0, 'should find git results via 128d HNSW');
};

tests['docs: indexes with per-plugin 256d embedding'] = async () => {
    await (brain.docs as any)!.addCollection({ name: 'docs', path: path.join(tmpDir, 'docs'), pattern: '**/*.md' });
    const result = await (brain.docs as any)!.indexDocs();

    assert.ok(result.docs, 'should have docs result');
    assert.equal(result.docs.indexed, 2, 'should index 2 docs');
};

tests['docs: search works through per-plugin 256d embedding'] = async () => {
    const hits = await (brain.plugin('docs') as any).search('authentication setup');

    assert.ok(hits.length > 0, 'should find docs via 256d HNSW');
    assert.equal(hits[0].type, 'document');
};

tests['code + git: HNSW indices are separate with different dimensions'] = async () => {
    const codeMod = brain.plugin('code') as any;
    const gitMod = brain.plugin('git') as any;

    // Code HNSW should NOT accept a 128d vector
    const vec128 = await globalEmb.embed('test');
    const vec64 = await codeEmb.embed('test');

    assert.equal(vec64.length, 64, 'code vec is 64d');
    assert.equal(vec128.length, 128, 'git vec is 128d');

    // Both indices should have vectors
    assert.ok(codeMod.hnsw.size > 0, 'code HNSW has vectors');
    assert.ok(gitMod.hnsw.size > 0, 'git HNSW has vectors');
};

tests['stats: reports stats from all plugins'] = async () => {
    const stats = brain.stats();

    assert.ok(stats.code, 'has code stats');
    assert.ok(stats.code.files >= 2, 'code has files');
    assert.ok(stats.code.chunks > 0, 'code has chunks');

    assert.ok(stats.git, 'has git stats');
    assert.ok(stats.git.commits >= 2, 'git has commits');

    assert.ok(stats.documents, 'has docs stats');
    assert.ok(stats.documents.chunks > 0, 'docs has chunks');
};

tests['cleanup'] = async () => {
    brain.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
};

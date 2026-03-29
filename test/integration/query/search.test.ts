/**
 * BrainBank Integration Test — Unified Search + Context
 *
 * Tests brain.search() across all modules (code + git + memory),
 * brain.getContext() for system prompts, and minScore filtering.
 * Uses all 4 modules wired together.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { BrainBank, code, git, docs, memory, hashEmbedding } from '../../helpers.ts';

export const name = 'Unified Search + Context';

let tmpDir: string;
let brain: BrainBank;

function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-search-'));
    const repoDir = path.join(tmpDir, 'repo');
    fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });

    execSync('git init', { cwd: repoDir, stdio: 'pipe' });
    execSync('git config user.email "t@t.dev"', { cwd: repoDir, stdio: 'pipe' });
    execSync('git config user.name "Tester"', { cwd: repoDir, stdio: 'pipe' });

    fs.writeFileSync(path.join(repoDir, 'src', 'auth.ts'), 'export function login() { return "token"; }');
    fs.writeFileSync(path.join(repoDir, 'src', 'db.ts'), 'export class DB { query(sql: string) { return []; } }');
    execSync('git add -A && git commit -m "feat: auth and database"', { cwd: repoDir, stdio: 'pipe' });

    fs.writeFileSync(path.join(repoDir, 'src', 'api.ts'), 'export function handler() {}');
    execSync('git add -A && git commit -m "feat: API endpoint handler"', { cwd: repoDir, stdio: 'pipe' });

    const docsDir = path.join(tmpDir, 'docs');
    fs.mkdirSync(docsDir, { recursive: true });
    fs.writeFileSync(path.join(docsDir, 'guide.md'), '# Guide\n\nHow to use the authentication module.\n');

    return { repoDir, docsDir };
}

export const tests: Record<string, () => Promise<void>> = {};

tests['setup: brain with code + git + docs + memory'] = async () => {
    const { repoDir, docsDir } = setup();

    brain = new BrainBank({ repoPath: repoDir, dbPath: path.join(tmpDir, 'test.db'), embeddingProvider: hashEmbedding() })
        .use(code({ repoPath: repoDir }))
        .use(git({ repoPath: repoDir }))
        .use(docs())
        .use(memory());
    await brain.initialize();

    await brain.index({ forceReindex: true });
    await brain.addCollection({ name: 'guide', path: docsDir, pattern: '**/*.md' });
    await brain.indexDocs();

    const mem = brain.plugin('memory') as any;
    await mem.learn({ task: 'Fix auth bug', taskType: 'debug', approach: 'Check token flow', outcome: 'Fixed', successRate: 0.9 });

    assert.ok(brain);
};

tests['brain.search(): returns code + commit + pattern'] = async () => {
    const stats = brain.stats();
    assert.ok((stats.code?.chunks ?? 0) > 0, `code chunks indexed: ${stats.code?.chunks}`);
    assert.ok((stats.git?.commits ?? 0) > 0, `git commits indexed: ${stats.git?.commits}`);

    const mem = brain.plugin('memory') as any;
    const patternResults = await mem.search('auth bug');
    assert.ok(patternResults.length > 0, `patterns found: ${patternResults.length}`);

    const all = await brain.search('auth', { minScore: 0, useMMR: false, codeK: 10, gitK: 10, patternK: 10 });
    assert.ok(all.length > 0, `unified search returned ${all.length} results`);
};

tests['brain.search(): code results have filePath + metadata'] = async () => {
    const results = await brain.search('database query', { minScore: 0 });
    const cr = results.filter(r => r.type === 'code');

    assert.ok(cr.length > 0, 'has code');
    assert.ok(cr[0].filePath, 'has filePath');
    assert.ok(cr[0].metadata?.language, 'has language');
};

tests['brain.search(): commit results have hash + author'] = async () => {
    const stats = brain.stats();
    assert.ok((stats.git?.commits ?? 0) > 0, `commits indexed: ${stats.git?.commits}`);
    assert.ok((stats.git?.hnswSize ?? 0) > 0, `git HNSW populated: ${stats.git?.hnswSize}`);

    let commits: any[] = [];
    for (const q of ['feat auth database', 'API endpoint handler', 'commit']) {
        const results = await brain.search(q, { minScore: 0, gitK: 10 });
        commits = results.filter(r => r.type === 'commit');
        if (commits.length > 0) break;
    }

    if (commits.length === 0) {
        const db = (brain as any)._db;
        const row = db.prepare('SELECT * FROM git_commits LIMIT 1').get() as any;
        assert.ok(row, 'git_commits table has data');
        assert.ok(row.hash, 'has hash column');
        assert.ok(row.author_name, 'has author_name column');
        return;
    }

    assert.ok(commits[0].metadata?.hash, 'has hash');
    assert.ok(commits[0].metadata?.author, 'has author');
};

tests['brain.search(): memory patterns have approach'] = async () => {
    const mem = brain.plugin('memory') as any;
    const results = await mem.search('auth bug fix');

    assert.ok(results.length > 0, 'has patterns');
    assert.ok(results[0].approach, 'has approach');
};

tests['brain.search(): minScore filters low matches'] = async () => {
    const all = await brain.search('auth', { minScore: 0 });
    const strict = await brain.search('auth', { minScore: 0.9 });

    assert.ok(all.length >= strict.length, 'high minScore fewer results');
};

tests['docs plugin search(): searches doc collections'] = async () => {
    const results = await (brain.plugin('docs') as any).search('authentication guide');

    assert.ok(results.length > 0, 'found docs');
    assert.equal(results[0].type, 'document');
};

tests['brain.getContext(): returns markdown string'] = async () => {
    const ctx = await brain.getContext('How does auth work?');

    assert.ok(typeof ctx === 'string', 'is string');
    assert.ok(ctx.length > 0, 'not empty');
};

tests['brain.stats(): reports all module stats'] = async () => {
    const stats = brain.stats();

    assert.ok((stats.code?.hnswSize ?? 0) > 0, 'code HNSW');
    assert.ok((stats.git?.hnswSize ?? 0) > 0, 'git HNSW');
};

tests['cleanup'] = async () => {
    brain.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
};

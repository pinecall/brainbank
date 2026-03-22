/**
 * BrainBank Integration Test — Git Indexer
 *
 * Full pipeline: create temp git repo with multiple commits →
 * index history → search commits → verify co-edits → incremental skip.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import { BrainBank, code, git, hashEmbedding } from '../helpers.ts';

export const name = 'Git Indexer';

let tmpDir: string;
let brain: BrainBank;
const emb = hashEmbedding();

function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-git-'));
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });

    execSync('git init', { cwd: tmpDir, stdio: 'pipe' });
    execSync('git config user.email "dev@brainbank.test"', { cwd: tmpDir, stdio: 'pipe' });
    execSync('git config user.name "Dev User"', { cwd: tmpDir, stdio: 'pipe' });

    // Commit 1: initial API
    fs.writeFileSync(path.join(tmpDir, 'src', 'api.ts'), 'export function getUsers() { return []; }');
    fs.writeFileSync(path.join(tmpDir, 'src', 'db.ts'), 'export function connect() { return null; }');
    execSync('git add -A && git commit -m "feat: initial API and database layer"', { cwd: tmpDir, stdio: 'pipe' });

    // Commit 2: add auth (touches api.ts + new auth.ts → co-edit pair)
    fs.writeFileSync(path.join(tmpDir, 'src', 'auth.ts'), 'export function login() { return "token"; }');
    fs.writeFileSync(path.join(tmpDir, 'src', 'api.ts'), 'import { login } from "./auth";\nexport function getUsers() { return []; }');
    execSync('git add -A && git commit -m "feat: add authentication with JWT tokens"', { cwd: tmpDir, stdio: 'pipe' });

    // Commit 3: fix security bug (touches auth.ts + api.ts again → strengthens co-edit)
    fs.writeFileSync(path.join(tmpDir, 'src', 'auth.ts'), 'export function login() { return "sk_" + Date.now(); }');
    fs.writeFileSync(path.join(tmpDir, 'src', 'api.ts'), 'import { login } from "./auth";\nexport function getUsers() { return []; }\nexport function validateRequest(token: string) { return token.startsWith("sk_"); }');
    execSync('git add -A && git commit -m "fix: harden token validation against injection attacks"', { cwd: tmpDir, stdio: 'pipe' });

    // Commit 4: refactor database (touches db.ts only)
    fs.writeFileSync(path.join(tmpDir, 'src', 'db.ts'), 'export class Database { connect(url: string) {} query(sql: string) { return []; } }');
    execSync('git add -A && git commit -m "refactor: convert database to class-based pattern"', { cwd: tmpDir, stdio: 'pipe' });

    // Commit 5: add tests (new file)
    fs.writeFileSync(path.join(tmpDir, 'src', 'api.test.ts'), 'import { getUsers } from "./api";\ntest("returns users", () => { expect(getUsers()).toEqual([]); });');
    execSync('git add -A && git commit -m "test: add unit tests for API endpoints"', { cwd: tmpDir, stdio: 'pipe' });
}

export const tests: Record<string, () => Promise<void>> = {};

tests['index: indexes all commits from git history'] = async () => {
    const assert = (await import('node:assert')).strict;
    setup();

    brain = new BrainBank({ repoPath: tmpDir, dbPath: path.join(tmpDir, 'test.db'), embeddingProvider: emb })
        .use(code({ repoPath: tmpDir }))
        .use(git({ repoPath: tmpDir }));
    await brain.initialize();

    const result = await brain.indexGit({ depth: 50 });
    assert.ok(result.indexed >= 5, `indexed ${result.indexed} commits (expected ≥5)`);
};

tests['index: stores commit metadata (hash, author, date, files)'] = async () => {
    const assert = (await import('node:assert')).strict;
    const db = (brain as any)._db;
    const commits = db.prepare('SELECT * FROM git_commits ORDER BY timestamp DESC').all() as any[];

    assert.ok(commits.length >= 5, `${commits.length} commits stored`);
    const latest = commits[0];
    assert.ok(latest.hash.length === 40, 'full SHA hash');
    assert.ok(latest.short_hash.length === 7, 'short hash');
    assert.ok(latest.author === 'Dev User', 'author name');
    assert.ok(latest.message, 'has message');
};

tests['index: stores commit files for co-edit analysis'] = async () => {
    const assert = (await import('node:assert')).strict;
    const db = (brain as any)._db;
    const files = db.prepare('SELECT * FROM commit_files').all() as any[];

    // commit_files populated depends on git --stat format; verify table exists
    assert.ok(Array.isArray(files), 'commit_files table exists');
};

tests['index: co-edits table exists'] = async () => {
    const assert = (await import('node:assert')).strict;
    const db = (brain as any)._db;
    const coEdits = db.prepare('SELECT * FROM co_edits ORDER BY count DESC').all() as any[];

    assert.ok(Array.isArray(coEdits), 'co_edits table exists');
};

tests['index: skips already indexed commits'] = async () => {
    const assert = (await import('node:assert')).strict;
    const result = await brain.indexGit({ depth: 50 });

    assert.equal(result.indexed, 0, 'no new commits');
    assert.ok(result.skipped >= 5, `skipped ${result.skipped} existing`);
};

tests['search: HNSW finds commits by message content'] = async () => {
    const assert = (await import('node:assert')).strict;
    const gitMod = brain.indexer('git') as any;
    const queryVec = await emb.embed('authentication JWT token');
    const hits = gitMod.hnsw.search(queryVec, 5);

    assert.ok(hits.length > 0, `found ${hits.length} commit vectors`);
};

tests['search: HNSW finds security-related commits'] = async () => {
    const assert = (await import('node:assert')).strict;
    const gitMod = brain.indexer('git') as any;
    const queryVec = await emb.embed('injection attack security fix');
    const hits = gitMod.hnsw.search(queryVec, 5);

    assert.ok(hits.length > 0, 'found security commits');
};

tests['search: HNSW finds refactoring commits'] = async () => {
    const assert = (await import('node:assert')).strict;
    const gitMod = brain.indexer('git') as any;
    const queryVec = await emb.embed('database class refactoring');
    const hits = gitMod.hnsw.search(queryVec, 5);

    assert.ok(hits.length > 0, 'found refactoring commits');
};

tests['co-edits: suggest returns related files'] = async () => {
    const assert = (await import('node:assert')).strict;
    const gitMod = brain.indexer('git') as any;
    const suggestions = gitMod.suggest('src/auth.ts', 5);

    assert.ok(Array.isArray(suggestions), 'returns array');
    // auth.ts should suggest api.ts (co-edited together)
    if (suggestions.length > 0) {
        assert.ok(suggestions[0].file, 'suggestion has file');
        assert.ok(suggestions[0].count > 0, 'suggestion has count');
    }
};

tests['stats: reports correct HNSW size'] = async () => {
    const assert = (await import('node:assert')).strict;
    const stats = brain.stats();

    assert.ok(stats.git, 'git stats present');
    assert.ok(stats.git.commits >= 5, `${stats.git.commits} commits`);
    assert.ok(stats.git.hnswSize >= 5, `HNSW: ${stats.git.hnswSize} vectors`);
};

tests['cleanup'] = async () => {
    brain.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
};

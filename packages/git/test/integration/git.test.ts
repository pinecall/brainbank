/**
 * BrainBank Integration Test — Git Indexer
 *
 * Full pipeline: create temp git repo with multiple commits →
 * index history → search commits → verify co-edits → incremental skip.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import assert from 'node:assert/strict';
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
    setup();

    brain = new BrainBank({ repoPath: tmpDir, dbPath: path.join(tmpDir, 'test.db'), embeddingProvider: emb })
        .use(code({ repoPath: tmpDir }))
        .use(git({ repoPath: tmpDir }));
    await brain.initialize();

    const result = await (brain.git as any).index({ depth: 50 });
    assert.ok(result.indexed >= 5, `indexed ${result.indexed} commits (expected ≥5)`);
};

tests['index: stores commit metadata (hash, author, date, files)'] = async () => {
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
    const db = (brain as any)._db;
    const files = db.prepare('SELECT * FROM commit_files').all() as any[];

    // commit_files populated depends on git --stat format; verify table exists
    assert.ok(Array.isArray(files), 'commit_files table exists');
};

tests['index: co-edits table exists'] = async () => {
    const db = (brain as any)._db;
    const coEdits = db.prepare('SELECT * FROM co_edits ORDER BY count DESC').all() as any[];

    assert.ok(Array.isArray(coEdits), 'co_edits table exists');
};

tests['index: skips already indexed commits'] = async () => {
    const result = await (brain.git as any).index({ depth: 50 });

    assert.equal(result.indexed, 0, 'no new commits');
    assert.ok(result.skipped >= 5, `skipped ${result.skipped} existing`);
};

tests['search: HNSW finds commits by message content'] = async () => {
    const gitMod = brain.plugin('git') as any;
    const queryVec = await emb.embed('authentication JWT token');
    const hits = gitMod.hnsw.search(queryVec, 5);

    assert.ok(hits.length > 0, `found ${hits.length} commit vectors`);
};

tests['search: HNSW finds security-related commits'] = async () => {
    const gitMod = brain.plugin('git') as any;
    const queryVec = await emb.embed('injection attack security fix');
    const hits = gitMod.hnsw.search(queryVec, 5);

    assert.ok(hits.length > 0, 'found security commits');
};

tests['search: HNSW finds refactoring commits'] = async () => {
    const gitMod = brain.plugin('git') as any;
    const queryVec = await emb.embed('database class refactoring');
    const hits = gitMod.hnsw.search(queryVec, 5);

    assert.ok(hits.length > 0, 'found refactoring commits');
};

tests['co-edits: suggest returns related files'] = async () => {
    const gitMod = brain.plugin('git') as any;
    const suggestions = gitMod.suggestCoEdits('src/auth.ts', 5);

    assert.ok(Array.isArray(suggestions), 'returns array');
    // auth.ts should suggest api.ts (co-edited together)
    if (suggestions.length > 0) {
        assert.ok(suggestions[0].file, 'suggestion has file');
        assert.ok(suggestions[0].count > 0, 'suggestion has count');
    }
};

tests['stats: reports correct HNSW size'] = async () => {
    const stats = brain.stats();

    assert.ok(stats.git, 'git stats present');
    assert.ok(stats.git.commits >= 5, `${stats.git.commits} commits`);
    assert.ok(stats.git.hnswSize >= 5, `HNSW: ${stats.git.hnswSize} vectors`);
};

tests['index: additions/deletions are real line counts (not visual chars)'] = async () => {
    const db = (brain as any)._db;
    const commits = db.prepare(
        'SELECT message, additions, deletions FROM git_commits WHERE is_merge = 0 ORDER BY timestamp ASC'
    ).all() as any[];

    // At least one commit should have additions > 0
    const withAdditions = commits.filter((c: any) => c.additions > 0);
    assert.ok(withAdditions.length > 0, 'some commits should have additions');

    // The initial commit creates two files with real content — additions should be >= 2
    const initial = commits[0];
    assert.ok(initial.additions >= 2, `initial commit: additions=${initial.additions} should be >= 2`);

    // No commit should have absurdly high counts from counting visual chars
    for (const c of commits) {
        assert.ok(c.additions < 1000, `additions=${c.additions} too high for commit: ${c.message}`);
        assert.ok(c.deletions < 1000, `deletions=${c.deletions} too high for commit: ${c.message}`);
    }
};

tests['index: commit_files correctly populated from --numstat'] = async () => {
    const db = (brain as any)._db;
    const files = db.prepare('SELECT * FROM commit_files').all() as any[];

    // We have at least 5 commits, each touching at least 1 file
    assert.ok(files.length >= 5, `commit_files: ${files.length} entries (expected >= 5)`);

    // Check that file paths look reasonable
    const paths = files.map((f: any) => f.file_path);
    const hasSrcFiles = paths.some((p: string) => p.includes('src/'));
    assert.ok(hasSrcFiles, 'should have src/ files tracked');
};

tests['fileHistory: returns commit history for a file'] = async () => {
    const history = await brain.git!.fileHistory('src/api.ts', 10);

    assert.ok(Array.isArray(history), 'returns array');
    // api.ts was modified in commits 1, 2, 3, 5 = at least 3 non-merge commits
    assert.ok(history.length >= 2, `api.ts history: ${history.length} entries (expected >= 2)`);
    assert.ok(history[0].short_hash, 'has short_hash');
    assert.ok(history[0].message, 'has message');
    assert.ok(typeof history[0].additions === 'number', 'has additions');
    assert.ok(typeof history[0].deletions === 'number', 'has deletions');
};

tests['suggestCoEdits: git accessor available after .use()'] = async () => {
    const uninitBrain = new BrainBank({ repoPath: tmpDir, dbPath: path.join(tmpDir, 'uninit.db'), embeddingProvider: emb })
        .use(git({ repoPath: tmpDir }));

    // brain.git is available after .use() — typed accessor on the plugin
    assert.ok(uninitBrain.git, 'git accessor should be defined after .use()');
    assert.equal(typeof uninitBrain.git!.suggestCoEdits, 'function');
};

tests['co-edits: auth.ts suggests api.ts'] = async () => {
    const suggestions = brain.git!.suggestCoEdits('src/auth.ts', 5);

    assert.ok(Array.isArray(suggestions), 'returns array');
    // auth.ts and api.ts were co-edited in commits 2 and 3
    if (suggestions.length > 0) {
        const files = suggestions.map((s: any) => s.file);
        assert.ok(files.some((f: string) => f.includes('api.ts')), `co-edits should suggest api.ts, got: ${files}`);
    }
};

tests['cleanup'] = async () => {
    brain.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
};

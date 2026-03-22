/**
 * BrainBank Integration Test — Qwen3 Reranker
 *
 * Tests the real Qwen3-Reranker-0.6B model via node-llama-cpp.
 * First run will download the model (~640MB) from HuggingFace.
 *
 * Run with: npx tsx test/run.ts --integration --filter reranker-real
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Qwen3Reranker } from '../../src/rerankers/qwen3-reranker.ts';
import { BrainBank, code, hashEmbedding } from '../helpers.ts';
import { execSync } from 'node:child_process';

export const name = 'Qwen3 Reranker (real model)';

let reranker: Qwen3Reranker;

export const tests: Record<string, (assert: any) => Promise<void>> = {};

tests['setup: load Qwen3 reranker model'] = async (assert: any) => {
    reranker = new Qwen3Reranker();
    // First rank() call triggers lazy model download + load
    const scores = await reranker.rank('test', ['hello world']);
    assert(scores.length === 1, `should return 1 score, got ${scores.length}`);
    assert(typeof scores[0] === 'number', `score should be number, got ${typeof scores[0]}`);
    assert(scores[0] >= 0 && scores[0] <= 1, `score should be 0-1, got ${scores[0]}`);
};

tests['rank: relevant doc scores higher than irrelevant'] = async (assert: any) => {
    const query = 'How to authenticate users with JWT tokens?';
    const documents = [
        'JWT authentication validates tokens by checking the signature against a secret key. Tokens contain claims like user ID and expiration.',
        'The weather in Paris today is sunny with temperatures around 22 degrees Celsius.',
        'Database connection pooling reduces overhead by reusing established connections instead of creating new ones for each query.',
    ];

    const scores = await reranker.rank(query, documents);

    assert(scores.length === 3, `should return 3 scores, got ${scores.length}`);
    assert(scores[0] > scores[1], `JWT doc (${scores[0].toFixed(3)}) should score higher than weather (${scores[1].toFixed(3)})`);
    assert(scores[0] > scores[2], `JWT doc (${scores[0].toFixed(3)}) should score higher than database (${scores[2].toFixed(3)})`);

    console.log(`    Scores: JWT=${scores[0].toFixed(3)}, weather=${scores[1].toFixed(3)}, db=${scores[2].toFixed(3)}`);
};

tests['rank: code-related documents ranked by relevance'] = async (assert: any) => {
    const query = 'HNSW vector search implementation';
    const documents = [
        'The HNSWIndex class wraps hnswlib-node with lazy initialization and cosine similarity search for nearest neighbors.',
        'export function reciprocalRankFusion(lists: SearchResult[][]): SearchResult[] { ... }',
        'A shopping cart component displays items with quantity selectors and a checkout button.',
    ];

    const scores = await reranker.rank(query, documents);

    assert(scores[0] > scores[2], `HNSW doc (${scores[0].toFixed(3)}) should score higher than shopping cart (${scores[2].toFixed(3)})`);

    console.log(`    Scores: hnsw=${scores[0].toFixed(3)}, rrf=${scores[1].toFixed(3)}, cart=${scores[2].toFixed(3)}`);
};

tests['rank: deduplication — identical docs scored once'] = async (assert: any) => {
    const query = 'authentication';
    const documents = [
        'Login with username and password',
        'Login with username and password', // duplicate
        'Shopping cart checkout flow',
    ];

    const scores = await reranker.rank(query, documents);

    assert(scores.length === 3, `should return 3 scores`);
    assert(scores[0] === scores[1], `duplicate docs should have identical scores: ${scores[0]} vs ${scores[1]}`);
};

tests['rank: empty documents returns empty'] = async (assert: any) => {
    const scores = await reranker.rank('test query', []);
    assert(scores.length === 0, 'should return empty array for no documents');
};

tests['full pipeline: BrainBank search with reranker'] = async (assert: any) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-reranker-'));
    const repoDir = path.join(tmpDir, 'repo');
    fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });

    execSync('git init', { cwd: repoDir, stdio: 'pipe' });
    execSync('git config user.email "t@t.dev"', { cwd: repoDir, stdio: 'pipe' });
    execSync('git config user.name "Tester"', { cwd: repoDir, stdio: 'pipe' });

    fs.writeFileSync(path.join(repoDir, 'src', 'auth.ts'),
        'export function verifyJWT(token: string) { /* validate JWT signature */ return { userId: "123" }; }');
    fs.writeFileSync(path.join(repoDir, 'src', 'cart.ts'),
        'export function addToCart(item: string) { /* shopping cart logic */ return [item]; }');
    execSync('git add -A && git commit -m "feat: auth and cart"', { cwd: repoDir, stdio: 'pipe' });

    const brain = new BrainBank({
        repoPath: repoDir,
        dbPath: path.join(tmpDir, 'test.db'),
        embeddingProvider: hashEmbedding(),
        reranker,
    }).use(code({ repoPath: repoDir }));

    await brain.initialize();
    await brain.index({ forceReindex: true });

    // Search with reranker — auth should rank first for JWT query
    const results = await brain.search('JWT authentication', { minScore: 0, codeK: 10 });
    assert(results.length > 0, 'should find results');

    if (results.length >= 2) {
        const authResult = results.find(r => r.filePath?.includes('auth.ts'));
        const cartResult = results.find(r => r.filePath?.includes('cart.ts'));
        if (authResult && cartResult) {
            assert(authResult.score > cartResult.score,
                `auth.ts (${authResult.score.toFixed(3)}) should rank higher than cart.ts (${cartResult.score.toFixed(3)})`);
            console.log(`    auth.ts=${authResult.score.toFixed(3)}, cart.ts=${cartResult.score.toFixed(3)}`);
        }
    }

    brain.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
};

tests['cleanup: close reranker'] = async (assert: any) => {
    await reranker.close();
    assert(true, 'reranker closed successfully');
};

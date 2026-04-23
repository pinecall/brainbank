/**
 * BrainBank — Real Model Integration Tests
 *
 * Tests the REAL pipeline with actual model inference:
 * - LocalEmbedding (all-MiniLM-L6-v2, downloads ~23MB on first run)
 * - Real semantic similarity (not hash-based)
 * - Full search pipeline: vector, keyword, hybrid
 *
 * Run with: npm test -- --integration --filter real-model
 * First run downloads the model (~23MB) — subsequent runs use cache.
 */

import * as fs from 'node:fs';
import { BrainBank } from '../../../src/brainbank.ts';
import { LocalEmbedding } from '../../../src/providers/embeddings/local-embedding.ts';


export const name = 'Integration — Real Model';

function tmpDb(label: string): string {
    return `/tmp/brainbank-realmodel-${label}-${Date.now()}.db`;
}



// ── Shared State ────────────────────────────────────

let brain: BrainBank;
let embedding: LocalEmbedding;
let dbPath: string;

export const tests = {

    // ── LocalEmbedding Model ────────────────────────

    async 'LocalEmbedding: loads model and produces 384-dim vectors'(assert: any) {
        embedding = new LocalEmbedding();
        const vec = await embedding.embed('Hello world');

        assert(vec instanceof Float32Array, 'should return Float32Array');
        assert.equal(vec.length, 384, 'should be 384 dimensions');

        // Should be normalized (magnitude ≈ 1.0)
        let mag = 0;
        for (let i = 0; i < vec.length; i++) mag += vec[i] * vec[i];
        mag = Math.sqrt(mag);
        assert(Math.abs(mag - 1.0) < 0.01, `should be normalized (mag=${mag.toFixed(4)})`);
    },

    async 'LocalEmbedding: similar texts have high cosine similarity'(assert: any) {
        const v1 = await embedding.embed('The cat sat on the mat');
        const v2 = await embedding.embed('A cat is sitting on a mat');
        const v3 = await embedding.embed('Stock market crashes 50% today');

        // Cosine similarity
        function cosine(a: Float32Array, b: Float32Array): number {
            let dot = 0;
            for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
            return dot; // Normalized, so dot = cosine
        }

        const simSimilar = cosine(v1, v2);
        const simDifferent = cosine(v1, v3);

        assert.gt(simSimilar, 0.7, `similar texts should have high similarity (${simSimilar.toFixed(3)})`);
        assert.lt(simDifferent, simSimilar, 'unrelated text should have lower similarity');
    },

    async 'LocalEmbedding: embedBatch produces consistent results'(assert: any) {
        const texts = ['First sentence', 'Second sentence', 'Third sentence'];
        const vecs = await embedding.embedBatch(texts);

        assert.equal(vecs.length, 3, 'should return 3 vectors');
        for (const v of vecs) {
            assert.equal(v.length, 384, 'each should be 384 dims');
        }

        // Single embed should match batch embed
        const single = await embedding.embed('First sentence');
        let diff = 0;
        for (let i = 0; i < 384; i++) diff += Math.abs(single[i] - vecs[0][i]);
        assert.lt(diff, 0.01, 'batch and single embed should produce same vector');
    },

    // ── Full Pipeline with Real Embeddings ──────────

    async 'initialize BrainBank with real LocalEmbedding'(assert: any) {
        dbPath = tmpDb('real-pipeline');
        brain = new BrainBank({ dbPath, embeddingProvider: embedding });
        await brain.initialize();
        assert(brain.isInitialized);
    },

    async 'real semantic search: finds conceptually similar items'(assert: any) {
        const col = brain.collection('knowledge');

        await col.add('TypeScript uses static types for compile-time checking');
        await col.add('Python is a dynamically typed language popular for data science');
        await col.add('React uses a virtual DOM for efficient UI rendering');
        await col.add('PostgreSQL supports JSONB for semi-structured data storage');
        await col.add('Docker containers package applications with their dependencies');

        // Semantic search — should understand concept, not just keywords
        const results = await col.search('type safety in programming', { k: 3, mode: 'vector' });
        assert.gt(results.length, 0, 'should have results');
        assert(
            results[0].content.includes('TypeScript') || results[0].content.includes('typed'),
            `top result should be about typing (got: "${results[0].content.substring(0, 50)}")`
        );
    },

    async 'real BM25: matches exact terms'(assert: any) {
        const col = brain.collection('knowledge');

        const results = await col.search('PostgreSQL JSONB', { k: 3, mode: 'keyword' });
        assert.gt(results.length, 0);
        assert(results[0].content.includes('PostgreSQL'), 'should match PostgreSQL');
    },

    async 'real hybrid: combines semantic + keyword signals'(assert: any) {
        const col = brain.collection('knowledge');

        const results = await col.search('containerized deployment', { k: 3, mode: 'hybrid' });
        assert.gt(results.length, 0);
        // Should find Docker (semantic match for "containerized")
        const hasDocker = results.some(r => r.content.includes('Docker'));
        assert(hasDocker, 'hybrid should find Docker via semantic similarity to "containerized"');
    },

    async 'real search with tags: filter works on real vectors'(assert: any) {
        const col = brain.collection('issues');

        await col.add('Login endpoint returns 500 for expired tokens', {
            tags: ['backend', 'auth', 'critical'],
        });
        await col.add('Dashboard chart tooltip overlaps on mobile', {
            tags: ['frontend', 'ui', 'minor'],
        });
        await col.add('Database connection pool exhausted under load', {
            tags: ['backend', 'db', 'critical'],
        });
        await col.add('CSS grid layout breaks in Safari 15', {
            tags: ['frontend', 'css', 'major'],
        });

        // Semantic search + tag filter
        const backendIssues = await col.search('server error', {
            k: 5, mode: 'vector', tags: ['backend'],
        });
        assert(backendIssues.every(r => r.tags.includes('backend')),
            'all results should have backend tag');

        const criticals = await col.search('problem', {
            k: 5, mode: 'keyword', tags: ['critical'], minScore: 0,
        });
        assert(criticals.every(r => r.tags.includes('critical')),
            'all results should have critical tag');
    },

    async 'real TTL: auto-prune works with real embeddings'(assert: any) {
        const col = brain.collection('ttl_real');

        await col.add('temporary debug log', { ttl: '1s' });
        await col.add('permanent knowledge item');

        assert.equal(col.count(), 2);

        // Wait for TTL
        await new Promise(r => setTimeout(r, 1500));

        const items = col.list();
        assert.equal(items.length, 1);
        assert.equal(items[0].content, 'permanent knowledge item');
    },

    // ── Multi-Collection with Real Embeddings ───────

    async 'real multi-collection: cross-collection search stays isolated'(assert: any) {
        const knowledge = brain.collection('knowledge');
        const issues = brain.collection('issues');

        // Search in knowledge should not return issues
        const kResults = await knowledge.search('type checking', { k: 3, mode: 'vector' });
        assert(kResults.every(r => r.collection === 'knowledge'));

        const iResults = await issues.search('backend error', { k: 3, mode: 'vector' });
        assert(iResults.every(r => r.collection === 'issues'));
    },

    // ── Cleanup ─────────────────────────────────────

    async 'cleanup'(assert: any) {
        await embedding.close();
        brain.close();
        assert(!brain.isInitialized);
        try { fs.unlinkSync(dbPath); } catch {}
        try { fs.unlinkSync(dbPath + '-wal'); } catch {}
        try { fs.unlinkSync(dbPath + '-shm'); } catch {}
    },
};

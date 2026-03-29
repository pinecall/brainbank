/**
 * BrainBank Collections — Quick Demo
 *
 * Store and search structured agent memory.
 * Run: npx tsx examples/collection/collection.ts
 */
import { BrainBank } from '../../src/index.ts';
import * as fs from 'node:fs';

const DB = '/tmp/brainbank-collections-demo.db';
const brain = new BrainBank({ dbPath: DB });
await brain.initialize();

// ── Store memories ──────────────────────────────────
const decisions = brain.collection('decisions');
const investigations = brain.collection('investigations');

await decisions.add(
    'Use SQLite with WAL mode instead of PostgreSQL. Portable single-file ' +
    'storage, zero infrastructure, works offline. Trade-off: single-writer ' +
    'only, fine for our single-process design.',
    { tags: ['architecture', 'storage'] }
);

await decisions.add(
    'Migrate API from Express to Fastify. 2x throughput in benchmarks, ' +
    'native schema validation, better TypeScript support.',
    {
        tags: ['architecture', 'api'],
        metadata: { files: ['src/api/server.ts'] },
    }
);

await investigations.add(
    'HNSW index empty after reembed. Root cause: index was dims=384 but ' +
    'OpenAI uses dims=1536. Fix: rebuild HNSW when dims change.',
    { tags: ['bug', 'resolved'], ttl: '30d' }
);

// ── Search ──────────────────────────────────────────
console.log('── Search ──');

for (const [query, col] of [
    ['why not postgres', decisions],
    ['express performance', decisions],
    ['empty search results', investigations],
] as const) {
    const hits = await col.search(query, { k: 1 });
    const hit = hits[0];
    console.log(`  "${query}" → ${hit?.content.slice(0, 60)}... (${hit?.score.toFixed(2)})`);
}

// ── Metadata linking ────────────────────────────────
console.log('\n── Linked data ──');
const apiHit = (await decisions.search('fastify', { k: 1 }))[0];
console.log(`  Decision: ${apiHit?.content.slice(0, 50)}...`);
console.log(`  Files: ${apiHit?.metadata?.files}`);

// ── Management ──────────────────────────────────────
console.log('\n── Collections ──');
console.log(`  Names: ${brain.listCollectionNames().join(', ')}`);
console.log(`  Decisions: ${decisions.count()}, Investigations: ${investigations.count()}`);
console.log(`  Tagged 'architecture': ${decisions.list({ tags: ['architecture'] }).length} items`);

await brain.close();
fs.unlinkSync(DB);
console.log('\n✓ Done\n');

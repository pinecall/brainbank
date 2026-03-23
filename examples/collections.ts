/**
 * BrainBank Collections Example
 * Run: npx tsx examples/collections.ts
 */
import { BrainBank } from '../src/index.ts';

const brain = new BrainBank({
    dbPath: '/tmp/brainbank-example.db',
});
await brain.initialize();

// ── Conversation Memory ─────────────────────────────
const conversations = brain.collection('conversations');

await conversations.add(
    'User asked to refactor the authentication module from Express middleware ' +
    'to a dedicated AuthService class. We discussed the trade-offs of dependency ' +
    'injection vs singleton pattern. Decided on DI with constructor injection ' +
    'to keep it testable. Implemented in src/auth/auth-service.ts with JWT ' +
    'validation, refresh token rotation, and role-based access control.',
    { tags: ['auth', 'refactor'], metadata: { session: '2024-03-15' } }
);

await conversations.add(
    'Spent 2 hours debugging a race condition in the WebSocket connection pool. ' +
    'The issue was that disconnect events were firing before the reconnect timer ' +
    'could clean up stale connections. Fixed by adding a 500ms debounce on ' +
    'disconnect and a connection state machine (connecting → connected → ' +
    'disconnecting → disconnected). Tests added in test/ws-pool.test.ts.',
    { tags: ['websocket', 'debugging'], metadata: { session: '2024-03-18' } }
);

console.log('\n── Conversation Search ──');
const authHits = await conversations.search('authentication architecture decisions');
console.log(`Query: "authentication architecture decisions"`);
console.log(`  → ${authHits[0]?.content.slice(0, 80)}...`);
console.log(`  Score: ${authHits[0]?.score.toFixed(3)}`);

const wsHits = await conversations.search('websocket race condition');
console.log(`Query: "websocket race condition"`);
console.log(`  → ${wsHits[0]?.content.slice(0, 80)}...`);
console.log(`  Score: ${wsHits[0]?.score.toFixed(3)}`);

// ── Architecture Decisions ──────────────────────────
const decisions = brain.collection('decisions');

await decisions.add(
    'ADR-012: Use SQLite with WAL mode for the local knowledge store instead of ' +
    'PostgreSQL. Rationale: BrainBank should be portable (single file), work ' +
    'offline, and require zero infrastructure. Trade-off: no multi-process writes, ' +
    'but BrainBank instances are single-process by design.',
    { tags: ['architecture', 'storage'] }
);

await decisions.add(
    'ADR-015: Migrate from Express to Fastify for the API layer. Rationale: ' +
    'Fastify provides schema-based validation out of the box, 2x throughput ' +
    'in benchmarks, and native TypeScript support. Migration path: replace ' +
    'route handlers one module at a time, starting with /api/auth.',
    {
        tags: ['architecture', 'api'],
        metadata: {
            conversation: 'session-2024-03-15',
            files: ['src/api/server.ts', 'src/api/routes/auth.ts'],
        },
    }
);

console.log('\n── Decision Search ──');
const pgHits = await decisions.search('why not postgres');
console.log(`Query: "why not postgres"`);
console.log(`  → ${pgHits[0]?.content.slice(0, 80)}...`);
console.log(`  Score: ${pgHits[0]?.score.toFixed(3)}`);

const apiHits = await decisions.search('express vs fastify');
console.log(`Query: "express vs fastify"`);
console.log(`  → ${apiHits[0]?.content.slice(0, 80)}...`);
console.log(`  Score: ${apiHits[0]?.score.toFixed(3)}`);
console.log(`  Linked files: ${apiHits[0]?.metadata?.files}`);

// ── Cross-collection search ─────────────────────────
console.log('\n── Cross-Collection ──');
const allNames = brain.listCollectionNames();
console.log(`Collections: ${allNames.join(', ')}`);
console.log(`Conversations: ${conversations.count()} items`);
console.log(`Decisions: ${decisions.count()} items`);

// ── Management ──────────────────────────────────────
console.log('\n── Management ──');
const list = conversations.list({ limit: 5 });
console.log(`Latest conversations: ${list.length} items`);

const tagged = conversations.list({ tags: ['auth'] });
console.log(`Tagged 'auth': ${tagged.length} items`);

await brain.close();

// Clean up
import * as fs from 'node:fs';
fs.unlinkSync('/tmp/brainbank-example.db');
console.log('\n✓ Example completed successfully\n');

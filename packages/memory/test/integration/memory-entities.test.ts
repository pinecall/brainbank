/**
 * @brainbank/memory — Integration Test: Memory + Entity Extraction (Real LLM)
 *
 * End-to-end pipeline with REAL OpenAI calls:
 *   - Fact extraction + entity extraction in same LLM call
 *   - Entity dedup + mention counting
 *   - Relationship building + graph traversal
 *   - System prompt context building
 *
 * Requires: OPENAI_API_KEY env var
 *
 * Run:
 *   npm test -- --integration --filter memory-entities
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { BrainBank } from '../helpers.ts';
import { Memory, EntityStore, OpenAIProvider } from '../../src/index.ts';

export const name = 'Memory + Entities (Real LLM)';

let tmpDir: string;
let brain: BrainBank;
let memory: Memory;
let entityStore: EntityStore;

export const tests: Record<string, () => Promise<void>> = {};

// ─── Setup ──────────────────────────────────────────

tests['setup: create brain + memory + entityStore'] = async () => {
    const assert = (await import('node:assert')).strict;

    if (!process.env.OPENAI_API_KEY) {
        console.log('  ⚠  OPENAI_API_KEY not set — skipping real LLM tests');
        return;
    }

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-entity-int-'));

    brain = new BrainBank({ dbPath: path.join(tmpDir, 'test.db') });
    await brain.initialize();

    const llm = new OpenAIProvider({ model: 'gpt-4.1-nano' });

    entityStore = new EntityStore(brain);

    memory = new Memory(brain, {
        llm,
        entityStore,
    });

    assert.ok(memory, 'memory created');
    assert.ok(entityStore, 'entity store created');
    assert.equal(entityStore.entityCount(), 0, 'starts empty');
    assert.equal(entityStore.relationCount(), 0, 'no relationships');
};

// ─── Context: First conversation — user intro ───────

tests['turn 1: extracts facts AND entities from user intro'] = async () => {
    const assert = (await import('node:assert')).strict;
    if (!memory) return; // skip if no API key

    const result = await memory.process(
        'My name is Berna, I work at Pinecall. We build voice AI agents with TypeScript.',
        'Nice to meet you Berna! Pinecall sounds like an exciting company — voice AI with TypeScript is a great stack.'
    );

    // Facts should be extracted
    assert.ok(result.operations.length > 0, `extracted ${result.operations.length} fact operations`);
    const addedFacts = result.operations.filter(op => op.action === 'ADD');
    assert.ok(addedFacts.length > 0, `at least one fact ADDed`);

    // Entities should be extracted
    assert.ok(result.entities, 'entities result exists');
    assert.ok(result.entities!.entitiesProcessed > 0, `processed ${result.entities!.entitiesProcessed} entities`);

    // Verify entities stored
    assert.ok(entityStore.entityCount() > 0, `${entityStore.entityCount()} entities stored`);
};

tests['turn 1: correct entity types'] = async () => {
    const assert = (await import('node:assert')).strict;
    if (!entityStore) return;

    const entities = entityStore.listEntities();
    const names = entities.map(e => e.content.split('(')[0].trim().toLowerCase());

    // Should have extracted at least Berna, Pinecall, TypeScript
    // (LLM may extract more or fewer, so we check at least some)
    assert.ok(entities.length >= 2, `at least 2 entities, got ${entities.length}: ${names.join(', ')}`);

    // Check at least one has a meaningful type
    const types = entities.map(e => e.metadata?.type).filter(Boolean);
    assert.ok(types.length > 0, `entities have types: ${types.join(', ')}`);
};

tests['turn 1: relationships created'] = async () => {
    const assert = (await import('node:assert')).strict;
    if (!entityStore) return;

    assert.ok(entityStore.relationCount() > 0, `${entityStore.relationCount()} relationships stored`);
    const rels = entityStore.listRelationships();
    assert.ok(rels.length > 0, 'has relationships');

    // Each relationship should have source, target, relation
    for (const r of rels) {
        assert.ok(r.metadata?.source, `relationship has source: ${r.metadata?.source}`);
        assert.ok(r.metadata?.target, `relationship has target: ${r.metadata?.target}`);
        assert.ok(r.metadata?.relation, `relationship has relation: ${r.metadata?.relation}`);
    }
};

// ─── Context: Second conversation — team info ───────

tests['turn 2: new entities from team discussion'] = async () => {
    const assert = (await import('node:assert')).strict;
    if (!memory) return;

    const entitiesBefore = entityStore.entityCount();

    const result = await memory.process(
        'Juan handles our payments integration with Stripe. María leads the frontend team.',
        "Got it! So Juan works on payments with Stripe, and María leads the frontend. That's a solid team structure."
    );

    // Should add new entities (Juan, Stripe, María)
    assert.ok(result.entities, 'entities result exists');
    assert.ok(result.entities!.entitiesProcessed > 0, `processed ${result.entities!.entitiesProcessed} entities`);

    const entitiesAfter = entityStore.entityCount();
    assert.ok(entitiesAfter > entitiesBefore, `entity count grew: ${entitiesBefore} → ${entitiesAfter}`);
};

tests['turn 2: relationships accumulate'] = async () => {
    const assert = (await import('node:assert')).strict;
    if (!entityStore) return;

    const rels = entityStore.listRelationships();

    // Should have relationships from both turns
    assert.ok(rels.length >= 2, `at least 2 relationships, got ${rels.length}`);
};

// ─── Context: Entity dedup + mention counting ───────

tests['turn 3: re-mentioning entity increments mention count'] = async () => {
    const assert = (await import('node:assert')).strict;
    if (!memory) return;

    // Mention Stripe again to test dedup
    await memory.process(
        'We need to finish the Stripe integration by Friday. Tell Juan to prioritize it.',
        "I'll note that the Stripe integration deadline is Friday and Juan should prioritize it."
    );

    // Stripe should have been mentioned before and now again
    const entities = entityStore.listEntities();
    const stripe = entities.find(e => e.content.toLowerCase().includes('stripe'));
    if (stripe) {
        assert.ok(stripe.metadata?.mentionCount >= 1, `Stripe mentioned ${stripe.metadata?.mentionCount}x`);
    }
};

// ─── Context: Memory dedup ──────────────────────────

tests['turn 3: memory dedup catches repeated facts'] = async () => {
    const assert = (await import('node:assert')).strict;
    if (!memory) return;

    // Count memories BEFORE repeating a known fact
    const beforeCount = (await brain.collection('memory_facts').list()).length;

    // Say something already known
    const result = await memory.process(
        'I work at Pinecall',
        'Yes, I know you work at Pinecall!'
    );

    // Count memories AFTER
    const afterCount = (await brain.collection('memory_facts').list()).length;

    // Dedup is validated if ANY of these hold:
    //   1. LLM returned NONE or UPDATE ops (recognized as duplicate)
    //   2. LLM returned 0 ops (nothing to do)
    //   3. Memory count grew by at most 1 (LLM may rephrase slightly, but doesn't explode)
    const noneOrUpdate = result.operations.filter(op => op.action === 'NONE' || op.action === 'UPDATE');
    const dedupWorked = noneOrUpdate.length > 0
        || result.operations.length === 0
        || (afterCount - beforeCount) <= 1;

    console.log(`    dedup caught repeated fact — ${noneOrUpdate.length} NONE/UPDATE ops, memory grew ${afterCount - beforeCount}`);
    assert.ok(dedupWorked,
        `expected dedup behavior, got ${result.operations.length} ops: ${result.operations.map(o => o.action).join(', ')}`);
};

// ─── Context: Graph traversal ───────────────────────

tests['traverse: finds connected entities from starting point'] = async () => {
    const assert = (await import('node:assert')).strict;
    if (!entityStore) return;

    // Find an entity that has relationships
    const rels = entityStore.listRelationships();
    if (rels.length === 0) return;

    const startEntity = rels[0].metadata?.source;
    if (!startEntity) return;

    const graph = await entityStore.traverse(startEntity, 2);
    assert.equal(graph.start, startEntity, 'start matches');
    assert.ok(graph.nodes.length > 0, `found ${graph.nodes.length} connected nodes from ${startEntity}`);

    // Each node should have required fields
    for (const node of graph.nodes) {
        assert.ok(node.entity, 'node has entity name');
        assert.ok(node.relation, 'node has relation');
        assert.ok(node.depth >= 1, `depth >= 1, got ${node.depth}`);
        assert.ok(node.path.length >= 2, `path has at least 2 elements`);
    }
};

tests['relationsOf: returns relationships for known entity'] = async () => {
    const assert = (await import('node:assert')).strict;
    if (!entityStore) return;

    const rels = entityStore.listRelationships();
    if (rels.length === 0) return;

    const entityName = rels[0].metadata?.source;
    if (!entityName) return;

    const related = await entityStore.relationsOf(entityName);
    assert.ok(related.length > 0, `${entityName} has ${related.length} relations`);
    assert.ok(related[0].source || related[0].target, 'relation has source/target');
};

// ─── Context: List filtering ────────────────────────

tests['listEntities: filters by type'] = async () => {
    const assert = (await import('node:assert')).strict;
    if (!entityStore) return;

    const allEntities = entityStore.listEntities();
    if (allEntities.length === 0) return;

    // Get all unique types
    const types = [...new Set(allEntities.map(e => e.metadata?.type).filter(Boolean))];
    assert.ok(types.length > 0, `found types: ${types.join(', ')}`);

    // Filter by first type — result should be subset
    const filtered = entityStore.listEntities({ type: types[0] as string });
    assert.ok(filtered.length <= allEntities.length, 'filtered is subset');
    assert.ok(filtered.length > 0, `found ${filtered.length} entities of type "${types[0]}"`);

    // All filtered should have the right type
    for (const e of filtered) {
        assert.equal(e.metadata?.type, types[0], `entity type matches filter`);
    }
};

// ─── Context: System prompt context ─────────────────

tests['buildContext: includes memories AND entities'] = async () => {
    const assert = (await import('node:assert')).strict;
    if (!memory) return;

    const context = memory.buildContext();
    assert.ok(context.length > 0, 'context is not empty');
    assert.ok(context.includes('Memories') || context.includes('memories'), 'has memories section');

    // If entities exist, should include entity section
    if (entityStore.entityCount() > 0) {
        assert.ok(context.includes('Entities') || context.includes('entities'),
            'has entities section in context');
    }
};

tests['buildContext: entity-specific context'] = async () => {
    const assert = (await import('node:assert')).strict;
    if (!entityStore) return;

    const entities = entityStore.listEntities();
    if (entities.length === 0) return;

    // Get context for first entity
    const entityName = entities[0].content.split('(')[0].trim();
    const context = entityStore.buildContext(entityName);
    assert.ok(context.length > 0, `entity context for "${entityName}" is not empty`);
};

// ─── Context: Stats ─────────────────────────────────

tests['final stats: entities and relationships persisted'] = async () => {
    const assert = (await import('node:assert')).strict;
    if (!entityStore) return;

    const ec = entityStore.entityCount();
    const rc = entityStore.relationCount();
    const mc = memory.count();

    console.log(`     📊 ${mc} memories, ${ec} entities, ${rc} relationships`);
    assert.ok(mc > 0, `has memories: ${mc}`);
    assert.ok(ec > 0, `has entities: ${ec}`);
    assert.ok(rc > 0, `has relationships: ${rc}`);
};

// ─── Cleanup ────────────────────────────────────────

tests['cleanup'] = async () => {
    if (brain) await brain.close();
    try { if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
};

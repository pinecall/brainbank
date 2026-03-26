/**
 * 🧠 BrainBank Memory — Fact Extraction + Entity Graph
 *
 * Interactive chatbot with automatic memory: extracts facts and entities
 * from every conversation turn, remembers across sessions.
 *
 * Run:
 *   OPENAI_API_KEY=sk-... npx tsx examples/memory/memory.ts
 *   OPENAI_API_KEY=sk-... npx tsx examples/memory/memory.ts --llm vercel
 *   OPENAI_API_KEY=sk-... npx tsx examples/memory/memory.ts --llm langchain
 *
 * Commands: quit, memories, entities
 */

import { BrainBank } from '../../src/index.ts';
import { Memory, EntityStore, OpenAIProvider } from '../../packages/memory/src/index.ts';
import { createDriver, parseBackend, parseModel } from '../lib/driver.ts';
import type { LLMProvider } from '../../packages/memory/src/index.ts';
import * as ui from '../lib/ui.ts';

// ─── Config ─────────────────────────────────────────

const backend = parseBackend();
const model = parseModel();
const DB_PATH = '.brainbank/memory-example.db';

if (!process.env.OPENAI_API_KEY) {
    console.error(`${ui.c.yellow}⚠  Set OPENAI_API_KEY${ui.c.reset}`);
    process.exit(1);
}

// ─── BrainBank + Memory + Entities ──────────────────

const brain = new BrainBank({ dbPath: DB_PATH });
await brain.initialize();

const llm = new OpenAIProvider({ model });
const driver = await createDriver(backend, model);

const entityStore = new EntityStore(brain, {
    onEntity: (op) => ui.entityEvent(op),
});

const memory = new Memory(brain, {
    llm,
    entityStore,
    onOperation: (op) => ui.memoryOp(op.action, op.fact, op.reason),
});

// ─── System Prompt ──────────────────────────────────

function systemPrompt(): string {
    return 'You are a helpful assistant with long-term memory. ' +
        'You remember facts about the user from past conversations. ' +
        'Use your memories naturally — don\'t list them unless asked.\n\n' +
        memory.buildContext();
}

// ─── Main Loop ──────────────────────────────────────

ui.header('BrainBank Memory', `${model} (${backend})`, DB_PATH);
ui.showMemories(
    memory.recall(5), memory.count(),
    entityStore.entityCount(), entityStore.relationCount(),
);

const input = ui.createInput();
const history: { role: 'user' | 'assistant' | 'system'; content: string }[] = [];

while (true) {
    const msg = await input.ask(input.prompt);
    if (!msg.trim()) continue;
    if (msg.toLowerCase() === 'quit') break;
    if (msg.toLowerCase() === 'memories') { ui.listMemories(memory.recall(50)); continue; }
    if (msg.toLowerCase() === 'entities') { ui.listEntities(entityStore.listEntities(), entityStore.listRelationships()); continue; }

    history.push({ role: 'user', content: msg });

    ui.startResponse();
    const reply = await driver.stream(
        [{ role: 'system', content: systemPrompt() }, ...history],
        ui.writeChunk,
    );
    ui.endResponse();

    history.push({ role: 'assistant', content: reply });
    await memory.process(msg, reply);
    console.log();
}

input.close();
brain.close();
ui.bye();

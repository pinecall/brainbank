/**
 * 🧠 BrainBank Chatbot — Deterministic Memory + Entities (OpenAI)
 *
 * Automatic fact extraction + entity graph after every turn.
 * Uses @brainbank/memory for the pipeline and OpenAI directly for chat.
 *
 * Run:
 *   OPENAI_API_KEY=sk-... npx tsx examples/chatbot/chatbot.ts
 */

import { BrainBank } from '../../src/index.ts';
import { Memory, EntityStore, OpenAIProvider } from '../../packages/memory/src/index.ts';
import * as ui from './lib/ui.ts';

// ─── Config ─────────────────────────────────────────

const MODEL = 'gpt-4.1-nano';
const DB_PATH = '.brainbank/chatbot.db';

if (!process.env.OPENAI_API_KEY) {
    console.error(`${ui.c.yellow}⚠  Set OPENAI_API_KEY${ui.c.reset}`);
    process.exit(1);
}

// ─── BrainBank + Memory + Entities ──────────────────

const brain = new BrainBank({ dbPath: DB_PATH });
await brain.initialize();

const entityStore = new EntityStore({
    entityCollection: brain.collection('entities'),
    relationCollection: brain.collection('relationships'),
});

const memory = new Memory(brain.collection('memories'), {
    llm: new OpenAIProvider({ model: MODEL }),
    entityStore,
    onOperation: (op) => ui.memoryOp(op.action, op.fact, op.reason),
});

// ─── Chat (streaming) ───────────────────────────────

async function streamChat(messages: { role: string; content: string }[]): Promise<string> {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({ model: MODEL, messages, stream: true }),
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let full = '', buf = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
            if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
            try {
                const chunk = JSON.parse(line.slice(6)).choices?.[0]?.delta?.content;
                if (chunk) { ui.writeChunk(chunk); full += chunk; }
            } catch { /* skip */ }
        }
    }
    return full;
}

// ─── System Prompt ──────────────────────────────────

function systemPrompt(): string {
    return 'You are a helpful assistant with long-term memory. ' +
        'You remember facts about the user from past conversations. ' +
        'Use your memories naturally — don\'t list them unless asked.\n\n' +
        memory.buildContext();
}

// ─── Main Loop ──────────────────────────────────────

ui.header(MODEL, DB_PATH);
ui.showMemories(memory.recall(5), memory.count(), entityStore.entityCount(), entityStore.relationCount());

const input = ui.createInput();
const history: { role: string; content: string }[] = [];

while (true) {
    const msg = await input.ask(input.prompt);
    if (!msg.trim()) continue;
    if (msg.toLowerCase() === 'quit') break;
    if (msg.toLowerCase() === 'memories') { ui.listMemories(memory.recall(50)); continue; }
    if (msg.toLowerCase() === 'entities') { ui.listEntities(entityStore.listEntities(), entityStore.listRelationships()); continue; }

    history.push({ role: 'user', content: msg });

    ui.startResponse();
    const reply = await streamChat([{ role: 'system', content: systemPrompt() }, ...history]);
    ui.endResponse();

    history.push({ role: 'assistant', content: reply });
    const result = await memory.process(msg, reply);
    if (result.entities) ui.entityOp(result.entities.entitiesProcessed, result.entities.relationshipsProcessed);
    console.log();
}

input.close();
await brain.close();
ui.bye();

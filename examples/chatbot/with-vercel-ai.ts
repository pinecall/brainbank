/**
 * 🧠 BrainBank Chatbot — Vercel AI SDK Integration
 *
 * Same deterministic memory pipeline, using Vercel AI SDK for the LLM.
 * No Vercel API key needed — uses your OPENAI_API_KEY directly.
 *
 * Install:
 *   npm install ai @ai-sdk/openai
 *
 * Run:
 *   OPENAI_API_KEY=sk-... npx tsx examples/chatbot/with-vercel-ai.ts
 */

import { BrainBank } from '../../src/index.ts';
import { Memory } from '../../packages/memory/src/index.ts';
import type { LLMProvider, ChatMessage } from '../../packages/memory/src/index.ts';
import { generateText, streamText } from 'ai';
import { openai } from '@ai-sdk/openai';
import * as ui from './lib/ui.ts';

// ─── Config ─────────────────────────────────────────

const MODEL = 'gpt-4.1-nano';
const DB_PATH = '.brainbank/chatbot-vercel.db';

// ─── Vercel AI SDK → LLMProvider adapter ────────────

const vercelProvider: LLMProvider = {
    generate: async (messages: ChatMessage[], opts) => {
        const { text } = await generateText({
            model: openai(MODEL),
            messages: messages.map(m => ({
                role: m.role as 'system' | 'user' | 'assistant',
                content: m.content,
            })),
            maxTokens: opts?.maxTokens ?? 500,
        });
        return text;
    },
};

// ─── BrainBank + Memory ─────────────────────────────

const brain = new BrainBank({ dbPath: DB_PATH });
await brain.initialize();

const memory = new Memory(brain.collection('memories'), {
    llm: vercelProvider,
    onOperation: (op) => ui.memoryOp(op.action, op.fact, op.reason),
});

// ─── Chat (Vercel AI streaming) ─────────────────────

async function chat(history: { role: string; content: string }[]): Promise<string> {
    const system = 'You are a helpful assistant with long-term memory.\n\n' + memory.buildContext();

    const result = streamText({
        model: openai(MODEL),
        messages: [
            { role: 'system' as const, content: system },
            ...history.map(m => ({
                role: m.role as 'user' | 'assistant',
                content: m.content,
            })),
        ],
    });

    let full = '';
    for await (const chunk of result.textStream) {
        ui.writeChunk(chunk);
        full += chunk;
    }
    return full;
}

// ─── Main Loop ──────────────────────────────────────

ui.header(`${MODEL} (Vercel AI SDK)`, DB_PATH);
ui.showMemories(memory.recall(5), memory.count());

const input = ui.createInput();
const history: { role: string; content: string }[] = [];

while (true) {
    const msg = await input.ask(input.prompt);
    if (!msg.trim()) continue;
    if (msg.toLowerCase() === 'quit') break;
    if (msg.toLowerCase() === 'memories') { ui.listMemories(memory.recall(50)); continue; }

    history.push({ role: 'user', content: msg });

    ui.startResponse();
    const reply = await chat(history);
    ui.endResponse();

    history.push({ role: 'assistant', content: reply });
    await memory.process(msg, reply);
    console.log();
}

input.close();
await brain.close();
ui.bye();

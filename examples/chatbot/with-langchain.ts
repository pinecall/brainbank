/**
 * 🧠 BrainBank Chatbot — LangChain Integration
 *
 * Same deterministic memory pipeline, using LangChain for the LLM.
 *
 * Install:
 *   npm install @langchain/openai
 *
 * Run:
 *   OPENAI_API_KEY=sk-... npx tsx examples/chatbot/with-langchain.ts
 */

import { BrainBank } from '../../src/index.ts';
import { Memory } from '../../packages/memory/src/index.ts';
import type { LLMProvider } from '../../packages/memory/src/index.ts';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import * as ui from './ui.ts';

// ─── Config ─────────────────────────────────────────

const MODEL = 'gpt-4.1-nano';
const DB_PATH = '.brainbank/chatbot-langchain.db';

// ─── LangChain → LLMProvider adapter ────────────────

const model = new ChatOpenAI({ model: MODEL, temperature: 0 });

const langchainProvider: LLMProvider = {
    generate: async (messages, opts) => {
        const mapped = messages.map(m =>
            m.role === 'system' ? new SystemMessage(m.content) : new HumanMessage(m.content)
        );
        const res = await model.invoke(mapped);
        return typeof res.content === 'string' ? res.content : JSON.stringify(res.content);
    },
};

// ─── BrainBank + Memory ─────────────────────────────

const brain = new BrainBank({ dbPath: DB_PATH });
await brain.initialize();

const memory = new Memory(brain.collection('memories'), {
    llm: langchainProvider,
    onOperation: (op) => ui.memoryOp(op.action, op.fact, op.reason),
});

// ─── Chat (LangChain streaming) ─────────────────────

async function chat(history: { role: string; content: string }[]): Promise<string> {
    const system = 'You are a helpful assistant with long-term memory.\n\n' + memory.buildContext();
    const messages = [
        new SystemMessage(system),
        ...history.map(m => new HumanMessage(m.content)),
    ];

    const stream = await model.stream(messages);
    let full = '';

    for await (const chunk of stream) {
        const text = typeof chunk.content === 'string' ? chunk.content : '';
        if (text) { ui.writeChunk(text); full += text; }
    }
    return full;
}

// ─── Main Loop ──────────────────────────────────────

ui.header(`${MODEL} (LangChain)`, DB_PATH);
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

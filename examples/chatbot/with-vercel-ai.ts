/**
 * 🧠 BrainBank Chatbot — Vercel AI SDK + Memory + RAG
 *
 * Same deterministic memory pipeline + entity graph + docs RAG, using Vercel AI SDK.
 * No Vercel API key needed — uses your OPENAI_API_KEY directly.
 *
 * Install:
 *   npm install ai @ai-sdk/openai
 *
 * Run (memory only):
 *   OPENAI_API_KEY=sk-... npx tsx examples/chatbot/with-vercel-ai.ts
 *
 * Run (memory + RAG):
 *   OPENAI_API_KEY=sk-... PERPLEXITY_API_KEY=pplx-... npx tsx examples/chatbot/with-vercel-ai.ts --docs ~/path/to/docs
 *
 * Commands: quit, memories, entities, docs <query>
 */

import { BrainBank } from '../../src/index.ts';
import { PerplexityContextEmbedding } from '../../src/providers/embeddings/perplexity-context-embedding.ts';
import { docs } from '../../src/indexers/docs/docs-plugin.ts';
import { Memory, EntityStore } from '../../packages/memory/src/index.ts';
import type { LLMProvider, ChatMessage } from '../../packages/memory/src/index.ts';
import { generateText, streamText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { parseDocsPath, createDocsEmbedding, indexDocs, buildRAGContext, searchDocs } from './lib/rag.ts';
import * as ui from './lib/ui.ts';

// ─── Config ─────────────────────────────────────────

const MODEL = 'gpt-4.1-nano';
const docsPath = parseDocsPath();
const DB_PATH = docsPath ? '.brainbank/chatbot-vercel-rag.db' : '.brainbank/chatbot-vercel.db';

if (!process.env.OPENAI_API_KEY) {
    console.error(`${ui.c.yellow}⚠  Set OPENAI_API_KEY${ui.c.reset}`);
    process.exit(1);
}
if (docsPath && !process.env.PERPLEXITY_API_KEY) {
    console.error(`${ui.c.yellow}⚠  Set PERPLEXITY_API_KEY (required for docs RAG)${ui.c.reset}`);
    process.exit(1);
}

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

// ─── BrainBank + Memory + Entities + Docs ───────────

const pplxEmbed = docsPath ? createDocsEmbedding() : undefined;

const brain = new BrainBank({
    dbPath: DB_PATH,
    embeddingProvider: pplxEmbed,
    embeddingDims: pplxEmbed?.dims,
});

if (docsPath) brain.use(docs());

await brain.initialize();

const entityStore = new EntityStore(brain, {
    onEntity: (op) => ui.entityEvent(op),
});

const memory = new Memory(brain, {
    llm: vercelProvider,
    entityStore,
    onOperation: (op) => ui.memoryOp(op.action, op.fact, op.reason),
});

// Index docs if path provided
let docChunks = 0;
if (docsPath) {
    docChunks = await indexDocs(brain, docsPath);
}

// ─── Chat (Vercel AI streaming) ─────────────────────

async function chat(history: { role: string; content: string }[], userQuery: string): Promise<string> {
    let system = 'You are a helpful assistant with long-term memory.\n\n' + memory.buildContext();

    if (docsPath && docChunks > 0) {
        const ragContext = await buildRAGContext(brain, userQuery);
        if (ragContext) {
            system += '\n\n' + ragContext +
                '\n\nUse the documentation above to answer technical questions accurately. ' +
                'Cite the document title when referencing docs.';
        }
    }

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

const mode = docsPath ? `${MODEL} (Vercel AI + RAG)` : `${MODEL} (Vercel AI SDK)`;
ui.header(mode, DB_PATH);
if (docChunks > 0) {
    console.log(`${ui.c.blue}  📚 ${docChunks} doc chunks available for RAG${ui.c.reset}`);
}
ui.showMemories(memory.recall(5), memory.count(), entityStore.entityCount(), entityStore.relationCount(), docsPath ? docChunks : undefined);

const input = ui.createInput();
const history: { role: string; content: string }[] = [];

while (true) {
    const msg = await input.ask(input.prompt);
    if (!msg.trim()) continue;
    if (msg.toLowerCase() === 'quit') break;
    if (msg.toLowerCase() === 'memories') { ui.listMemories(memory.recall(50)); continue; }
    if (msg.toLowerCase() === 'entities') { ui.listEntities(entityStore.listEntities(), entityStore.listRelationships()); continue; }
    if (msg.toLowerCase().startsWith('docs ')) {
        const query = msg.slice(5).trim();
        await searchDocs(brain, query);
        history.push({ role: 'user', content: query });
        ui.startResponse();
        const reply = await chat(history, query);
        ui.endResponse();
        history.push({ role: 'assistant', content: reply });
        await memory.process(query, reply);
        console.log();
        continue;
    }

    history.push({ role: 'user', content: msg });

    ui.startResponse();
    const reply = await chat(history, msg);
    ui.endResponse();

    history.push({ role: 'assistant', content: reply });
    await memory.process(msg, reply);
    console.log();
}

input.close();
brain.close();
ui.bye();

/**
 * 🧠 BrainBank Chatbot — Memory + RAG over Docs (OpenAI)
 *
 * Automatic fact extraction + entity graph + docs retrieval.
 * Uses @brainbank/memory for the pipeline and OpenAI directly for chat.
 *
 * Run (memory only):
 *   OPENAI_API_KEY=sk-... npx tsx examples/chatbot/chatbot.ts
 *
 * Run (memory + RAG):
 *   OPENAI_API_KEY=sk-... npx tsx examples/chatbot/chatbot.ts --docs ~/path/to/docs
 *
 * Commands: quit, memories, entities, docs <query>
 */

import { BrainBank } from '../../src/index.ts';
import { PerplexityContextEmbedding } from '../../src/providers/embeddings/perplexity-context-embedding.ts';
import { docs } from '../../src/indexers/docs/docs-plugin.ts';
import { Memory, EntityStore, OpenAIProvider } from '../../packages/memory/src/index.ts';
import { parseDocsPath, createDocsEmbedding, indexDocs, buildRAGContext, searchDocs } from './lib/rag.ts';
import * as ui from './lib/ui.ts';

// ─── Config ─────────────────────────────────────────

const MODEL = 'gpt-4.1-nano';
const docsPath = parseDocsPath();
const DB_PATH = docsPath ? '.brainbank/chatbot-rag.db' : '.brainbank/chatbot.db';

if (!process.env.OPENAI_API_KEY) {
    console.error(`${ui.c.yellow}⚠  Set OPENAI_API_KEY${ui.c.reset}`);
    process.exit(1);
}
if (docsPath && !process.env.PERPLEXITY_API_KEY) {
    console.error(`${ui.c.yellow}⚠  Set PERPLEXITY_API_KEY (required for docs RAG)${ui.c.reset}`);
    process.exit(1);
}

// ─── BrainBank + Memory + Entities + Docs ───────────

const pplxEmbed = docsPath ? createDocsEmbedding() : undefined;

const brain = new BrainBank({
    dbPath: DB_PATH,
    embeddingProvider: pplxEmbed,
    embeddingDims: pplxEmbed?.dims,
});

if (docsPath) brain.use(docs());

await brain.initialize();

const llm = new OpenAIProvider({ model: MODEL });

const entityStore = new EntityStore(brain, {
    onEntity: (op) => ui.entityEvent(op),
});

const memory = new Memory(brain, {
    llm,
    entityStore,
    onOperation: (op) => ui.memoryOp(op.action, op.fact, op.reason),
});

// Index docs if path provided
let docChunks = 0;
if (docsPath) {
    docChunks = await indexDocs(brain, docsPath);
}

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

async function systemPrompt(userQuery: string): Promise<string> {
    let prompt = 'You are a helpful assistant with long-term memory. ' +
        'You remember facts about the user from past conversations. ' +
        'Use your memories naturally — don\'t list them unless asked.\n\n' +
        memory.buildContext();

    if (docsPath && docChunks > 0) {
        const ragContext = await buildRAGContext(brain, userQuery);
        if (ragContext) {
            prompt += '\n\n' + ragContext +
                '\n\nUse the documentation above to answer technical questions accurately. ' +
                'Cite the document title when referencing docs.';
        }
    }

    return prompt;
}

// ─── Main Loop ──────────────────────────────────────

const mode = docsPath ? `${MODEL} + RAG` : MODEL;
ui.header(mode, DB_PATH);
if (docChunks > 0) {
    console.log(`${ui.c.blue}  📚 ${docChunks} doc chunks available for RAG${ui.c.reset}`);
}
ui.showMemories(memory.recall(5), memory.count(), entityStore.entityCount(), entityStore.relationCount());

const docsHint = docsPath ? ' · "docs <query>" to search docs' : '';
console.log(`${ui.c.dim}  Type "quit" to exit · "memories" to list · "entities" to see graph${docsHint}${ui.c.reset}\n`);

const input = ui.createInput();
const history: { role: string; content: string }[] = [];

while (true) {
    const msg = await input.ask(input.prompt);
    if (!msg.trim()) continue;
    if (msg.toLowerCase() === 'quit') break;
    if (msg.toLowerCase() === 'memories') { ui.listMemories(memory.recall(50)); continue; }
    if (msg.toLowerCase() === 'entities') { ui.listEntities(entityStore.listEntities(), entityStore.listRelationships()); continue; }
    if (msg.toLowerCase().startsWith('docs ')) { await searchDocs(brain, msg.slice(5).trim()); continue; }

    history.push({ role: 'user', content: msg });

    ui.startResponse();
    const system = await systemPrompt(msg);
    const reply = await streamChat([{ role: 'system', content: system }, ...history]);
    ui.endResponse();

    history.push({ role: 'assistant', content: reply });
    await memory.process(msg, reply);
    console.log();
}

input.close();
brain.close();
ui.bye();

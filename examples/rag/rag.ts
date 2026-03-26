/**
 * 📚 BrainBank RAG — Docs Chatbot (Pure RAG, No Memory)
 *
 * Index local documentation and answer questions using RAG.
 * No memory extraction — just retrieval and generation.
 *
 * Run:
 *   OPENAI_API_KEY=sk-... PERPLEXITY_API_KEY=pplx-... \
 *     npx tsx examples/rag/rag.ts --docs ~/path/to/docs
 *
 * Flags:
 *   --docs <path>   Path to docs folder (required)
 *   --llm native|vercel|langchain  (default: native)
 *   --model <name>  (default: gpt-4.1-nano)
 */

import { BrainBank } from '../../src/index.ts';
import { docs } from '../../src/indexers/docs/docs-plugin.ts';
import { PerplexityContextEmbedding } from '../../src/providers/embeddings/perplexity-context-embedding.ts';
import { createDriver, parseBackend, parseModel } from '../lib/driver.ts';
import type { SearchResult } from '../../src/types.ts';
import * as ui from '../lib/ui.ts';

// ─── Config ─────────────────────────────────────────

const backend = parseBackend();
const model = parseModel();

function parseDocsPath(): string {
    const idx = process.argv.indexOf('--docs');
    if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
    const env = process.env.BRAINBANK_DOCS;
    if (env) return env;
    console.error(`${ui.c.red}⚠  Usage: npx tsx examples/rag/rag.ts --docs <path>${ui.c.reset}`);
    process.exit(1);
}

const docsPath = parseDocsPath();
const DB_PATH = '.brainbank/rag-example.db';

if (!process.env.OPENAI_API_KEY) {
    console.error(`${ui.c.yellow}⚠  Set OPENAI_API_KEY${ui.c.reset}`);
    process.exit(1);
}
if (!process.env.PERPLEXITY_API_KEY) {
    console.error(`${ui.c.yellow}⚠  Set PERPLEXITY_API_KEY for docs RAG${ui.c.reset}`);
    process.exit(1);
}

// ─── BrainBank + Perplexity Embeddings ──────────────

const pplxEmbed = new PerplexityContextEmbedding();
const brain = new BrainBank({
    dbPath: DB_PATH,
    embeddingProvider: pplxEmbed,
    embeddingDims: pplxEmbed.dims,
});
brain.use(docs());
await brain.initialize();

// ─── Index Docs ─────────────────────────────────────

const docsPlugin = brain.indexer('docs') as any;
docsPlugin.addCollection({
    name: 'project-docs',
    path: docsPath,
    pattern: '**/*.md',
    ignore: ['**/deprecated/**', '**/scratchpad/**'],
});

console.log(`${ui.c.dim}  📚 Indexing docs from ${docsPath}...${ui.c.reset}`);
const indexResults = await docsPlugin.indexCollections({
    onProgress: (_col: string, file: string, cur: number, total: number) => {
        process.stdout.write(`\r${ui.c.dim}  📚 [${cur}/${total}] ${file.slice(0, 50)}${ui.c.reset}      `);
    },
});
const stats = indexResults['project-docs'];
const docChunks = stats?.chunks ?? 0;
process.stdout.write('\r' + ' '.repeat(80) + '\r');
console.log(`${ui.c.green}  📚 ${docChunks} doc chunks indexed (${stats?.indexed ?? 0} files)${ui.c.reset}`);

// ─── LLM Driver ─────────────────────────────────────

const driver = await createDriver(backend, model);

// ─── RAG Helpers ────────────────────────────────────

/** Deduplicate results by file path. */
function dedupeByFile(results: SearchResult[]): SearchResult[] {
    const seen = new Map<string, SearchResult>();
    for (const r of results) {
        const key = r.filePath ?? '';
        if (!seen.has(key) || (seen.get(key)!.score < r.score)) {
            seen.set(key, r);
        }
    }
    return [...seen.values()];
}

/** Build RAG context for the system prompt. */
async function buildRAGContext(query: string): Promise<string> {
    const raw: SearchResult[] = await docsPlugin.search(query, { k: 10, minScore: 0.15 });
    const results = dedupeByFile(raw).slice(0, 5);
    if (results.length === 0) return '';

    const sections = results.map((r: SearchResult, i: number) => {
        const title = (r.metadata as any)?.title || r.filePath?.split('/').pop() || 'Doc';
        const score = (r.score * 100).toFixed(0);
        return `### ${i + 1}. ${title} (${score}% match)\n${r.content.slice(0, 1200)}`;
    });

    return `## Relevant Documentation\n\n${sections.join('\n\n')}`;
}

/** Search and display docs. */
async function searchDocs(query: string) {
    const raw: SearchResult[] = await docsPlugin.search(query, { k: 10, minScore: 0.1 });
    const results = dedupeByFile(raw).slice(0, 6);
    if (results.length === 0) {
        console.log(`${ui.c.dim}  No docs matched "${query}"${ui.c.reset}`);
        return;
    }
    console.log(`\n${ui.c.blue}  📚 ${results.length} doc results for "${query}":${ui.c.reset}`);
    for (const r of results) {
        const title = (r.metadata as any)?.title || r.filePath?.split('/').pop() || 'Doc';
        const score = (r.score * 100).toFixed(0);
        const preview = r.content.slice(0, 120).replace(/\n/g, ' ');
        console.log(`${ui.c.dim}     [${score}%] ${title}${ui.c.reset}`);
        console.log(`${ui.c.dim}           ${preview}...${ui.c.reset}`);
    }
    console.log();
}

// ─── System Prompt ──────────────────────────────────

async function systemPrompt(query: string): Promise<string> {
    let prompt = 'You are a helpful assistant with access to project documentation. ' +
        'Answer questions based on the docs provided.\n\n' +
        `You have access to ${docChunks} chunks from project documentation ` +
        'covering architecture, backend, frontend, database, security, operations, testing, and more. ' +
        'When the user asks broad questions, synthesize across ALL relevant docs.';

    const ragContext = await buildRAGContext(query);
    if (ragContext) {
        prompt += '\n\n' + ragContext +
            '\n\nUse the documentation above to answer comprehensively. ' +
            'Synthesize information from ALL relevant docs, not just one. ' +
            'Cite the document title when referencing docs.';
    }

    return prompt;
}

// ─── Main Loop ──────────────────────────────────────

ui.header('BrainBank RAG', `${model} (${backend})`, DB_PATH);
console.log(`${ui.c.blue}  📚 ${docChunks} doc chunks available${ui.c.reset}`);
console.log(`${ui.c.dim}  Commands: "quit" · "docs <query>" to search docs${ui.c.reset}\n`);

const input = ui.createInput();
const history: { role: 'user' | 'assistant' | 'system'; content: string }[] = [];

while (true) {
    const msg = await input.ask(input.prompt);
    if (!msg.trim()) continue;
    if (msg.toLowerCase() === 'quit') break;

    // docs command: search + generate answer
    if (msg.toLowerCase().startsWith('docs ')) {
        const query = msg.slice(5).trim();
        await searchDocs(query);
        history.push({ role: 'user', content: query });
        ui.startResponse();
        const system = await systemPrompt(query);
        const reply = await driver.stream(
            [{ role: 'system', content: system }, ...history],
            ui.writeChunk,
        );
        ui.endResponse();
        history.push({ role: 'assistant', content: reply });
        console.log();
        continue;
    }

    // Regular chat with RAG context
    history.push({ role: 'user', content: msg });
    ui.startResponse();
    const system = await systemPrompt(msg);
    const reply = await driver.stream(
        [{ role: 'system', content: system }, ...history],
        ui.writeChunk,
    );
    ui.endResponse();
    history.push({ role: 'assistant', content: reply });
    console.log();
}

input.close();
brain.close();
ui.bye();

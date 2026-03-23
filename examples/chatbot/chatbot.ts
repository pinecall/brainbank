/**
 * 🧠 BrainBank Chatbot — Deterministic Memory
 *
 * A CLI chatbot using @brainbank/memory for automatic fact extraction.
 * No function calling. Memory extraction runs on every turn.
 *
 * Run:
 *   OPENAI_API_KEY=sk-... npx tsx examples/chatbot/chatbot.ts
 */

import { BrainBank } from '../../src/index.ts';
import { Memory, OpenAIProvider } from '../../packages/memory/src/index.ts';
import * as readline from 'node:readline';

// ─── ANSI Colors ────────────────────────────────────
const c = {
    reset: '\x1b[0m',
    dim: '\x1b[2m',
    bold: '\x1b[1m',
    cyan: '\x1b[36m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    magenta: '\x1b[35m',
};

// ─── Config ─────────────────────────────────────────
const MODEL = 'gpt-4.1-nano';
const DB_PATH = '.brainbank/chatbot.db';

if (!process.env.OPENAI_API_KEY) {
    console.error(`${c.yellow}⚠  Set OPENAI_API_KEY to run this example${c.reset}`);
    console.error(`${c.dim}   OPENAI_API_KEY=sk-... npx tsx examples/chatbot/chatbot.ts${c.reset}`);
    process.exit(1);
}

// ─── Setup ──────────────────────────────────────────
const brain = new BrainBank({ dbPath: DB_PATH });
await brain.initialize();

const llm = new OpenAIProvider({ model: MODEL });

const memory = new Memory(brain.collection('memories'), {
    llm,
    onOperation: (op) => {
        const icon = op.action === 'ADD' ? '💾' : op.action === 'UPDATE' ? '🔄' : '⏭ ';
        const label = op.action === 'ADD' ? '+memory' : op.action === 'UPDATE' ? 'updated' : 'skip';
        const suffix = op.action === 'NONE' ? ` (${op.reason})` : '';
        console.log(`${c.dim}  ${icon} ${label}: ${op.fact}${suffix}${c.reset}`);
    },
});

// ─── Streaming Chat ─────────────────────────────────
async function chat(messages: { role: string; content: string }[]): Promise<string> {
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
    let full = '';
    let buf = '';

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
                if (chunk) { process.stdout.write(chunk); full += chunk; }
            } catch { /* skip */ }
        }
    }
    return full;
}

// ─── UI ─────────────────────────────────────────────
const memoryCount = memory.count();

console.log();
console.log(`${c.bold}${c.cyan}  🧠 BrainBank Chat${c.reset}`);
console.log(`${c.dim}  Model: ${MODEL} · DB: ${DB_PATH}${c.reset}`);

if (memoryCount > 0) {
    console.log(`${c.magenta}  💾 ${memoryCount} memories loaded${c.reset}`);
    for (const m of memory.recall(5)) {
        console.log(`${c.dim}     • ${m.content}${c.reset}`);
    }
} else {
    console.log(`${c.yellow}  🆕 First session — no memories yet${c.reset}`);
}

console.log(`${c.dim}  Type "quit" to exit · "memories" to list all${c.reset}`);
console.log();

// ─── REPL ───────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (p: string): Promise<string> => new Promise(r => rl.question(p, r));

const history: { role: string; content: string }[] = [];

while (true) {
    const input = await ask(`${c.cyan}  You → ${c.reset}`);
    if (!input.trim()) continue;

    if (input.toLowerCase() === 'quit') break;
    if (input.toLowerCase() === 'memories') {
        const all = memory.recall(50);
        console.log(`\n${c.magenta}  📋 ${all.length} memories:${c.reset}`);
        for (const m of all) console.log(`${c.dim}     • ${m.content}${c.reset}`);
        console.log();
        continue;
    }

    // Build system prompt with latest memories
    const system = 'You are a helpful assistant with long-term memory. ' +
        'You remember facts about the user from past conversations. ' +
        'Use your memories naturally — don\'t list them unless asked.\n\n' +
        memory.buildContext();

    history.push({ role: 'user', content: input });

    // Stream response
    process.stdout.write(`${c.green}  Bot → `);
    const reply = await chat([{ role: 'system', content: system }, ...history]);
    process.stdout.write(`${c.reset}\n`);

    history.push({ role: 'assistant', content: reply });

    // Deterministic memory extraction (every turn)
    await memory.process(input, reply);
    console.log();
}

rl.close();
await brain.close();
console.log(`${c.dim}  👋 Bye${c.reset}\n`);

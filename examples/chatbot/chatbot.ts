/**
 * 🧠 BrainBank Chatbot — Deterministic Memory
 *
 * A CLI chatbot with automatic memory extraction after every turn.
 * Inspired by mem0's pipeline: extract → dedup → ADD/UPDATE/NONE.
 *
 * Strategy:
 *   1. Context injection — recent memories loaded into system prompt
 *   2. Post-turn extraction — a second LLM call extracts atomic facts
 *      from the conversation, compares with existing memory, and
 *      decides ADD / UPDATE / NONE for each fact (deterministic, not optional)
 *
 * No function calling. Memory extraction happens on every turn automatically.
 *
 * Run:
 *   OPENAI_API_KEY=sk-... npx tsx examples/chatbot/chatbot.ts
 */

import { BrainBank } from '../../src/index.ts';
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
    gray: '\x1b[90m',
    red: '\x1b[31m',
};

// ─── Config ─────────────────────────────────────────
const API_KEY = process.env.OPENAI_API_KEY;
const MODEL = 'gpt-4.1-nano';
const DB_PATH = '.brainbank/chatbot.db';

if (!API_KEY) {
    console.error(`${c.yellow}⚠  Set OPENAI_API_KEY to run this example${c.reset}`);
    console.error(`${c.dim}   OPENAI_API_KEY=sk-... npx tsx examples/chatbot/chatbot.ts${c.reset}`);
    process.exit(1);
}

// ─── BrainBank Setup ────────────────────────────────
const brain = new BrainBank({ dbPath: DB_PATH });
await brain.initialize();

const memories = brain.collection('memories');

// ─── LLM Helpers ────────────────────────────────────
async function llm(messages: { role: string; content: string }[], json = false): Promise<string> {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
        body: JSON.stringify({
            model: MODEL,
            messages,
            ...(json ? { response_format: { type: 'json_object' } } : {}),
            max_tokens: 500,
        }),
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as any;
    return data.choices[0].message.content ?? '';
}

async function stream(messages: { role: string; content: string }[]): Promise<string> {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
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

// ─── Memory Pipeline ────────────────────────────────

const EXTRACT_PROMPT = `You are a memory extraction engine. Given a conversation between a user and an assistant, extract distinct atomic facts worth remembering for future conversations.

Focus on:
- User preferences (language, tools, patterns, style)
- User personal info (name, role, projects)
- Decisions made (architecture, design, technology choices)
- Important context (deadlines, constraints, goals)

Respond with JSON: { "facts": ["fact1", "fact2", ...] }
If there are no facts worth remembering, return: { "facts": [] }

Rules:
- Each fact should be a single, self-contained sentence
- Be specific, not vague ("prefers TypeScript" not "has programming preferences")
- Don't extract trivial info ("said hello", "asked a question")
- Max 5 facts per turn`;

const DEDUP_PROMPT = `You are a memory deduplication engine. Given a NEW fact and a list of EXISTING memories, decide what action to take.

Respond with JSON: { "action": "ADD" | "UPDATE" | "NONE", "reason": "brief reason" }

- ADD: the fact is genuinely new information not covered by any existing memory
- UPDATE: the fact updates, corrects, or adds detail to an existing memory (include "update_index" field with the 0-based index of the memory to update)
- NONE: the fact is already captured by an existing memory (duplicate or subset)

Be conservative: if a fact is already well-captured, say NONE.`;

interface DedupeResult {
    action: 'ADD' | 'UPDATE' | 'NONE';
    reason: string;
    update_index?: number;
}

async function extractAndStore(
    userMsg: string,
    assistantMsg: string,
): Promise<void> {
    // Step 1: Extract atomic facts from this turn
    const extraction = await llm([
        { role: 'system', content: EXTRACT_PROMPT },
        { role: 'user', content: `User: ${userMsg}\n\nAssistant: ${assistantMsg}` },
    ], true);

    let facts: string[];
    try {
        facts = JSON.parse(extraction).facts ?? [];
    } catch {
        return; // malformed response, skip
    }
    if (facts.length === 0) return;

    // Step 2: Get existing memories for dedup comparison
    const existing = memories.list({ limit: 50 });
    const existingTexts = existing.map(m => m.content);

    // Step 3: For each fact, decide ADD / UPDATE / NONE
    for (const fact of facts) {
        let action: DedupeResult = { action: 'ADD', reason: 'no existing memories' };

        if (existingTexts.length > 0) {
            // Search for similar existing memories
            const similar = await memories.search(fact, { k: 3 });
            if (similar.length > 0) {
                const context = similar
                    .map((m, i) => `[${i}] ${m.content}`)
                    .join('\n');

                const decision = await llm([
                    { role: 'system', content: DEDUP_PROMPT },
                    {
                        role: 'user',
                        content: `NEW FACT: "${fact}"\n\nEXISTING MEMORIES:\n${context}`,
                    },
                ], true);

                try {
                    action = JSON.parse(decision);
                } catch {
                    action = { action: 'ADD', reason: 'parse error, defaulting to ADD' };
                }
            }
        }

        // Step 4: Execute
        switch (action.action) {
            case 'ADD':
                await memories.add(fact);
                process.stdout.write(`${c.dim}  💾 +memory: ${fact}${c.reset}\n`);
                break;

            case 'UPDATE': {
                const idx = action.update_index ?? 0;
                const similar = await memories.search(fact, { k: 3 });
                if (similar[idx]) {
                    await memories.remove(similar[idx].id!);
                    await memories.add(fact);
                    process.stdout.write(`${c.dim}  🔄 updated: ${fact}${c.reset}\n`);
                }
                break;
            }

            case 'NONE':
                process.stdout.write(`${c.dim}  ⏭  skip: ${fact} (${action.reason})${c.reset}\n`);
                break;
        }
    }
}

// ─── Build System Prompt ────────────────────────────
function buildSystemPrompt(): string {
    const allMemories = memories.list({ limit: 20 });

    let prompt =
        'You are a helpful assistant with long-term memory. ' +
        'You remember facts about the user from past conversations. ' +
        'Use your memories naturally in conversation — don\'t list them unless asked.';

    if (allMemories.length > 0) {
        prompt += '\n\n## Your memories about this user\n';
        prompt += allMemories.map(m => `- ${m.content}`).join('\n');
    }

    return prompt;
}

// ─── UI ─────────────────────────────────────────────
const memoryCount = memories.count();

console.log();
console.log(`${c.bold}${c.cyan}  🧠 BrainBank Chat${c.reset}`);
console.log(`${c.dim}  Model: ${MODEL} · DB: ${DB_PATH}${c.reset}`);

if (memoryCount > 0) {
    console.log(`${c.magenta}  💾 ${memoryCount} memories loaded${c.reset}`);
    const mems = memories.list({ limit: 5 });
    for (const m of mems) {
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

const messages: { role: string; content: string }[] = [];

while (true) {
    const input = await ask(`${c.cyan}  You → ${c.reset}`);
    if (!input.trim()) continue;

    // Special commands
    if (input.toLowerCase() === 'quit') break;
    if (input.toLowerCase() === 'memories') {
        const all = memories.list({ limit: 50 });
        console.log(`\n${c.magenta}  📋 ${all.length} memories:${c.reset}`);
        for (const m of all) console.log(`${c.dim}     • ${m.content}${c.reset}`);
        console.log();
        continue;
    }

    // Rebuild system prompt with latest memories every turn
    const systemPrompt = buildSystemPrompt();

    messages.push({ role: 'user', content: input });

    // Chat (streaming)
    process.stdout.write(`${c.green}  Bot → `);
    const reply = await stream([{ role: 'system', content: systemPrompt }, ...messages]);
    process.stdout.write(`${c.reset}\n`);

    messages.push({ role: 'assistant', content: reply });

    // Memory extraction (deterministic — runs every turn)
    await extractAndStore(input, reply);
    console.log();
}

rl.close();
await brain.close();
console.log(`${c.dim}  👋 Bye${c.reset}\n`);

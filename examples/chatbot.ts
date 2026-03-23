/**
 * 🧠 BrainBank Chatbot — Memory That Persists
 *
 * A demo CLI chatbot with persistent long-term memory.
 * The model can recall past conversations and save new memories on its own.
 *
 * Strategy (hybrid approach):
 *   1. Context injection — recent session summaries loaded into system prompt
 *   2. Function calling — model decides when to search/save memories
 *
 * Features:
 *   - Streaming responses
 *   - ANSI colors (no dependencies)
 *   - Session summarization on exit
 *   - Semantic search across all past sessions
 *
 * Run:
 *   OPENAI_API_KEY=sk-... npx tsx examples/chatbot.ts
 */

import { BrainBank } from '../src/index.ts';
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
    bgDim: '\x1b[48;5;236m',
};

// ─── Config ─────────────────────────────────────────
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = 'gpt-4.1-nano';
const DB_PATH = '.brainbank/chatbot.db';
const MAX_RECENT_SESSIONS = 5;

if (!OPENAI_API_KEY) {
    console.error(`${c.yellow}⚠  Set OPENAI_API_KEY to run this example${c.reset}`);
    console.error(`${c.dim}   OPENAI_API_KEY=sk-... npx tsx examples/chatbot.ts${c.reset}`);
    process.exit(1);
}

// ─── BrainBank Setup ────────────────────────────────
const brain = new BrainBank({ dbPath: DB_PATH });
await brain.initialize();

const sessions = brain.collection('sessions');
const facts = brain.collection('facts');

// ─── Tool Definitions ───────────────────────────────
const tools = [
    {
        type: 'function' as const,
        function: {
            name: 'recall_memory',
            description:
                'Search long-term memory for relevant past conversations or facts. ' +
                'Use this when the user asks about something that might have been discussed before, ' +
                'or when you need context from past sessions.',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'Semantic search query to find relevant memories',
                    },
                    collection: {
                        type: 'string',
                        enum: ['sessions', 'facts'],
                        description: 'Which memory store to search (sessions = past conversations, facts = stored knowledge)',
                    },
                },
                required: ['query', 'collection'],
            },
        },
    },
    {
        type: 'function' as const,
        function: {
            name: 'save_fact',
            description:
                'Save an important fact or preference to long-term memory. ' +
                'Use this when the user explicitly shares a preference, important info, ' +
                'or asks you to remember something.',
            parameters: {
                type: 'object',
                properties: {
                    content: {
                        type: 'string',
                        description: 'The fact or preference to remember',
                    },
                    tags: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Short tags categorizing this fact',
                    },
                },
                required: ['content'],
            },
        },
    },
];

// ─── Tool Handlers ──────────────────────────────────
async function handleToolCall(name: string, args: Record<string, any>): Promise<string> {
    if (name === 'recall_memory') {
        const col = args.collection === 'facts' ? facts : sessions;
        const hits = await col.search(args.query, { k: 3 });
        if (hits.length === 0) return 'No relevant memories found.';
        return hits
            .map((h, i) => `[${i + 1}] (score: ${h.score.toFixed(2)}) ${h.content}`)
            .join('\n\n');
    }

    if (name === 'save_fact') {
        await facts.add(args.content, { tags: args.tags ?? [] });
        return `Saved to long-term memory: "${args.content}"`;
    }

    return 'Unknown tool';
}

// ─── Build System Prompt ────────────────────────────
function buildSystemPrompt(recentSessions: string[]): string {
    let prompt =
        'You are a helpful assistant with persistent long-term memory powered by BrainBank. ' +
        'You can recall past conversations and save important facts using your tools. ' +
        'When the user references something from the past, use recall_memory to search. ' +
        'When the user shares an important preference or fact, use save_fact to remember it.\n\n' +
        'Be conversational and natural. When you find relevant memories, weave them into ' +
        'your response naturally — don\'t just dump raw search results.';

    if (recentSessions.length > 0) {
        prompt += '\n\n--- Recent Session Summaries ---\n';
        prompt += recentSessions.join('\n\n');
        prompt += '\n--- End Summaries ---';
    }

    return prompt;
}

// ─── Streaming Chat ─────────────────────────────────
type Message = { role: string; content: string; tool_calls?: any[]; tool_call_id?: string; name?: string };

async function chat(messages: Message[]): Promise<string> {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
            model: MODEL,
            messages,
            tools,
            stream: true,
        }),
    });

    if (!res.ok) {
        const err = await res.text();
        throw new Error(`OpenAI error ${res.status}: ${err}`);
    }

    // Parse SSE stream
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let fullContent = '';
    let toolCalls: any[] = [];
    let buffer = '';

    process.stdout.write(`${c.green}`);

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
            if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;

            try {
                const data = JSON.parse(line.slice(6));
                const delta = data.choices?.[0]?.delta;
                if (!delta) continue;

                // Content streaming
                if (delta.content) {
                    process.stdout.write(delta.content);
                    fullContent += delta.content;
                }

                // Tool call accumulation
                if (delta.tool_calls) {
                    for (const tc of delta.tool_calls) {
                        if (tc.index >= toolCalls.length) {
                            toolCalls.push({ id: tc.id, function: { name: '', arguments: '' } });
                        }
                        if (tc.function?.name) toolCalls[tc.index].function.name += tc.function.name;
                        if (tc.function?.arguments) toolCalls[tc.index].function.arguments += tc.function.arguments;
                    }
                }
            } catch {
                /* skip malformed JSON */
            }
        }
    }

    process.stdout.write(c.reset);

    // Handle tool calls
    if (toolCalls.length > 0) {
        messages.push({ role: 'assistant', content: fullContent || null as any, tool_calls: toolCalls });

        for (const tc of toolCalls) {
            const args = JSON.parse(tc.function.arguments);
            const toolName = tc.function.name;

            process.stdout.write(`\n${c.dim}  🔧 ${toolName}(${JSON.stringify(args)})${c.reset}`);

            const result = await handleToolCall(toolName, args);
            process.stdout.write(`${c.dim} → ${result.slice(0, 80)}${result.length > 80 ? '...' : ''}${c.reset}\n`);

            messages.push({
                role: 'tool',
                tool_call_id: tc.id,
                name: toolName,
                content: result,
            });
        }

        // Let the model respond with the tool results
        return chat(messages);
    }

    if (fullContent) process.stdout.write('\n');
    return fullContent;
}

// ─── Session Load ───────────────────────────────────
const recentSessions = sessions
    .list({ limit: MAX_RECENT_SESSIONS })
    .map(s => s.content);

const factCount = facts.count();
const sessionCount = sessions.count();

// ─── UI ─────────────────────────────────────────────
console.log();
console.log(`${c.bold}${c.cyan}  🧠 BrainBank Chat${c.reset}`);
console.log(`${c.dim}  Model: ${MODEL} · DB: ${DB_PATH}${c.reset}`);

if (sessionCount > 0 || factCount > 0) {
    console.log(`${c.magenta}  💾 ${sessionCount} session(s), ${factCount} fact(s) in memory${c.reset}`);
} else {
    console.log(`${c.yellow}  🆕 First session — no memories yet${c.reset}`);
}

console.log(`${c.dim}  Type "quit" to exit and save session${c.reset}`);
console.log();

// ─── REPL ───────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (p: string): Promise<string> => new Promise(r => rl.question(p, r));

const messages: Message[] = [
    { role: 'system', content: buildSystemPrompt(recentSessions) },
];

while (true) {
    const input = await ask(`${c.cyan}  You → ${c.reset}`);
    if (!input.trim()) continue;
    if (input.toLowerCase() === 'quit') break;

    messages.push({ role: 'user', content: input });

    process.stdout.write(`${c.green}  Bot → ${c.reset}`);
    const reply = await chat(messages);
    messages.push({ role: 'assistant', content: reply });
    console.log();
}

// ─── Save Session Summary ───────────────────────────
console.log(`\n${c.dim}  Summarizing session...${c.reset}`);

const summaryMessages = [
    ...messages,
    {
        role: 'user' as const,
        content:
            'Summarize our conversation in 2-3 concise sentences for future recall. ' +
            'Focus on: topics discussed, decisions made, preferences expressed, and facts learned.',
    },
];

const summaryRes = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
        model: MODEL,
        messages: summaryMessages,
        max_tokens: 200,
    }),
});

const summaryData = (await summaryRes.json()) as any;
const summary = summaryData.choices?.[0]?.message?.content;

if (summary) {
    await sessions.add(summary, {
        tags: ['session'],
        metadata: { date: new Date().toISOString().split('T')[0] },
    });
    console.log(`${c.magenta}  💾 Session saved: "${summary.slice(0, 100)}..."${c.reset}\n`);
} else {
    console.log(`${c.yellow}  ⚠  Could not summarize session${c.reset}\n`);
}

rl.close();
await brain.close();

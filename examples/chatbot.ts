/**
 * BrainBank + OpenAI Chat — Memory That Persists
 *
 * A simple CLI chatbot that remembers conversations across sessions.
 * Run: OPENAI_API_KEY=sk-... npx tsx examples/chatbot.ts
 */
import { BrainBank } from '../src/index.ts';
import * as readline from 'node:readline';

const DB_PATH = '.brainbank/chatbot.db';

const brain = new BrainBank({ dbPath: DB_PATH });
await brain.initialize();

const conversations = brain.collection('conversations');
const facts = brain.collection('facts');

// ── Recall past context ─────────────────────────────
const pastConversations = conversations.list({ limit: 5 });
let systemPrompt = 'You are a helpful assistant with long-term memory.';

if (pastConversations.length > 0) {
    const memories = pastConversations.map(c => c.content).join('\n\n');
    systemPrompt += `\n\nYou remember these past conversations:\n${memories}`;
    console.log(`\n💾 Loaded ${pastConversations.length} past conversation(s)\n`);
} else {
    console.log('\n🆕 First session — no memories yet\n');
}

// ── Chat loop ───────────────────────────────────────
const messages: { role: string; content: string }[] = [
    { role: 'system', content: systemPrompt },
];

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});

function ask(prompt: string): Promise<string> {
    return new Promise(resolve => rl.question(prompt, resolve));
}

console.log('Chat with memory (type "quit" to exit)\n');

while (true) {
    const input = await ask('You: ');
    if (input.toLowerCase() === 'quit') break;

    messages.push({ role: 'user', content: input });

    // Call OpenAI
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
            model: 'gpt-4.1-nano',
            messages,
            max_tokens: 300,
        }),
    });

    const data = (await res.json()) as any;
    const reply = data.choices?.[0]?.message?.content ?? '(no response)';

    console.log(`\nBot: ${reply}\n`);
    messages.push({ role: 'assistant', content: reply });
}

// ── Save session summary ────────────────────────────
// Ask the LLM to summarize this conversation for future recall
const summaryMessages = [
    ...messages,
    {
        role: 'user',
        content:
            'Summarize our conversation in 2-3 sentences for future reference. ' +
            'Focus on decisions made, preferences expressed, and key topics discussed.',
    },
];

const summaryRes = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
        model: 'gpt-4.1-nano',
        messages: summaryMessages,
        max_tokens: 200,
    }),
});

const summaryData = (await summaryRes.json()) as any;
const summary = summaryData.choices?.[0]?.message?.content;

if (summary) {
    await conversations.add(summary, {
        tags: ['session'],
        metadata: { date: new Date().toISOString().split('T')[0] },
    });
    console.log(`\n💾 Session saved: "${summary.slice(0, 80)}..."\n`);
}

rl.close();
await brain.close();

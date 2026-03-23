/**
 * CLI UI helpers — ANSI colors, formatting, readline.
 * Zero dependencies. Keeps the chatbot logic clean.
 */

import * as readline from 'node:readline';

// ─── Colors ─────────────────────────────────────────

export const c = {
    reset: '\x1b[0m',
    dim: '\x1b[2m',
    bold: '\x1b[1m',
    cyan: '\x1b[36m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    magenta: '\x1b[35m',
    red: '\x1b[31m',
} as const;

// ─── Display helpers ────────────────────────────────

export function header(model: string, db: string) {
    console.log();
    console.log(`${c.bold}${c.cyan}  🧠 BrainBank Chat${c.reset}`);
    console.log(`${c.dim}  Model: ${model} · DB: ${db}${c.reset}`);
}

export function showMemories(memories: { content: string }[], total: number) {
    if (total > 0) {
        console.log(`${c.magenta}  💾 ${total} memories loaded${c.reset}`);
        for (const m of memories) console.log(`${c.dim}     • ${m.content}${c.reset}`);
    } else {
        console.log(`${c.yellow}  🆕 First session — no memories yet${c.reset}`);
    }
    console.log(`${c.dim}  Type "quit" to exit · "memories" to list all${c.reset}`);
    console.log();
}

export function listMemories(memories: { content: string }[]) {
    console.log(`\n${c.magenta}  📋 ${memories.length} memories:${c.reset}`);
    for (const m of memories) console.log(`${c.dim}     • ${m.content}${c.reset}`);
    console.log();
}

export function memoryOp(action: string, fact: string, reason?: string) {
    const icon = action === 'ADD' ? '💾' : action === 'UPDATE' ? '🔄' : '⏭ ';
    const label = action === 'ADD' ? '+memory' : action === 'UPDATE' ? 'updated' : 'skip';
    const suffix = action === 'NONE' && reason ? ` (${reason})` : '';
    console.log(`${c.dim}  ${icon} ${label}: ${fact}${suffix}${c.reset}`);
}

export function bye() {
    console.log(`${c.dim}  👋 Bye${c.reset}\n`);
}

// ─── Input ──────────────────────────────────────────

export function createInput() {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = (prompt: string): Promise<string> =>
        new Promise(resolve => rl.question(prompt, resolve));
    const close = () => rl.close();
    return { ask, close, prompt: `${c.cyan}  You → ${c.reset}` };
}

// ─── Streaming ──────────────────────────────────────

export function startResponse() {
    process.stdout.write(`${c.green}  Bot → `);
}

export function writeChunk(text: string) {
    process.stdout.write(text);
}

export function endResponse() {
    process.stdout.write(`${c.reset}\n`);
}

#!/usr/bin/env node

/**
 * BrainBank — CLI
 * 
 * Standalone command-line interface for the semantic knowledge bank.
 * 
 * Commands:
 *   brainbank index [path]           Index a repository (code + git)
 *   brainbank search <query>         Semantic search (vector only)
 *   brainbank hsearch <query>        Hybrid search (vector + BM25, best quality)
 *   brainbank ksearch <query>        Keyword search (BM25 only, instant)
 *   brainbank context <task>         Get formatted context for a task
 *   brainbank stats                  Show index statistics
 *   brainbank learn                  Store a learned pattern
 *   brainbank serve                  Start MCP server (stdio)
 */

import { BrainBank } from '../core/brainbank.ts';

// ── Colors ──────────────────────────────────────────

const c = {
    green: (s: string) => `\x1b[32m${s}\x1b[0m`,
    red: (s: string) => `\x1b[31m${s}\x1b[0m`,
    yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
    cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
    dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
    bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

// ── CLI Parser ──────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0];

function getFlag(name: string): string | undefined {
    const idx = args.indexOf(`--${name}`);
    return idx >= 0 ? args[idx + 1] : undefined;
}

function hasFlag(name: string): boolean {
    return args.includes(`--${name}`);
}

// ── Commands ────────────────────────────────────────

async function cmdIndex() {
    const repoPath = args[1] || '.';
    const force = hasFlag('force');
    const depth = parseInt(getFlag('depth') || '500', 10);

    console.log(c.bold('\n━━━ BrainBank Index ━━━'));
    console.log(c.dim(`  Repo: ${repoPath}`));
    console.log(c.dim(`  Force: ${force}`));
    console.log(c.dim(`  Git depth: ${depth}`));

    const brain = new BrainBank({ repoPath });

    const result = await brain.index({
        forceReindex: force,
        gitDepth: depth,
        onProgress: (stage, msg) => {
            process.stdout.write(`\r  ${c.cyan(stage.toUpperCase())} ${msg}                    `);
        },
    });

    console.log('\n');
    console.log(`  ${c.green('Code')}: ${result.code.indexed} indexed, ${result.code.skipped} skipped, ${result.code.chunks ?? 0} chunks`);
    console.log(`  ${c.green('Git')}:  ${result.git.indexed} indexed, ${result.git.skipped} skipped`);

    const stats = brain.stats();
    console.log(`\n  ${c.bold('Totals')}:`);
    console.log(`    Code chunks:  ${stats.code.chunks}`);
    console.log(`    Git commits:  ${stats.git.commits}`);
    console.log(`    Co-edit pairs: ${stats.git.coEdits}`);
    console.log(`    Patterns:     ${stats.memory.patterns}`);

    brain.close();
}

async function cmdSearch() {
    const query = args.slice(1).join(' ');
    if (!query) {
        console.log(c.red('Usage: brainbank search <query>'));
        process.exit(1);
    }

    const repoPath = getFlag('repo') || '.';
    const brain = new BrainBank({ repoPath });

    console.log(c.bold(`\n━━━ BrainBank Search: "${query}" ━━━\n`));

    const results = await brain.search(query);

    if (results.length === 0) {
        console.log(c.yellow('  No results found.'));
        brain.close();
        return;
    }

    for (const r of results) {
        const score = Math.round(r.score * 100);
        if (r.type === 'code') {
            const m = r.metadata;
            console.log(`${c.green(`[CODE ${score}%]`)} ${c.bold(r.filePath!)} — ${m.name || m.chunkType} ${c.dim(`L${m.startLine}-${m.endLine}`)}`);
            const preview = r.content.split('\n').slice(0, 5).join('\n');
            console.log(c.dim(preview));
            console.log('');
        } else if (r.type === 'commit') {
            const m = r.metadata;
            console.log(`${c.cyan(`[COMMIT ${score}%]`)} ${c.bold(m.shortHash)} ${r.content} ${c.dim(`(${m.author})`)}`);
            if (m.files?.length) console.log(c.dim(`  Files: ${m.files.slice(0, 4).join(', ')}`));
            console.log('');
        } else if (r.type === 'pattern') {
            const m = r.metadata;
            console.log(`${c.yellow(`[PATTERN ${score}%]`)} ${c.bold(m.taskType)} — ${Math.round(m.successRate * 100)}% success`);
            console.log(c.dim(`  ${r.content}`));
            console.log('');
        }
    }

    brain.close();
}

async function cmdHybridSearch() {
    const query = args.slice(1).filter(a => !a.startsWith('--')).join(' ');
    if (!query) {
        console.log(c.red('Usage: brainbank hsearch <query>'));
        process.exit(1);
    }

    const repoPath = getFlag('repo') || '.';
    const brain = new BrainBank({ repoPath });

    console.log(c.bold(`\n━━━ BrainBank Hybrid Search: "${query}" ━━━`));
    console.log(c.dim(`  Mode: vector + BM25 → Reciprocal Rank Fusion\n`));

    const results = await brain.hybridSearch(query);
    printResults(results);
    brain.close();
}

async function cmdKeywordSearch() {
    const query = args.slice(1).filter(a => !a.startsWith('--')).join(' ');
    if (!query) {
        console.log(c.red('Usage: brainbank ksearch <query>'));
        process.exit(1);
    }

    const repoPath = getFlag('repo') || '.';
    const brain = new BrainBank({ repoPath });
    await brain.initialize();

    console.log(c.bold(`\n━━━ BrainBank Keyword Search: "${query}" ━━━`));
    console.log(c.dim(`  Mode: BM25 full-text (instant)\n`));

    const results = brain.searchBM25(query);
    printResults(results);
    brain.close();
}

function printResults(results: any[]) {
    if (results.length === 0) {
        console.log(c.yellow('  No results found.'));
        return;
    }

    for (const r of results) {
        const score = Math.round(r.score * 100);
        if (r.type === 'code') {
            const m = r.metadata;
            console.log(`${c.green(`[CODE ${score}%]`)} ${c.bold(r.filePath!)} — ${m.name || m.chunkType} ${c.dim(`L${m.startLine}-${m.endLine}`)}`);
            const preview = r.content.split('\n').slice(0, 5).join('\n');
            console.log(c.dim(preview));
            console.log('');
        } else if (r.type === 'commit') {
            const m = r.metadata;
            console.log(`${c.cyan(`[COMMIT ${score}%]`)} ${c.bold(m.shortHash)} ${r.content} ${c.dim(`(${m.author})`)}`);
            if (m.files?.length) console.log(c.dim(`  Files: ${m.files.slice(0, 4).join(', ')}`));
            console.log('');
        } else if (r.type === 'pattern') {
            const m = r.metadata;
            console.log(`${c.yellow(`[PATTERN ${score}%]`)} ${c.bold(m.taskType)} — ${Math.round(m.successRate * 100)}% success`);
            console.log(c.dim(`  ${r.content}`));
            console.log('');
        }
    }
}

async function cmdContext() {
    const task = args.slice(1).join(' ');
    if (!task) {
        console.log(c.red('Usage: brainbank context <task description>'));
        process.exit(1);
    }

    const repoPath = getFlag('repo') || '.';
    const brain = new BrainBank({ repoPath });

    const context = await brain.getContext(task);
    console.log(context);

    brain.close();
}

async function cmdStats() {
    const repoPath = getFlag('repo') || '.';
    const brain = new BrainBank({ repoPath });
    await brain.initialize();

    const s = brain.stats();

    console.log(c.bold('\n━━━ BrainBank Stats ━━━\n'));
    console.log(`  ${c.cyan('Code')}`);
    console.log(`    Files indexed:  ${s.code.files}`);
    console.log(`    Code chunks:    ${s.code.chunks}`);
    console.log(`    HNSW vectors:   ${s.code.hnswSize}`);
    console.log('');
    console.log(`  ${c.cyan('Git History')}`);
    console.log(`    Commits:        ${s.git.commits}`);
    console.log(`    Files tracked:  ${s.git.filesTracked}`);
    console.log(`    Co-edit pairs:  ${s.git.coEdits}`);
    console.log(`    HNSW vectors:   ${s.git.hnswSize}`);
    console.log('');
    console.log(`  ${c.cyan('Agent Memory')}`);
    console.log(`    Patterns:       ${s.memory.patterns}`);
    console.log(`    Avg success:    ${Math.round(s.memory.avgSuccess * 100)}%`);
    console.log(`    HNSW vectors:   ${s.memory.hnswSize}`);
    console.log('');
    console.log(`  ${c.cyan('Conversations')}`);
    console.log(`    Total memories: ${s.conversations.total}`);
    console.log(`    Short-term:     ${s.conversations.short}`);
    console.log(`    Long-term:      ${s.conversations.long}`);

    brain.close();
}

async function cmdLearn() {
    const taskType = getFlag('type') || 'general';
    const task = getFlag('task');
    const approach = getFlag('approach');
    const rate = parseFloat(getFlag('rate') || '0.8');

    if (!task || !approach) {
        console.log(c.red('Usage: brainbank learn --type <type> --task <task> --approach <approach> --rate <0-1>'));
        process.exit(1);
    }

    const repoPath = getFlag('repo') || '.';
    const brain = new BrainBank({ repoPath });

    const id = await brain.learn({
        taskType,
        task,
        approach,
        successRate: rate,
        outcome: getFlag('outcome'),
        critique: getFlag('critique'),
    });

    console.log(c.green(`✓ Pattern #${id} stored (${taskType}, ${Math.round(rate * 100)}% success)`));
    brain.close();
}

async function cmdServe() {
    await import('./mcp-server.ts');
}

async function cmdRemember() {
    const title = getFlag('title');
    const summary = getFlag('summary');

    if (!title || !summary) {
        console.log(c.red('Usage: brainbank remember --title <title> --summary <summary> [--decisions "a,b"] [--files "a.ts,b.ts"] [--patterns "a,b"] [--tags "a,b"]'));
        process.exit(1);
    }

    const repoPath = getFlag('repo') || '.';
    const brain = new BrainBank({ repoPath });

    const id = await brain.remember({
        title,
        summary,
        decisions: (getFlag('decisions') || '').split(',').filter(Boolean),
        filesChanged: (getFlag('files') || '').split(',').filter(Boolean),
        patterns: (getFlag('patterns') || '').split(',').filter(Boolean),
        tags: (getFlag('tags') || '').split(',').filter(Boolean),
    });

    console.log(c.green(`\u2713 Memory #${id} stored: "${title}"`));
    brain.close();
}

async function cmdRecall() {
    const query = args.slice(1).filter(a => !a.startsWith('--')).join(' ');
    if (!query) {
        console.log(c.red('Usage: brainbank recall <query>'));
        process.exit(1);
    }

    const repoPath = getFlag('repo') || '.';
    const brain = new BrainBank({ repoPath });

    console.log(c.bold(`\n\u2501\u2501\u2501 BrainBank Recall: "${query}" \u2501\u2501\u2501\n`));

    const memories = await brain.recall(query);

    if (memories.length === 0) {
        console.log(c.yellow('  No relevant memories found.'));
        brain.close();
        return;
    }

    for (const m of memories) {
        const score = Math.round((m.score ?? 0) * 100);
        const age = Math.round((Date.now() / 1000 - m.createdAt) / 86400);
        console.log(`${c.cyan(`[${score}%]`)} ${c.bold(m.title)} ${c.dim(`(${age}d ago, ${m.tier})`)}`);
        console.log(c.dim(`  ${m.summary}`));
        if (m.decisions?.length) console.log(`  ${c.green('Decisions:')} ${m.decisions.join(', ')}`);
        if (m.filesChanged?.length) console.log(`  ${c.yellow('Files:')} ${m.filesChanged.join(', ')}`);
        if (m.patterns?.length) console.log(`  ${c.cyan('Patterns:')} ${m.patterns.join(', ')}`);
        console.log('');
    }

    brain.close();
}

function showHelp() {
    console.log(c.bold('\n━━━ BrainBank — Semantic Knowledge Bank ━━━\n'));
    console.log('Commands:');
    console.log(`  ${c.cyan('index')} [path]            Index repository code + git history`);
    console.log(`  ${c.cyan('search')} <query>          Semantic search (vector only)`);
    console.log(`  ${c.cyan('hsearch')} <query>         Hybrid search (vector + BM25, ${c.bold('best quality')})`);
    console.log(`  ${c.cyan('ksearch')} <query>         Keyword search (BM25 only, instant)`);
    console.log(`  ${c.cyan('context')} <task>           Get formatted context for a task`);
    console.log(`  ${c.cyan('stats')}                   Show index statistics`);
    console.log(`  ${c.cyan('learn')}                   Store a learned pattern`);
    console.log(`  ${c.cyan('remember')}                Store a conversation memory digest`);
    console.log(`  ${c.cyan('recall')} <query>          Recall relevant conversation memories`);
    console.log(`  ${c.cyan('serve')}                   Start MCP server (stdio)`);
    console.log('');
    console.log('Options:');
    console.log(`  ${c.dim('--repo <path>')}           Repository path (default: .)`);
    console.log(`  ${c.dim('--force')}                 Force re-index of all files`);
    console.log(`  ${c.dim('--depth <n>')}             Git history depth (default: 500)`);
    console.log('');
    console.log('Examples:');
    console.log(c.dim('  brainbank index .'));
    console.log(c.dim('  brainbank hsearch "authentication middleware"'));
    console.log(c.dim('  brainbank search "how does auth work"'));
    console.log(c.dim('  brainbank ksearch "express-rate-limit"'));
    console.log(c.dim('  brainbank context "add rate limiting to the API"'));
    console.log(c.dim('  brainbank stats'));
    console.log(c.dim('  brainbank learn --type api --task "add auth" --approach "JWT middleware" --rate 0.9'));
    console.log(c.dim('  brainbank remember --title "Added BM25" --summary "Implemented FTS5 hybrid search" --tags "search,bm25"'));
    console.log(c.dim('  brainbank recall "search improvements"'));
    console.log(c.dim('  brainbank serve'));
    console.log('');
    console.log('Antigravity MCP config:');
    console.log(c.dim('  Add to ~/.gemini/antigravity/mcp_config.json:'));
    console.log(c.dim('  { "mcpServers": { "brainbank": {'));
    console.log(c.dim('    "command": "npx",'));
    console.log(c.dim('    "args": ["tsx", "<path>/mcp-server.ts"],'));
    console.log(c.dim('    "env": { "BRAINBANK_REPO": "/your/repo" }'));
    console.log(c.dim('  }}}'));
}

// ── Main ────────────────────────────────────────────

async function main() {
    switch (command) {
        case 'index':    return cmdIndex();
        case 'search':   return cmdSearch();
        case 'hsearch':  return cmdHybridSearch();
        case 'ksearch':  return cmdKeywordSearch();
        case 'context':  return cmdContext();
        case 'stats':    return cmdStats();
        case 'learn':    return cmdLearn();
        case 'remember': return cmdRemember();
        case 'recall':   return cmdRecall();
        case 'serve':    return cmdServe();
        case 'help':
        case '--help':
        case '-h':
            showHelp();
            break;
        default:
            if (command) console.log(c.red(`Unknown command: ${command}\n`));
            showHelp();
            process.exit(command ? 1 : 0);
    }
}

main().catch(err => {
    console.error(c.red(`Error: ${err.message}`));
    if (process.env.BRAINBANK_DEBUG) console.error(err.stack);
    process.exit(1);
});

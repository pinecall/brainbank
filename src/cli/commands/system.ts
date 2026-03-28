/**
 * brainbank stats    — Show index statistics
 * brainbank reembed  — Re-embed all vectors
 * brainbank watch    — Watch for file changes
 * brainbank serve    — Start MCP server
 */

import { c } from '@/cli/utils.ts';
import { createBrain } from '@/cli/factory.ts';

// ── Stats ───────────────────────────────────────────

export async function cmdStats(): Promise<void> {
    const brain = await createBrain();
    await brain.initialize();

    const s = brain.stats();

    console.log(c.bold('\n━━━ BrainBank Stats ━━━\n'));
    console.log(`  ${c.cyan('Plugins')}: ${brain.plugins.join(', ')}\n`);

    if (s.code) {
        console.log(`  ${c.cyan('Code')}`);
        console.log(`    Files indexed:  ${s.code.files}`);
        console.log(`    Code chunks:    ${s.code.chunks}`);
        console.log(`    HNSW vectors:   ${s.code.hnswSize}`);
        console.log('');
    }

    if (s.git) {
        console.log(`  ${c.cyan('Git History')}`);
        console.log(`    Commits:        ${s.git.commits}`);
        console.log(`    Files tracked:  ${s.git.filesTracked}`);
        console.log(`    Co-edit pairs:  ${s.git.coEdits}`);
        console.log(`    HNSW vectors:   ${s.git.hnswSize}`);
        console.log('');
    }

    if (s.documents) {
        console.log(`  ${c.cyan('Documents')}`);
        console.log(`    Collections:    ${s.documents.collections}`);
        console.log(`    Documents:      ${s.documents.documents}`);
        console.log(`    Chunks:         ${s.documents.chunks}`);
        console.log(`    HNSW vectors:   ${s.documents.hnswSize}`);
        console.log('');
    }

    // KV collections
    const kvNames = brain.listCollectionNames();
    if (kvNames.length > 0) {
        console.log(`  ${c.cyan('KV Collections')}`);
        for (const name of kvNames) {
            const coll = brain.collection(name);
            console.log(`    ${name}: ${coll.count()} items`);
        }
        console.log('');
    }

    brain.close();
}

// ── Re-embed ────────────────────────────────────────

export async function cmdReembed(): Promise<void> {
    const brain = await createBrain();
    await brain.initialize();

    console.log(c.bold('\n━━━ BrainBank Re-embed ━━━\n'));
    console.log(c.dim('  Regenerating vectors with current embedding provider...'));
    console.log(c.dim('  Text, FTS, and metadata remain unchanged.\n'));

    const result = await brain.reembed({
        onProgress: (table, current, total) => {
            process.stdout.write(`\r  ${c.cyan(table.padEnd(8))} ${current}/${total}`);
        },
    });

    console.log('\n');
    if (result.code > 0)   console.log(`  ${c.green('✓')} Code:    ${result.code} vectors`);
    if (result.git > 0)    console.log(`  ${c.green('✓')} Git:     ${result.git} vectors`);
    if (result.docs > 0)   console.log(`  ${c.green('✓')} Docs:    ${result.docs} vectors`);
    if (result.kv > 0)     console.log(`  ${c.green('✓')} KV:      ${result.kv} vectors`);
    if (result.memory > 0) console.log(`  ${c.green('✓')} Memory:  ${result.memory} vectors`);
    console.log(`\n  ${c.bold('Total')}: ${result.total} vectors regenerated\n`);

    brain.close();
}

// ── Watch ───────────────────────────────────────────

export async function cmdWatch(): Promise<void> {
    const brain = await createBrain();
    await brain.initialize();

    console.log(c.bold('\n━━━ BrainBank Watch ━━━\n'));
    console.log(c.dim(`  Watching ${brain.config.repoPath} for changes...`));
    console.log(c.dim('  Press Ctrl+C to stop.\n'));

    const watcher = brain.watch({
        debounceMs: 2000,
        onIndex: (file, indexer) => {
            const ts = new Date().toLocaleTimeString();
            console.log(`  ${c.dim(ts)} ${c.green('✓')} ${c.cyan(indexer)}: ${file}`);
        },
        onError: (err) => {
            console.error(`  ${c.red('✗')} ${err.message}`);
        },
    });

    // Keep process alive, clean up on Ctrl+C
    process.on('SIGINT', () => {
        console.log(c.dim('\n  Stopping watcher...'));
        watcher.close();
        brain.close();
        process.exit(0);
    });

    await new Promise(() => {});
}

// ── Serve ───────────────────────────────────────────

export async function cmdServe(): Promise<void> {
    await import('@brainbank/mcp');
}

// ── Help ────────────────────────────────────────────

export function showHelp(): void {
    console.log(c.bold('\n━━━ BrainBank — Semantic Knowledge Bank ━━━\n'));
    console.log(c.bold('Indexing:'));
    console.log(`  ${c.cyan('index')} [path]                      Index code + git history`);
    console.log(`  ${c.cyan('collection add')} <path> --name      Add a document collection`);
    console.log(`  ${c.cyan('collection list')}                    List collections`);
    console.log(`  ${c.cyan('collection remove')} <name>           Remove a collection`);
    console.log(`  ${c.cyan('docs')} [--collection <name>]         Index document collections`);
    console.log('');
    console.log(c.bold('Search:'));
    console.log(`  ${c.cyan('search')} <query>                     Semantic search (vector)`);
    console.log(`  ${c.cyan('hsearch')} <query>                    Hybrid search (${c.bold('best quality')})`);
    console.log(`  ${c.cyan('ksearch')} <query>                    Keyword search (BM25, instant)`);
    console.log(`  ${c.cyan('dsearch')} <query>                    Document search`);
    console.log('');
    console.log(c.bold('Context:'));
    console.log(`  ${c.cyan('context')} <task>                     Get formatted context for a task`);
    console.log(`  ${c.cyan('context add')} <col> <path> <desc>    Add context metadata`);
    console.log(`  ${c.cyan('context list')}                       List all context metadata`);
    console.log('');
    console.log(c.bold('KV Store:'));
    console.log(`  ${c.cyan('kv add')} <coll> <content>            Add item to a collection`);
    console.log(`  ${c.cyan('kv search')} <coll> <query>           Search a collection`);
    console.log(`  ${c.cyan('kv list')} [coll]                     List collections or items`);
    console.log(`  ${c.cyan('kv trim')} <coll> --keep <n>          Keep only N most recent`);
    console.log(`  ${c.cyan('kv clear')} <coll>                    Clear all items`);
    console.log('');
    console.log(c.bold('Utility:'));
    console.log(`  ${c.cyan('stats')}                              Show index statistics`);
    console.log(`  ${c.cyan('reembed')}                            Re-embed all vectors`);
    console.log(`  ${c.cyan('watch')}                              Watch files, auto-re-index`);
    console.log(`  ${c.cyan('serve')}                              Start MCP server (stdio)`);
    console.log('');
    console.log(c.bold('Options:'));
    console.log(`  ${c.dim('--repo <path>')}           Repository path (default: .)`);
    console.log(`  ${c.dim('--force')}                 Force re-index all files`);
    console.log(`  ${c.dim('--depth <n>')}             Git history depth (default: 500)`);
    console.log(`  ${c.dim('--collection <name>')}     Filter by collection`);
    console.log(`  ${c.dim('--pattern <glob>')}        Collection glob (default: **/*.md)`);
    console.log(`  ${c.dim('--context <desc>')}        Context description`);
    console.log(`  ${c.dim('--reranker <name>')}       Reranker to use (qwen3)`);
    console.log('');
    console.log(c.bold('Examples:'));
    console.log(c.dim('  brainbank index .'));
    console.log(c.dim('  brainbank kv add errors "Fixed null pointer in api.ts"'));
    console.log(c.dim('  brainbank kv search errors "null pointer"'));
    console.log(c.dim('  brainbank kv list'));
    console.log(c.dim('  brainbank hsearch "authentication middleware"'));
    console.log(c.dim('  brainbank context "add rate limiting to the API"'));
    console.log(c.dim('  brainbank serve'));
}

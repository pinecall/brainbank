#!/usr/bin/env node

/**
 * BrainBank — CLI
 * 
 * Standalone command-line interface for the semantic knowledge bank.
 * 
 * Commands:
 * 
 *   INDEXING
 *   brainbank index [path]                    Index code + git history
 *   brainbank collection add <path> --name    Add a document collection
 *   brainbank collection list                 List collections
 *   brainbank collection remove <name>        Remove a collection
 *   brainbank docs [--collection <name>]      Index document collections
 * 
 *   SEARCH
 *   brainbank search <query>                  Semantic search (vector)
 *   brainbank hsearch <query>                 Hybrid search (vector + BM25)
 *   brainbank ksearch <query>                 Keyword search (BM25)
 *   brainbank dsearch <query>                 Document search
 * 
 *   CONTEXT
 *   brainbank context <task>                  Get formatted context for a task
 *   brainbank context add <col> <path> <desc> Add context metadata
 *   brainbank context list                    List all context metadata
 * 
 *   KV STORE
 *   brainbank kv add <coll> <content>         Add item to a collection
 *   brainbank kv search <coll> <query>        Search a collection
 *   brainbank kv list <coll>                  List items in a collection
 *   brainbank kv trim <coll> --keep <n>       Keep only N most recent items
 *   brainbank kv clear <coll>                 Clear all items
 * 
 *   UTILITY
 *   brainbank stats                           Show index statistics
 *   brainbank reembed                         Re-embed all vectors (provider switch)
 *   brainbank watch                           Watch for file changes, auto-re-index
 *   brainbank serve                           Start MCP server (stdio)
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { BrainBank } from '../core/brainbank.ts';
import { code } from '../plugins/code.ts';
import { git } from '../plugins/git.ts';
import { docs } from '../plugins/docs.ts';
import type { Indexer } from '../plugins/types.ts';

// ── Colors ──────────────────────────────────────────

const c = {
    green: (s: string) => `\x1b[32m${s}\x1b[0m`,
    red: (s: string) => `\x1b[31m${s}\x1b[0m`,
    yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
    cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
    dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
    bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
    magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
};

// ── CLI Parser ──────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0];
const subcommand = args[1];

function getFlag(name: string): string | undefined {
    const idx = args.indexOf(`--${name}`);
    return idx >= 0 ? args[idx + 1] : undefined;
}

function hasFlag(name: string): boolean {
    return args.includes(`--${name}`);
}

// ── Indexer Discovery ───────────────────────────────

interface BrainBankCliConfig {
    /** Custom indexers to register alongside built-in ones. */
    indexers?: Indexer[];
    /** Override which built-in indexers to load. Default: ['code', 'git', 'docs'] */
    builtins?: ('code' | 'git' | 'docs')[];
    /** BrainBank constructor options. */
    brainbank?: Record<string, any>;
}

const CONFIG_NAMES = [
    'config.ts',
    'config.js',
    'config.mjs',
];

const INDEXER_EXTENSIONS = ['.ts', '.js', '.mjs'];

let _configCache: BrainBankCliConfig | null | undefined = undefined;
let _folderIndexersCache: Indexer[] | undefined = undefined;

/** Load .brainbank/config.ts if present. */
async function loadConfig(): Promise<BrainBankCliConfig | null> {
    if (_configCache !== undefined) return _configCache;

    const repoPath = getFlag('repo') ?? '.';
    const brainbankDir = path.resolve(repoPath, '.brainbank');

    for (const name of CONFIG_NAMES) {
        const configPath = path.join(brainbankDir, name);
        if (fs.existsSync(configPath)) {
            try {
                const mod = await import(configPath);
                _configCache = (mod.default ?? mod) as BrainBankCliConfig;
                return _configCache;
            } catch (err: any) {
                console.error(c.red(`Error loading .brainbank/${name}: ${err.message}`));
                process.exit(1);
            }
        }
    }

    _configCache = null;
    return null;
}

/** Auto-discover indexers from .brainbank/indexers/ folder. */
async function discoverFolderIndexers(): Promise<Indexer[]> {
    if (_folderIndexersCache !== undefined) return _folderIndexersCache;

    const repoPath = getFlag('repo') ?? '.';
    const indexersDir = path.resolve(repoPath, '.brainbank', 'indexers');

    if (!fs.existsSync(indexersDir)) {
        _folderIndexersCache = [];
        return [];
    }

    const files = fs.readdirSync(indexersDir)
        .filter(f => INDEXER_EXTENSIONS.some(ext => f.endsWith(ext)))
        .sort();

    const indexers: Indexer[] = [];

    for (const file of files) {
        const filePath = path.join(indexersDir, file);
        try {
            const mod = await import(filePath);
            const indexer = mod.default ?? mod;

            if (indexer && typeof indexer === 'object' && indexer.name) {
                indexers.push(indexer as Indexer);
            } else {
                console.error(c.yellow(`⚠ ${file}: must export a default Indexer with a 'name' property, skipping`));
            }
        } catch (err: any) {
            console.error(c.red(`Error loading indexer ${file}: ${err.message}`));
        }
    }

    _folderIndexersCache = indexers;
    return indexers;
}

/** Create a BrainBank with built-in + discovered + config indexers. */
async function createBrain(repoPath?: string): Promise<BrainBank> {
    const rp = repoPath ?? getFlag('repo') ?? '.';
    const config = await loadConfig();
    const folderIndexers = await discoverFolderIndexers();

    const brainOpts: Record<string, any> = { repoPath: rp, ...(config?.brainbank ?? {}) };

    // Optional Qwen3 reranker via --reranker qwen3
    const rerankerFlag = getFlag('reranker');
    if (rerankerFlag === 'qwen3') {
        const { Qwen3Reranker } = await import('../rerankers/qwen3-reranker.ts');
        brainOpts.reranker = new Qwen3Reranker();
    }

    const brain = new BrainBank(brainOpts);

    // 1. Built-in indexers (default: all three)
    const builtins = config?.builtins ?? ['code', 'git', 'docs'];
    if (builtins.includes('code')) brain.use(code({ repoPath: rp }));
    if (builtins.includes('git')) brain.use(git());
    if (builtins.includes('docs')) brain.use(docs());

    // 2. Auto-discovered from .brainbank/indexers/
    for (const indexer of folderIndexers) {
        brain.use(indexer);
    }

    // 3. Indexers from config file
    if (config?.indexers) {
        for (const indexer of config.indexers) {
            brain.use(indexer);
        }
    }

    return brain;
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

    const brain = await createBrain(repoPath);

    const result = await brain.index({
        forceReindex: force,
        gitDepth: depth,
        onProgress: (stage, msg) => {
            process.stdout.write(`\r  ${c.cyan(stage.toUpperCase())} ${msg}                    `);
        },
    });

    console.log('\n');
    if (result.code) {
        console.log(`  ${c.green('Code')}: ${result.code.indexed} indexed, ${result.code.skipped} skipped, ${result.code.chunks ?? 0} chunks`);
    }
    if (result.git) {
        console.log(`  ${c.green('Git')}:  ${result.git.indexed} indexed, ${result.git.skipped} skipped`);
    }

    const stats = brain.stats();
    console.log(`\n  ${c.bold('Totals')}:`);
    if (stats.code) console.log(`    Code chunks:  ${stats.code.chunks}`);
    if (stats.git) console.log(`    Git commits:  ${stats.git.commits}`);
    if (stats.git) console.log(`    Co-edit pairs: ${stats.git.coEdits}`);

    brain.close();
}

// ── Collection Commands (doc-level) ─────────────────

async function cmdCollection() {
    const sub = args[1];

    if (sub === 'add') {
        const path = args[2];
        const name = getFlag('name');
        const pattern = getFlag('pattern') ?? '**/*.md';
        const context = getFlag('context');
        const ignoreRaw = getFlag('ignore');

        if (!path || !name) {
            console.log(c.red('Usage: brainbank collection add <path> --name <name> [--pattern "**/*.md"] [--ignore "glob"] [--context "description"]'));
            process.exit(1);
        }

        const brain = await createBrain();
        await brain.addCollection({
            name,
            path,
            pattern,
            ignore: ignoreRaw ? ignoreRaw.split(',') : [],
            context: context ?? undefined,
        });
        console.log(c.green(`✓ Collection '${name}' added: ${path} (${pattern})`));
        if (context) console.log(c.dim(`  Context: ${context}`));
        brain.close();
        return;
    }

    if (sub === 'list') {
        const brain = await createBrain();
        await brain.initialize();
        const collections = brain.listCollections();
        if (collections.length === 0) {
            console.log(c.yellow('  No collections registered.'));
        } else {
            console.log(c.bold('\n━━━ Collections ━━━\n'));
            for (const col of collections) {
                console.log(`  ${c.cyan(col.name)} ${c.dim('→')} ${col.path}`);
                console.log(`    Pattern: ${col.pattern ?? '**/*.md'}`);
                if (col.context) console.log(`    Context: ${c.dim(col.context)}`);
            }
        }
        brain.close();
        return;
    }

    if (sub === 'remove') {
        const name = args[2];
        if (!name) {
            console.log(c.red('Usage: brainbank collection remove <name>'));
            process.exit(1);
        }
        const brain = await createBrain();
        await brain.removeCollection(name);
        console.log(c.green(`✓ Collection '${name}' removed.`));
        brain.close();
        return;
    }

    console.log(c.red('Usage: brainbank collection <add|list|remove>'));
    process.exit(1);
}

// ── KV (Dynamic Collection) Commands ────────────────

async function cmdKv() {
    const sub = args[1];

    if (sub === 'add') {
        const collName = args[2];
        const content = args.slice(3).filter(a => !a.startsWith('--')).join(' ');
        const metaRaw = getFlag('meta');

        if (!collName || !content) {
            console.log(c.red('Usage: brainbank kv add <collection> <content> [--meta \'{"key":"val"}\']'));
            process.exit(1);
        }

        const brain = await createBrain();
        await brain.initialize();
        const coll = brain.collection(collName);
        const meta = metaRaw ? JSON.parse(metaRaw) : {};
        const id = await coll.add(content, meta);
        console.log(c.green(`✓ Added item #${id} to '${collName}'`));
        brain.close();
        return;
    }

    if (sub === 'search') {
        const collName = args[2];
        const query = args.slice(3).filter(a => !a.startsWith('--')).join(' ');
        const k = parseInt(getFlag('k') || '5', 10);
        const mode = (getFlag('mode') as any) || 'hybrid';

        if (!collName || !query) {
            console.log(c.red('Usage: brainbank kv search <collection> <query> [--k 5] [--mode hybrid|keyword|vector]'));
            process.exit(1);
        }

        const brain = await createBrain();
        await brain.initialize();
        const coll = brain.collection(collName);
        const results = await coll.search(query, { k, mode });

        if (results.length === 0) {
            console.log(c.yellow('  No results found.'));
        } else {
            console.log(c.bold(`\n━━━ ${collName}: "${query}" ━━━\n`));
            for (const r of results) {
                const score = Math.round((r.score ?? 0) * 100);
                console.log(`  ${c.cyan(`[${score}%]`)} ${r.content}`);
                if (Object.keys(r.metadata).length > 0) {
                    console.log(`    ${c.dim(JSON.stringify(r.metadata))}`);
                }
            }
        }
        brain.close();
        return;
    }

    if (sub === 'list') {
        const collName = args[2];
        const limit = parseInt(getFlag('limit') || '20', 10);

        if (!collName) {
            // List all collection names
            const brain = await createBrain();
            await brain.initialize();
            const names = brain.listCollectionNames();
            if (names.length === 0) {
                console.log(c.yellow('  No KV collections found.'));
            } else {
                console.log(c.bold('\n━━━ KV Collections ━━━\n'));
                for (const n of names) {
                    const coll = brain.collection(n);
                    console.log(`  ${c.cyan(n)} — ${coll.count()} items`);
                }
            }
            brain.close();
            return;
        }

        const brain = await createBrain();
        await brain.initialize();
        const coll = brain.collection(collName);
        const items = coll.list({ limit });
        if (items.length === 0) {
            console.log(c.yellow(`  Collection '${collName}' is empty.`));
        } else {
            console.log(c.bold(`\n━━━ ${collName} (${coll.count()} items) ━━━\n`));
            for (const item of items) {
                const age = Math.round((Date.now() / 1000 - item.createdAt) / 60);
                console.log(`  #${item.id} ${c.dim(`(${age}m ago)`)} ${item.content.slice(0, 80)}`);
            }
        }
        brain.close();
        return;
    }

    if (sub === 'trim') {
        const collName = args[2];
        const keep = parseInt(getFlag('keep') || '0', 10);

        if (!collName || keep <= 0) {
            console.log(c.red('Usage: brainbank kv trim <collection> --keep <n>'));
            process.exit(1);
        }

        const brain = await createBrain();
        await brain.initialize();
        const coll = brain.collection(collName);
        const result = await coll.trim({ keep });
        console.log(c.green(`✓ Trimmed ${result.removed} items from '${collName}' (kept ${keep})`));
        brain.close();
        return;
    }

    if (sub === 'clear') {
        const collName = args[2];
        if (!collName) {
            console.log(c.red('Usage: brainbank kv clear <collection>'));
            process.exit(1);
        }

        const brain = await createBrain();
        await brain.initialize();
        const coll = brain.collection(collName);
        const before = coll.count();
        coll.clear();
        console.log(c.green(`✓ Cleared ${before} items from '${collName}'`));
        brain.close();
        return;
    }

    console.log(c.red('Usage: brainbank kv <add|search|list|trim|clear>'));
    process.exit(1);
}

// ── Document Indexing ───────────────────────────────

async function cmdDocs() {
    const collection = getFlag('collection');
    const brain = await createBrain();

    console.log(c.bold('\n━━━ BrainBank Docs Index ━━━\n'));

    const opts: { collections?: string[]; onProgress?: any } = {};
    if (collection) opts.collections = [collection];
    opts.onProgress = (col: string, file: string, cur: number, total: number) => {
        process.stdout.write(`\r  ${c.cyan(col)} [${cur}/${total}] ${file}                    `);
    };

    const results = await brain.indexDocs(opts);

    console.log('\n');
    for (const [name, stat] of Object.entries(results)) {
        console.log(`  ${c.green(name)}: ${stat.indexed} indexed, ${stat.skipped} skipped, ${stat.chunks} chunks`);
    }

    brain.close();
}

// ── Document Search ─────────────────────────────────

async function cmdDocSearch() {
    const query = args.slice(1).filter(a => !a.startsWith('--')).join(' ');
    if (!query) {
        console.log(c.red('Usage: brainbank dsearch <query>'));
        process.exit(1);
    }

    const brain = await createBrain();
    const collection = getFlag('collection');
    const k = parseInt(getFlag('k') || '8', 10);

    console.log(c.bold(`\n━━━ BrainBank Doc Search: "${query}" ━━━\n`));

    const results = await brain.searchDocs(query, { collection: collection ?? undefined, k });

    if (results.length === 0) {
        console.log(c.yellow('  No results found.'));
        brain.close();
        return;
    }

    for (const r of results) {
        const score = Math.round(r.score * 100);
        const ctx = r.context ? ` — ${c.dim(r.context)}` : '';
        console.log(`${c.magenta(`[DOC ${score}%]`)} ${c.bold(r.filePath!)} [${r.metadata.collection}]${ctx}`);
        const preview = r.content.split('\n').slice(0, 4).join('\n');
        console.log(c.dim(preview));
        console.log('');
    }

    brain.close();
}

// ── Context Commands ────────────────────────────────

async function cmdContext() {
    const sub = args[1];

    // brainbank context add <collection> <path> <description>
    if (sub === 'add') {
        const collection = args[2];
        const path = args[3];
        const desc = args.slice(4).join(' ');

        if (!collection || !path || !desc) {
            console.log(c.red('Usage: brainbank context add <collection> <path> <description>'));
            process.exit(1);
        }

        const brain = await createBrain();
        await brain.initialize();
        brain.addContext(collection, path, desc);
        console.log(c.green(`✓ Context added: ${collection}:${path} → "${desc}"`));
        brain.close();
        return;
    }

    // brainbank context list
    if (sub === 'list') {
        const brain = await createBrain();
        await brain.initialize();
        const contexts = brain.listContexts();
        if (contexts.length === 0) {
            console.log(c.yellow('  No contexts configured.'));
        } else {
            console.log(c.bold('\n━━━ Contexts ━━━\n'));
            for (const ctx of contexts) {
                console.log(`  ${c.cyan(ctx.collection)}:${ctx.path} → ${c.dim(ctx.context)}`);
            }
        }
        brain.close();
        return;
    }

    // brainbank context <task> — get formatted context
    const task = args.slice(1).join(' ');
    if (!task) {
        console.log(c.red('Usage: brainbank context <task description>'));
        console.log(c.dim('       brainbank context add <collection> <path> <description>'));
        console.log(c.dim('       brainbank context list'));
        process.exit(1);
    }

    const brain = await createBrain();
    const context = await brain.getContext(task);
    console.log(context);
    brain.close();
}

// ── Search Commands ─────────────────────────────────

async function cmdSearch() {
    const query = args.slice(1).join(' ');
    if (!query) {
        console.log(c.red('Usage: brainbank search <query>'));
        process.exit(1);
    }

    const brain = await createBrain();

    console.log(c.bold(`\n━━━ BrainBank Search: "${query}" ━━━\n`));

    const results = await brain.search(query);
    printResults(results);
    brain.close();
}

async function cmdHybridSearch() {
    const query = args.slice(1).filter(a => !a.startsWith('--')).join(' ');
    if (!query) {
        console.log(c.red('Usage: brainbank hsearch <query>'));
        process.exit(1);
    }

    const brain = await createBrain();

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

    const brain = await createBrain();
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
        } else if (r.type === 'document') {
            const ctx = r.context ? ` — ${c.dim(r.context)}` : '';
            console.log(`${c.magenta(`[DOC ${score}%]`)} ${c.bold(r.filePath!)} [${r.metadata.collection}]${ctx}`);
            const preview = r.content.split('\n').slice(0, 4).join('\n');
            console.log(c.dim(preview));
            console.log('');
        }
    }
}

// ── Stats ───────────────────────────────────────────

async function cmdStats() {
    const brain = await createBrain();
    await brain.initialize();

    const s = brain.stats();

    console.log(c.bold('\n━━━ BrainBank Stats ━━━\n'));
    console.log(`  ${c.cyan('Indexers')}: ${brain.indexers.join(', ')}\n`);

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

async function cmdReembed() {
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
    if (result.notes > 0)  console.log(`  ${c.green('✓')} Notes:   ${result.notes} vectors`);
    if (result.memory > 0) console.log(`  ${c.green('✓')} Memory:  ${result.memory} vectors`);
    console.log(`\n  ${c.bold('Total')}: ${result.total} vectors regenerated\n`);

    brain.close();
}

async function cmdWatch() {
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

    // Keep process running
    await new Promise(() => {});
}

async function cmdServe() {
    await import('./mcp-server.ts');
}

// ── Help ────────────────────────────────────────────

function showHelp() {
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

// ── Main ────────────────────────────────────────────

async function main() {
    switch (command) {
        case 'index':       return cmdIndex();
        case 'collection':  return cmdCollection();
        case 'kv':          return cmdKv();
        case 'docs':        return cmdDocs();
        case 'dsearch':     return cmdDocSearch();
        case 'search':      return cmdSearch();
        case 'hsearch':     return cmdHybridSearch();
        case 'ksearch':     return cmdKeywordSearch();
        case 'context':     return cmdContext();
        case 'stats':       return cmdStats();
        case 'reembed':     return cmdReembed();
        case 'watch':       return cmdWatch();
        case 'serve':       return cmdServe();
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

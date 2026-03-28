/**
 * brainbank search — Semantic search (vector)
 * brainbank hsearch — Hybrid search (vector + BM25)
 * brainbank ksearch — Keyword search (BM25)
 *
 * Flags:
 *   --codeK <n>          Max code results (0 = skip code)
 *   --gitK <n>           Max git results (0 = skip git)
 *   --docsK <n>          Max document results (0 = skip docs, hsearch only)
 *   --collections k:v    Per-source limits (hsearch only), e.g. "code:5,git:0,docs:10,errors:3"
 */

import { c, args, stripFlags, getFlag, printResults } from '@/cli/utils.ts';
import { createBrain } from '@/cli/factory.ts';

/** Parse --codeK / --gitK flags into search options. */
function parseSearchFlags(): { codeK?: number; gitK?: number } {
    const opts: { codeK?: number; gitK?: number } = {};
    const codeK = getFlag('codeK');
    const gitK = getFlag('gitK');
    if (codeK !== undefined) opts.codeK = parseInt(codeK, 10);
    if (gitK !== undefined) opts.gitK = parseInt(gitK, 10);
    return opts;
}

/**
 * Parse --docsK and --collections into a collections map for hybridSearch.
 *
 * --docsK 10                          → { docs: 10 }
 * --collections code:5,git:0,docs:10  → { code: 5, git: 0, docs: 10 }
 * --collections errors:3,decisions:5  → { errors: 3, decisions: 5 }
 *
 * --docsK is a shorthand; --collections overrides it if both specify "docs".
 */
function parseCollectionsFlag(): Record<string, number> | undefined {
    const docsK = getFlag('docsK');
    const raw = getFlag('collections');

    const map: Record<string, number> = {};
    let hasEntries = false;

    if (docsK !== undefined) {
        map.docs = parseInt(docsK, 10);
        hasEntries = true;
    }

    if (raw) {
        for (const pair of raw.split(',')) {
            const [key, val] = pair.split(':');
            if (key && val !== undefined) {
                map[key.trim()] = parseInt(val.trim(), 10);
                hasEntries = true;
            }
        }
    }

    return hasEntries ? map : undefined;
}

/** Print active filter info when flags are used. */
function printFilterInfo(opts: { codeK?: number; gitK?: number }, collections?: Record<string, number>): void {
    const parts: string[] = [];
    if (opts.codeK !== undefined) parts.push(`codeK=${opts.codeK}`);
    if (opts.gitK !== undefined) parts.push(`gitK=${opts.gitK}`);
    if (collections) {
        for (const [k, v] of Object.entries(collections)) {
            parts.push(`${k}=${v}`);
        }
    }
    if (parts.length > 0) {
        console.log(c.dim(`  Filters: ${parts.join(', ')}`));
    }
}

export async function cmdSearch(): Promise<void> {
    const query = stripFlags(args).slice(1).join(' ');
    if (!query) {
        console.log(c.red('Usage: brainbank search <query> [--codeK <n>] [--gitK <n>]'));
        process.exit(1);
    }

    const opts = parseSearchFlags();
    const brain = await createBrain();
    console.log(c.bold(`\n━━━ BrainBank Search: "${query}" ━━━\n`));
    printFilterInfo(opts);

    const results = await brain.search(query, opts);
    printResults(results);
    brain.close();
}

export async function cmdHybridSearch(): Promise<void> {
    const query = stripFlags(args).slice(1).join(' ');
    if (!query) {
        console.log(c.red('Usage: brainbank hsearch <query> [--codeK <n>] [--gitK <n>] [--docsK <n>] [--collections k:v,...]'));
        process.exit(1);
    }

    const opts = parseSearchFlags();
    const collections = parseCollectionsFlag();
    const brain = await createBrain();
    console.log(c.bold(`\n━━━ BrainBank Hybrid Search: "${query}" ━━━`));
    console.log(c.dim(`  Mode: vector + BM25 → Reciprocal Rank Fusion`));
    printFilterInfo(opts, collections);
    console.log('');

    const results = await brain.hybridSearch(query, { ...opts, collections });
    printResults(results);
    brain.close();
}

export async function cmdKeywordSearch(): Promise<void> {
    const query = stripFlags(args).slice(1).join(' ');
    if (!query) {
        console.log(c.red('Usage: brainbank ksearch <query> [--codeK <n>] [--gitK <n>]'));
        process.exit(1);
    }

    const opts = parseSearchFlags();
    const brain = await createBrain();
    await brain.initialize();
    console.log(c.bold(`\n━━━ BrainBank Keyword Search: "${query}" ━━━`));
    console.log(c.dim(`  Mode: BM25 full-text (instant)`));
    printFilterInfo(opts);
    console.log('');

    const results = await brain.searchBM25(query, opts);
    printResults(results);
    brain.close();
}

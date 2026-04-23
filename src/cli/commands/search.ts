/**
 * brainbank search  — Semantic search (vector)
 * brainbank hsearch — Hybrid search (vector + BM25)
 * brainbank ksearch — Keyword search (BM25)
 *
 * Source filtering:
 *   --code 10             Max code results
 *   --git 0               Skip git results
 *   --docs 5              Max document results
 *   --notes 10            Custom plugin results
 *   --slack_messages 5    Custom collection results
 *
 * Any --<name> <number> flag is treated as a source filter.
 */

import { c, args, stripFlags, printResults } from '@/cli/utils.ts';
import { createBrain } from '@/cli/factory/index.ts';

/**
 * Parse dynamic source flags: each `--<name> <number>` becomes `{ name: number }`.
 *
 * Known non-source flags (--repo, --depth, etc.) are excluded.
 * Returns sources map + the query string (positional args).
 */
function parseSourceFlags(): { sources: Record<string, number>; query: string } {
    const NON_SOURCE_FLAGS = new Set([
        'repo', 'depth', 'collection', 'pattern', 'context', 'name',
        'keep', 'pruner', 'only', 'docs-path', 'mode', 'limit',
        'ignore', 'meta', 'k', 'yes', 'y', 'force', 'verbose',
    ]);

    const sources: Record<string, number> = {};
    const positional: string[] = [];

    for (let i = 0; i < args.length; i++) {
        if (args[i].startsWith('--')) {
            const name = args[i].slice(2);

            // Skip boolean flags
            if (name === 'yes' || name === 'force' || name === 'verbose') continue;

            // If next arg is a number and flag is not a known non-source flag
            const next = args[i + 1];
            if (next !== undefined && /^\d+$/.test(next) && !NON_SOURCE_FLAGS.has(name)) {
                sources[name] = parseInt(next, 10);
                i++; // skip the value
                continue;
            }

            // Known value flag — skip its value
            if (NON_SOURCE_FLAGS.has(name) && next !== undefined && !next.startsWith('--')) {
                i++;
            }
            continue;
        }
        positional.push(args[i]);
    }

    const query = positional.slice(1).join(' '); // skip command name
    return { sources, query };
}

/** Print active source filters. */
function printFilterInfo(sources: Record<string, number>): void {
    const entries = Object.entries(sources);
    if (entries.length === 0) return;
    const parts = entries.map(([k, v]) => `${k}=${v}`);
    console.log(c.dim(`  Sources: ${parts.join(', ')}`));
}

/** Build search options from sources map. */
function buildSearchOptions(sources: Record<string, number>): { sources: Record<string, number>; source: 'cli' } {
    return Object.keys(sources).length > 0 ? { sources, source: 'cli' } : { sources: {}, source: 'cli' };
}

export async function cmdSearch(): Promise<void> {
    const { sources, query } = parseSourceFlags();
    if (!query) {
        console.log(c.red('Usage: brainbank search <query> [--code <n>] [--git <n>] [--<source> <n>]'));
        process.exit(1);
    }

    const brain = await createBrain();
    console.log(c.bold(`\n━━━ BrainBank Search: "${query}" ━━━\n`));
    printFilterInfo(sources);

    const opts = buildSearchOptions(sources);
    const results = await brain.search(query, opts);
    printResults(results);
    brain.close();
}

export async function cmdHybridSearch(): Promise<void> {
    const { sources, query } = parseSourceFlags();
    if (!query) {
        console.log(c.red('Usage: brainbank hsearch <query> [--code <n>] [--git <n>] [--docs <n>] [--<source> <n>]'));
        process.exit(1);
    }

    const brain = await createBrain();
    console.log(c.bold(`\n━━━ BrainBank Hybrid Search: "${query}" ━━━`));
    console.log(c.dim(`  Mode: vector + BM25 → Reciprocal Rank Fusion`));
    printFilterInfo(sources);
    console.log('');

    const opts = buildSearchOptions(sources);
    const results = await brain.hybridSearch(query, opts);
    printResults(results);
    brain.close();
}

export async function cmdKeywordSearch(): Promise<void> {
    const { sources, query } = parseSourceFlags();
    if (!query) {
        console.log(c.red('Usage: brainbank ksearch <query> [--code <n>] [--git <n>] [--<source> <n>]'));
        process.exit(1);
    }

    const brain = await createBrain();
    await brain.initialize();
    console.log(c.bold(`\n━━━ BrainBank Keyword Search: "${query}" ━━━`));
    console.log(c.dim(`  Mode: BM25 full-text (instant)`));
    printFilterInfo(sources);
    console.log('');

    const opts = buildSearchOptions(sources);
    const results = await brain.searchBM25(query, opts);
    printResults(results);
    brain.close();
}

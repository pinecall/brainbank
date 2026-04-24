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

import { c, args, getFlag, stripFlags, printResults } from '@/cli/utils.ts';
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
        'ignore', 'include', 'meta', 'k', 'yes', 'y', 'force', 'verbose', 'path',
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

/** Parse --path as comma-separated list of path prefixes. */
function parsePaths(): string | string[] | undefined {
    const raw = getFlag('path');
    if (!raw) return undefined;
    const paths = raw.split(',').map(p => p.trim()).filter(Boolean);
    return paths.length === 1 ? paths[0] : paths;
}

/** Print active source and path filters. */
function printFilterInfo(sources: Record<string, number>, pathPrefix?: string | string[]): void {
    const parts: string[] = [];
    const entries = Object.entries(sources);
    if (entries.length > 0) parts.push(...entries.map(([k, v]) => `${k}=${v}`));
    if (pathPrefix) {
        const paths = Array.isArray(pathPrefix) ? pathPrefix : [pathPrefix];
        parts.push(`path=${paths.join(',')}`);
    }
    if (parts.length > 0) console.log(c.dim(`  Filters: ${parts.join(', ')}`));
}

/** Build search options from sources map + optional path prefix(es). */
function buildSearchOptions(sources: Record<string, number>, pathPrefix?: string | string[]): { sources: Record<string, number>; source: 'cli'; pathPrefix?: string | string[] } {
    const opts: { sources: Record<string, number>; source: 'cli'; pathPrefix?: string | string[] } = {
        sources: Object.keys(sources).length > 0 ? sources : {},
        source: 'cli',
    };
    if (pathPrefix) opts.pathPrefix = pathPrefix;
    return opts;
}

export async function cmdSearch(): Promise<void> {
    const { sources, query } = parseSourceFlags();
    if (!query) {
        console.log(c.red('Usage: brainbank search <query> [--repo <path>] [--path <dir>] [--code <n>] [--git <n>]'));
        process.exit(1);
    }

    const pathPrefix = parsePaths();
    const brain = await createBrain();
    console.log(c.bold(`\n━━━ BrainBank Search: "${query}" ━━━\n`));
    printFilterInfo(sources, pathPrefix);

    const opts = buildSearchOptions(sources, pathPrefix);
    const results = await brain.search(query, opts);
    printResults(results);
    brain.close();
}

export async function cmdHybridSearch(): Promise<void> {
    const { sources, query } = parseSourceFlags();
    if (!query) {
        console.log(c.red('Usage: brainbank hsearch <query> [--repo <path>] [--path <dir>] [--code <n>] [--git <n>] [--docs <n>]'));
        process.exit(1);
    }

    const pathPrefix = parsePaths();
    const brain = await createBrain();
    console.log(c.bold(`\n━━━ BrainBank Hybrid Search: "${query}" ━━━`));
    console.log(c.dim(`  Mode: vector + BM25 → Reciprocal Rank Fusion`));
    printFilterInfo(sources, pathPrefix);
    console.log('');

    const opts = buildSearchOptions(sources, pathPrefix);
    const results = await brain.hybridSearch(query, opts);
    printResults(results);
    brain.close();
}

export async function cmdKeywordSearch(): Promise<void> {
    const { sources, query } = parseSourceFlags();
    if (!query) {
        console.log(c.red('Usage: brainbank ksearch <query> [--repo <path>] [--path <dir>] [--code <n>] [--git <n>]'));
        process.exit(1);
    }

    const pathPrefix = parsePaths();
    const brain = await createBrain();
    await brain.initialize();
    console.log(c.bold(`\n━━━ BrainBank Keyword Search: "${query}" ━━━`));
    console.log(c.dim(`  Mode: BM25 full-text (instant)`));
    printFilterInfo(sources, pathPrefix);
    console.log('');

    const opts = buildSearchOptions(sources, pathPrefix);
    const results = await brain.searchBM25(query, opts);
    printResults(results, 0.40);
    brain.close();
}

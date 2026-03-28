/**
 * BrainBank CLI — Shared Utilities
 *
 * Colors, argument parsing, and result formatting.
 * No BrainBank imports — pure Node.js / terminal helpers.
 */

// ── Colors ──────────────────────────────────────────

export const c = {
    green:   (s: string) => `\x1b[32m${s}\x1b[0m`,
    red:     (s: string) => `\x1b[31m${s}\x1b[0m`,
    yellow:  (s: string) => `\x1b[33m${s}\x1b[0m`,
    cyan:    (s: string) => `\x1b[36m${s}\x1b[0m`,
    dim:     (s: string) => `\x1b[2m${s}\x1b[0m`,
    bold:    (s: string) => `\x1b[1m${s}\x1b[0m`,
    magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
};

// ── Argument Parsing ────────────────────────────────

/** Raw argv, sliced past the Node binary and script path. */
export const args = process.argv.slice(2);

export function getFlag(name: string): string | undefined {
    const idx = args.indexOf(`--${name}`);
    return idx >= 0 ? args[idx + 1] : undefined;
}

export function hasFlag(name: string): boolean {
    return args.includes(`--${name}`);
}

/** Known flags that take a value (--flag <value>). */
const VALUE_FLAGS = new Set([
    'repo', 'depth', 'collection', 'pattern', 'context', 'name',
    'keep', 'reranker', 'only', 'docs',
    'ignore', 'meta', 'k', 'mode', 'limit',
    'codeK', 'gitK', 'docsK', 'collections',
]);

/**
 * Strip all --flags AND their values from an argv slice.
 * Returns only positional arguments.
 *
 *   stripFlags(['ksearch', 'auth', '--repo', '/path'])
 *   → ['ksearch', 'auth']
 */
export function stripFlags(argv: string[]): string[] {
    const result: string[] = [];
    for (let i = 0; i < argv.length; i++) {
        if (argv[i].startsWith('--')) {
            const name = argv[i].slice(2);
            if (VALUE_FLAGS.has(name)) i++; // skip next (the value)
            continue;
        }
        result.push(argv[i]);
    }
    return result;
}

// ── Result Printer ──────────────────────────────────

export function printResults(results: any[], minScore = 0.70): void {
    const filtered = results.filter(r => r.score >= minScore).slice(0, 20);

    if (filtered.length === 0) {
        console.log(c.yellow(`  No results above ${Math.round(minScore * 100)}% score.`));
        return;
    }

    for (const r of filtered) {
        const score = Math.round(r.score * 100);

        if (r.type === 'code') {
            const m = r.metadata;
            console.log(
                `${c.green(`[CODE ${score}%]`)} ${c.bold(r.filePath!)} — ` +
                `${m.name || m.chunkType} ${c.dim(`L${m.startLine}-${m.endLine}`)}`,
            );
            console.log(c.dim(r.content.split('\n').slice(0, 5).join('\n')));
            console.log('');
        } else if (r.type === 'commit') {
            const m = r.metadata;
            console.log(
                `${c.cyan(`[COMMIT ${score}%]`)} ${c.bold(m.shortHash)} ` +
                `${r.content} ${c.dim(`(${m.author})`)}`,
            );
            if (m.files?.length) console.log(c.dim(`  Files: ${m.files.slice(0, 4).join(', ')}`));
            console.log('');
        } else if (r.type === 'document') {
            const ctx = r.context ? ` — ${c.dim(r.context)}` : '';
            console.log(
                `${c.magenta(`[DOC ${score}%]`)} ${c.bold(r.filePath!)} ` +
                `[${r.metadata.collection}]${ctx}`,
            );
            console.log(c.dim(r.content.split('\n').slice(0, 4).join('\n')));
            console.log('');
        }
    }
}

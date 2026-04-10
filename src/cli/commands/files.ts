/**
 * brainbank files <path|glob> [...paths] [--lines]
 *
 * Fetch full file contents from the index.
 * Use after `brainbank context` to view complete files identified by search.
 */

import { c, args, getFlag } from '@/cli/utils.ts';
import { createBrain } from '@/cli/factory/index.ts';

export async function cmdFiles(): Promise<void> {
    // Collect positional args (file patterns) — skip 'files' command itself
    const patterns: string[] = [];
    const showLines = args.includes('--lines');

    for (let i = 1; i < args.length; i++) {
        if (args[i].startsWith('--')) {
            // Skip --lines and --repo <value>
            if (args[i] === '--repo') {
                i++; // skip value
            }
            continue;
        }
        patterns.push(args[i]);
    }

    if (patterns.length === 0) {
        console.log(c.red('Usage: brainbank files <path|glob> [...paths] [--lines]'));
        console.log(c.dim('  Exact:     brainbank files src/auth/login.ts'));
        console.log(c.dim('  Directory: brainbank files src/graph/'));
        console.log(c.dim('  Glob:      brainbank files "src/**/*.service.ts"'));
        console.log(c.dim('  Fuzzy:     brainbank files plugin.ts'));
        console.log(c.dim('  Lines:     brainbank files src/plugin.ts --lines'));
        process.exit(1);
    }

    const brain = await createBrain();
    await brain.initialize();
    const results = brain.resolveFiles(patterns);

    if (results.length === 0) {
        console.log(c.yellow('No matching files found in the index.'));
        console.log(c.dim('Run `brainbank index` first to index your codebase.'));
        brain.close();
        return;
    }

    // Format output
    for (const r of results) {
        const meta = r.metadata as Record<string, unknown>;
        const startLine = (meta.startLine as number) ?? 1;

        console.log(c.bold(`\n── ${r.filePath} ──\n`));

        if (showLines) {
            const codeLines = r.content.split('\n');
            const pad = String(startLine + codeLines.length - 1).length;
            for (let i = 0; i < codeLines.length; i++) {
                const lineNum = c.dim(`${String(startLine + i).padStart(pad)}|`);
                console.log(`${lineNum} ${codeLines[i]}`);
            }
        } else {
            console.log(r.content);
        }
    }

    console.log(c.dim(`\n${results.length} file(s) resolved.`));
    brain.close();
}

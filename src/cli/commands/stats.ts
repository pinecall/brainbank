/** brainbank stats — Show index statistics (interactive TUI or plain text). */

import * as path from 'node:path';
import { c, args, getFlag } from '@/cli/utils.ts';
import { createBrain } from '@/cli/factory/index.ts';

/** Convert camelCase/snake_case stat keys to human-readable labels. */
function formatStatKey(key: string): string {
    return key
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/_/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase())
        .padEnd(16);
}

export async function cmdStats(): Promise<void> {
    const plain = args.includes('--plain');

    if (!plain) {
        // Interactive TUI mode
        try {
            const repoPath = path.resolve(getFlag('repo') ?? process.cwd());
            const dbPath = path.join(repoPath, '.brainbank', 'data', 'brainbank.db');
            const configPath = path.join(repoPath, '.brainbank', 'config.json');

            const { runStatsTui } = await import('@/cli/tui/stats-tui.tsx');
            await runStatsTui(dbPath, repoPath, configPath);
            return;
        } catch (err: unknown) {
            // Fall back to plain mode if TUI fails (e.g., no DB, piped output)
            if (err instanceof Error && err.message.includes('ENOENT')) {
                console.log(c.yellow('No BrainBank database found. Run `brainbank index` first.\n'));
                return;
            }
            // For other errors, fall through to plain mode
        }
    }

    // Plain text mode (original output)
    const brain = await createBrain();
    await brain.initialize();

    const s = brain.stats();

    console.log(c.bold('\n━━━ BrainBank Stats ━━━\n'));
    console.log(`  ${c.cyan('Plugins')}: ${brain.plugins.join(', ')}\n`);

    for (const [name, pluginStats] of Object.entries(s)) {
        if (!pluginStats) continue;
        console.log(`  ${c.cyan(name)}`);
        for (const [key, value] of Object.entries(pluginStats)) {
            console.log(`    ${formatStatKey(key)}${value}`);
        }
        console.log('');
    }

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

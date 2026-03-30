/** brainbank watch — Watch for file changes. */

import { c } from '@/cli/utils.ts';
import { createBrain } from '@/cli/factory/index.ts';

export async function cmdWatch(): Promise<void> {
    const brain = await createBrain();
    await brain.initialize();

    console.log(c.bold('\n━━━ BrainBank Watch ━━━\n'));
    console.log(c.dim(`  Watching ${brain.config.repoPath} for changes...`));
    console.log(c.dim('  Press Ctrl+C to stop.\n'));

    const watcher = brain.watch({
        debounceMs: 2000,
        onIndex: (file: string, indexer: string) => {
            const ts = new Date().toLocaleTimeString();
            console.log(`  ${c.dim(ts)} ${c.green('✓')} ${c.cyan(indexer)}: ${file}`);
        },
        onError: (err: Error) => {
            console.error(`  ${c.red('✗')} ${err.message}`);
        },
    });

    process.on('SIGINT', () => {
        console.log(c.dim('\n  Stopping watcher...'));
        watcher.close();
        brain.close();
        process.exit(0);
    });

    await new Promise(() => {});
}

/** brainbank watch — Watch for file changes. */

import { c } from '@/cli/utils.ts';
import { createBrain } from '@/cli/factory/index.ts';
import { loadConfig } from '@/cli/factory/config-loader.ts';

export async function cmdWatch(): Promise<void> {
    const brain = await createBrain();
    await brain.initialize();

    // Read ignore patterns from config (code.ignore + top-level ignore)
    const config = await loadConfig(brain.config.repoPath);
    const codeIgnore = (config?.code as Record<string, unknown> | undefined)?.ignore as string[] ?? [];

    console.log(c.bold('\n━━━ BrainBank Watch ━━━\n'));
    console.log(c.dim(`  Watching ${brain.config.repoPath} for changes...`));
    if (codeIgnore.length > 0) {
        console.log(c.dim(`  Ignoring: ${codeIgnore.join(', ')}`));
    }
    console.log(c.dim('  Press Ctrl+C to stop.\n'));

    const watcher = brain.watch({
        debounceMs: 2000,
        ignore: codeIgnore,
        onIndex: (sourceId: string, pluginName: string) => {
            const ts = new Date().toLocaleTimeString();
            console.log(`  ${c.dim(ts)} ${c.green('✓')} ${c.cyan(pluginName)}: ${sourceId}`);
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


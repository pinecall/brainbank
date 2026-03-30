/** brainbank reembed — Re-embed all vectors. */

import { c } from '@/cli/utils.ts';
import { createBrain } from '@/cli/factory/index.ts';

export async function cmdReembed(): Promise<void> {
    const brain = await createBrain();
    await brain.initialize();

    console.log(c.bold('\n━━━ BrainBank Re-embed ━━━\n'));
    console.log(c.dim('  Regenerating vectors with current embedding provider...'));
    console.log(c.dim('  Text, FTS, and metadata remain unchanged.\n'));

    const result = await brain.reembed({
        onProgress: (table: string, current: number, total: number) => {
            process.stdout.write(`\r  ${c.cyan(table.padEnd(8))} ${current}/${total}`);
        },
    });

    console.log('\n');
    for (const [name, count] of Object.entries(result.counts)) {
        if (count > 0) {
            const label = name.charAt(0).toUpperCase() + name.slice(1);
            console.log(`  ${c.green('✓')} ${label.padEnd(8)} ${count} vectors`);
        }
    }
    console.log(`\n  ${c.bold('Total')}: ${result.total} vectors regenerated\n`);

    brain.close();
}

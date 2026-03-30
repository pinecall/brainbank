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
    if (result.code > 0)   console.log(`  ${c.green('✓')} Code:    ${result.code} vectors`);
    if (result.git > 0)    console.log(`  ${c.green('✓')} Git:     ${result.git} vectors`);
    if (result.docs > 0)   console.log(`  ${c.green('✓')} Docs:    ${result.docs} vectors`);
    if (result.kv > 0)     console.log(`  ${c.green('✓')} KV:      ${result.kv} vectors`);
    if (result.memory > 0) console.log(`  ${c.green('✓')} Memory:  ${result.memory} vectors`);
    console.log(`\n  ${c.bold('Total')}: ${result.total} vectors regenerated\n`);

    brain.close();
}

/**
 * brainbank collection add|list|remove — Document collection management
 */

import { c, args, getFlag, stripFlags, findDocsPlugin } from '@/cli/utils.ts';
import { createBrain } from '@/cli/factory/index.ts';

export async function cmdCollection(): Promise<void> {
    const pos = stripFlags(args);
    const sub = pos[1];

    if (sub === 'add') {
        const path = pos[2];
        const name = getFlag('name');
        const pattern = getFlag('pattern') ?? '**/*.md';
        const context = getFlag('context');
        const ignoreRaw = getFlag('ignore');

        if (!path || !name) {
            console.log(c.red('Usage: brainbank collection add <path> --name <name> [--pattern "**/*.md"] [--ignore "glob"] [--context "description"]'));
            process.exit(1);
        }

        const brain = await createBrain();
        const docsPlugin = findDocsPlugin(brain);
        if (!docsPlugin) { console.log(c.red('Docs plugin not loaded. Install @brainbank/docs.')); process.exit(1); }
        await docsPlugin.addCollection({
            name,
            path,
            pattern,
            ignore: ignoreRaw ? ignoreRaw.split(',') : [],
            context: context ?? undefined,
        });
        console.log(c.green(`✓ Collection '${name}' added: ${path} (${pattern})`));
        if (context) console.log(c.dim(`  Context: ${context}`));
        brain.close();
        return;
    }

    if (sub === 'list') {
        const brain = await createBrain();
        await brain.initialize();
        const docsPlugin = findDocsPlugin(brain);
        if (!docsPlugin) { console.log(c.yellow('  Docs plugin not loaded.')); brain.close(); return; }
        const collections = docsPlugin.listCollections();
        if (collections.length === 0) {
            console.log(c.yellow('  No collections registered.'));
        } else {
            console.log(c.bold('\n━━━ Collections ━━━\n'));
            for (const col of collections) {
                console.log(`  ${c.cyan(col.name)} ${c.dim('→')} ${col.path}`);
                console.log(`    Pattern: ${col.pattern ?? '**/*.md'}`);
                if (col.context) console.log(`    Context: ${c.dim(col.context)}`);
            }
        }
        brain.close();
        return;
    }

    if (sub === 'remove') {
        const name = pos[2];
        if (!name) {
            console.log(c.red('Usage: brainbank collection remove <name>'));
            process.exit(1);
        }
        const brain = await createBrain();
        const docsPlugin = findDocsPlugin(brain);
        if (!docsPlugin) { console.log(c.red('Docs plugin not loaded.')); process.exit(1); }
        await docsPlugin.removeCollection(name);
        console.log(c.green(`✓ Collection '${name}' removed.`));
        brain.close();
        return;
    }

    console.log(c.red('Usage: brainbank collection <add|list|remove>'));
    process.exit(1);
}

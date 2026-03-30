/**
 * brainbank context <task> — Get formatted context for a task
 * brainbank context add <collection> <path> <description>
 * brainbank context list
 */

import { c, args, stripFlags } from '@/cli/utils.ts';
import { createBrain } from '@/cli/factory/index.ts';

export async function cmdContext(): Promise<void> {
    const pos = stripFlags(args);
    const sub = pos[1];

    // brainbank context add <collection> <path> <description>
    if (sub === 'add') {
        const collection = pos[2];
        const path = pos[3];
        const desc = pos.slice(4).join(' ');

        if (!collection || !path || !desc) {
            console.log(c.red('Usage: brainbank context add <collection> <path> <description>'));
            process.exit(1);
        }

        const brain = await createBrain();
        await brain.initialize();
        const docsPlugin = brain.docs;
        if (!docsPlugin) { console.log(c.red('Docs plugin not loaded.')); process.exit(1); }
        docsPlugin.addContext(collection, path, desc);
        console.log(c.green(`✓ Context added: ${collection}:${path} → "${desc}"`));
        brain.close();
        return;
    }

    // brainbank context list
    if (sub === 'list') {
        const brain = await createBrain();
        await brain.initialize();
        const docsPlugin = brain.docs;
        if (!docsPlugin) { console.log(c.yellow('  Docs plugin not loaded.')); brain.close(); return; }
        const contexts = docsPlugin.listContexts();
        if (contexts.length === 0) {
            console.log(c.yellow('  No contexts configured.'));
        } else {
            console.log(c.bold('\n━━━ Contexts ━━━\n'));
            for (const ctx of contexts) {
                console.log(`  ${c.cyan(ctx.collection)}:${ctx.path} → ${c.dim(ctx.context)}`);
            }
        }
        brain.close();
        return;
    }

    // brainbank context <task> — get formatted context
    const task = stripFlags(args).slice(1).join(' ');
    if (!task) {
        console.log(c.red('Usage: brainbank context <task description>'));
        console.log(c.dim('       brainbank context add <collection> <path> <description>'));
        console.log(c.dim('       brainbank context list'));
        process.exit(1);
    }

    const brain = await createBrain();
    const context = await brain.getContext(task);
    console.log(context);
    brain.close();
}

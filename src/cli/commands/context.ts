/**
 * brainbank context <task> — Get formatted context for a task
 * brainbank context add <collection> <path> <description>
 * brainbank context list
 *
 * Source filtering (same as search commands):
 *   --code 20    Max code results (default: 20)
 *   --git 5      Max git results
 *   --no-git     Skip git results
 *   --no-code    Skip code results
 *   --path <dir> Filter results to files under this path prefix
 */

import { c, args, stripFlags, getFlag, findDocsPlugin } from '@/cli/utils.ts';
import { createBrain } from '@/cli/factory/index.ts';

/** Parse --code N, --git N, --no-git, --no-code flags into sources map. */
function parseContextFlags(): Record<string, number> {
    const NON_SOURCE = new Set([
        'repo', 'depth', 'collection', 'pattern', 'context', 'name',
        'keep', 'reranker', 'only', 'docs-path', 'mode', 'limit',
        'ignore', 'meta', 'k', 'yes', 'y', 'force', 'verbose', 'path',
    ]);
    const sources: Record<string, number> = {};
    for (let i = 0; i < args.length; i++) {
        if (!args[i].startsWith('--')) continue;
        const name = args[i].slice(2);
        // --no-git, --no-code → set to 0
        if (name.startsWith('no-')) {
            sources[name.slice(3)] = 0;
            continue;
        }
        // --code 20, --git 5
        const next = args[i + 1];
        if (next !== undefined && /^\d+$/.test(next) && !NON_SOURCE.has(name)) {
            sources[name] = parseInt(next, 10);
            i++;
        }
    }
    return sources;
}

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
        const docsPlugin = findDocsPlugin(brain);
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
        const docsPlugin = findDocsPlugin(brain);
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
    const sources = parseContextFlags();
    const pathPrefix = getFlag('path');
    const context = await brain.getContext(task, {
        sources: Object.keys(sources).length > 0 ? sources : undefined,
        pathPrefix,
    });
    console.log(context);
    brain.close();
}

/**
 * brainbank index [path] — Index code + git + docs
 */

import * as path from 'node:path';
import { c, args, getFlag, hasFlag } from '@/cli/utils.ts';
import { createBrain, getConfig, registerConfigCollections } from '@/cli/factory.ts';

export async function cmdIndex(): Promise<void> {
    const repoPath = args[1] || '.';
    const force = hasFlag('force');
    const depth = parseInt(getFlag('depth') || '500', 10);
    const onlyRaw = getFlag('only');
    const docsPath = getFlag('docs');
    const modules = onlyRaw
        ? onlyRaw.split(',').map(s => s.trim()) as ('code' | 'git' | 'docs')[]
        : undefined;

    // If --docs is passed, auto-include 'docs' in modules
    if (docsPath && modules && !modules.includes('docs')) {
        modules.push('docs');
    }

    console.log(c.bold('\n━━━ BrainBank Index ━━━'));
    console.log(c.dim(`  Repo: ${repoPath}`));
    console.log(c.dim(`  Force: ${force}`));
    console.log(c.dim(`  Git depth: ${depth}`));
    if (modules) console.log(c.dim(`  Modules: ${modules.join(', ')}`));
    if (docsPath) console.log(c.dim(`  Docs path: ${docsPath}`));

    const brain = await createBrain(repoPath);

    // Auto-register docs collections from config.json
    const config = await getConfig();
    await registerConfigCollections(brain, config);

    // Auto-register docs collection from --docs CLI flag
    if (docsPath) {
        const absDocsPath = path.resolve(docsPath);
        const collName = path.basename(absDocsPath);
        try {
            await brain.addCollection({
                name: collName,
                path: absDocsPath,
                pattern: '**/*.md',
                ignore: ['deprecated/**', 'node_modules/**'],
            });
            console.log(c.dim(`  Registered docs collection: ${collName}`));
        } catch {
            console.log(c.yellow(`  Warning: docs module not loaded, skipping --docs`));
        }
    }

    const result = await brain.index({
        modules,
        forceReindex: force,
        gitDepth: depth,
        onProgress: (stage, msg) => {
            process.stdout.write(`\r  ${c.cyan(stage.toUpperCase())} ${msg}                    `);
        },
    });

    console.log('\n');
    if (result.code) {
        console.log(`  ${c.green('Code')}: ${result.code.indexed} indexed, ${result.code.skipped} skipped, ${result.code.chunks ?? 0} chunks`);
    }
    if (result.git) {
        console.log(`  ${c.green('Git')}:  ${result.git.indexed} indexed, ${result.git.skipped} skipped`);
    }
    if (result.docs) {
        for (const [name, stat] of Object.entries(result.docs)) {
            console.log(`  ${c.green('Docs')}: [${name}] ${stat.indexed} indexed, ${stat.skipped} skipped, ${stat.chunks} chunks`);
        }
    }

    const stats = brain.stats();
    console.log(`\n  ${c.bold('Totals')}:`);
    if (stats.code) console.log(`    Code chunks:  ${stats.code.chunks}`);
    if (stats.git) console.log(`    Git commits:  ${stats.git.commits}`);
    if (stats.git) console.log(`    Co-edit pairs: ${stats.git.coEdits}`);
    if (stats.documents) console.log(`    Documents:    ${stats.documents.documents}`);

    brain.close();
}

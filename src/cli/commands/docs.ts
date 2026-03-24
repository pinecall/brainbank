/**
 * brainbank docs — Index document collections
 * brainbank dsearch — Search documents only
 */

import { c, args, getFlag } from '../utils.ts';
import { createBrain } from '../factory.ts';

export async function cmdDocs(): Promise<void> {
    const collection = getFlag('collection');
    const brain = await createBrain();

    console.log(c.bold('\n━━━ BrainBank Docs Index ━━━\n'));

    const opts: { collections?: string[]; onProgress?: any } = {};
    if (collection) opts.collections = [collection];
    opts.onProgress = (col: string, file: string, cur: number, total: number) => {
        process.stdout.write(`\r  ${c.cyan(col)} [${cur}/${total}] ${file}                    `);
    };

    const results = await brain.indexDocs(opts);

    console.log('\n');
    for (const [name, stat] of Object.entries(results)) {
        console.log(`  ${c.green(name)}: ${stat.indexed} indexed, ${stat.skipped} skipped, ${stat.chunks} chunks`);
    }

    brain.close();
}

export async function cmdDocSearch(): Promise<void> {
    const query = args.slice(1).filter(a => !a.startsWith('--')).join(' ');
    if (!query) {
        console.log(c.red('Usage: brainbank dsearch <query>'));
        process.exit(1);
    }

    const brain = await createBrain();
    const collection = getFlag('collection');
    const k = parseInt(getFlag('k') || '8', 10);

    console.log(c.bold(`\n━━━ BrainBank Doc Search: "${query}" ━━━\n`));

    const results = await brain.searchDocs(query, { collection: collection ?? undefined, k });

    if (results.length === 0) {
        console.log(c.yellow('  No results found.'));
        brain.close();
        return;
    }

    for (const r of results) {
        const score = Math.round(r.score * 100);
        const ctx = r.context ? ` — ${c.dim(r.context)}` : '';
        console.log(`${c.magenta(`[DOC ${score}%]`)} ${c.bold(r.filePath!)} [${(r.metadata as any).collection}]${ctx}`);
        const preview = r.content.split('\n').slice(0, 4).join('\n');
        console.log(c.dim(preview));
        console.log('');
    }

    brain.close();
}

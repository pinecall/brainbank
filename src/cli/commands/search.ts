/**
 * brainbank search — Semantic search (vector)
 * brainbank hsearch — Hybrid search (vector + BM25)
 * brainbank ksearch — Keyword search (BM25)
 */

import { c, args, printResults } from '../utils.ts';
import { createBrain } from '../factory.ts';

export async function cmdSearch(): Promise<void> {
    const query = args.slice(1).join(' ');
    if (!query) {
        console.log(c.red('Usage: brainbank search <query>'));
        process.exit(1);
    }

    const brain = await createBrain();
    console.log(c.bold(`\n━━━ BrainBank Search: "${query}" ━━━\n`));

    const results = await brain.search(query);
    printResults(results);
    brain.close();
}

export async function cmdHybridSearch(): Promise<void> {
    const query = args.slice(1).filter(a => !a.startsWith('--')).join(' ');
    if (!query) {
        console.log(c.red('Usage: brainbank hsearch <query>'));
        process.exit(1);
    }

    const brain = await createBrain();
    console.log(c.bold(`\n━━━ BrainBank Hybrid Search: "${query}" ━━━`));
    console.log(c.dim(`  Mode: vector + BM25 → Reciprocal Rank Fusion\n`));

    const results = await brain.hybridSearch(query);
    printResults(results);
    brain.close();
}

export async function cmdKeywordSearch(): Promise<void> {
    const query = args.slice(1).filter(a => !a.startsWith('--')).join(' ');
    if (!query) {
        console.log(c.red('Usage: brainbank ksearch <query>'));
        process.exit(1);
    }

    const brain = await createBrain();
    await brain.initialize();
    console.log(c.bold(`\n━━━ BrainBank Keyword Search: "${query}" ━━━`));
    console.log(c.dim(`  Mode: BM25 full-text (instant)\n`));

    const results = brain.searchBM25(query);
    printResults(results);
    brain.close();
}

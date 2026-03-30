/** brainbank stats — Show index statistics. */

import { c } from '@/cli/utils.ts';
import { createBrain } from '@/cli/factory/index.ts';

export async function cmdStats(): Promise<void> {
    const brain = await createBrain();
    await brain.initialize();

    const s = brain.stats();

    console.log(c.bold('\n━━━ BrainBank Stats ━━━\n'));
    console.log(`  ${c.cyan('Plugins')}: ${brain.plugins.join(', ')}\n`);

    if (s.code) {
        console.log(`  ${c.cyan('Code')}`);
        console.log(`    Files indexed:  ${s.code.files}`);
        console.log(`    Code chunks:    ${s.code.chunks}`);
        console.log(`    HNSW vectors:   ${s.code.hnswSize}`);
        console.log('');
    }

    if (s.git) {
        console.log(`  ${c.cyan('Git History')}`);
        console.log(`    Commits:        ${s.git.commits}`);
        console.log(`    Files tracked:  ${s.git.filesTracked}`);
        console.log(`    Co-edit pairs:  ${s.git.coEdits}`);
        console.log(`    HNSW vectors:   ${s.git.hnswSize}`);
        console.log('');
    }

    if (s.documents) {
        console.log(`  ${c.cyan('Documents')}`);
        console.log(`    Collections:    ${s.documents.collections}`);
        console.log(`    Documents:      ${s.documents.documents}`);
        console.log(`    Chunks:         ${s.documents.chunks}`);
        console.log(`    HNSW vectors:   ${s.documents.hnswSize}`);
        console.log('');
    }

    const kvNames = brain.listCollectionNames();
    if (kvNames.length > 0) {
        console.log(`  ${c.cyan('KV Collections')}`);
        for (const name of kvNames) {
            const coll = brain.collection(name);
            console.log(`    ${name}: ${coll.count()} items`);
        }
        console.log('');
    }

    brain.close();
}

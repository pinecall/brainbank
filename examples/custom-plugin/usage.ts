/**
 * Programmatic usage of the Notes plugin.
 *
 * This shows the programmatic API: import the plugin, register with
 * brain.use(), initialize, index, and search.
 *
 * Run:
 *   npx tsx examples/custom-plugin/usage.ts
 */

import * as path from 'node:path';
import * as url from 'node:url';
import { BrainBank } from 'brainbank';
import { notes, NotesPlugin } from './notes-plugin.ts';

// __dirname equivalent in ESM
const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

const brain = new BrainBank({ repoPath: __dirname })
    .use(notes({ dir: './sample-data/notes' }));

await brain.initialize();

// Index — reads all .txt files from sample-data/notes/
const result = await brain.index();
console.log('Index result:', JSON.stringify(result));

// Collection stats
const col = brain.collection('notes');
console.log(`\n📋 Indexed ${col.count()} notes:`);
for (const item of col.list({ limit: 10 })) {
    console.log(`  - [${item.metadata.file}] ${item.content.slice(0, 80)}...`);
}

// Hybrid search
const results = await brain.search('how does search work');
console.log(`\n🔍 Search "how does search work": ${results.length} results`);
for (const r of results.slice(0, 3)) {
    console.log(`  [${r.score.toFixed(3)}] ${r.content.slice(0, 100)}...`);
}

// Typed plugin access — direct notes search
const notesPlugin = brain.plugin<NotesPlugin>('notes')!;
const noteHits = await notesPlugin.searchNotes('plugin system');
console.log(`\n📝 searchNotes "plugin system": ${noteHits.length} results`);
for (const h of noteHits) {
    console.log(`  [${h.score.toFixed(3)}] ${h.content.slice(0, 100)}...`);
}

// List all indexed notes via typed accessor
const allNotes = notesPlugin.listNotes();
console.log(`\n📂 listNotes():`, allNotes);

brain.close();

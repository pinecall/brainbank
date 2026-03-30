/**
 * Programmatic usage of the Notes plugin.
 *
 * This shows the programmatic API: import the plugin, register with
 * brain.use(), initialize, index, and search.
 *
 * Run:
 *   npx tsx examples/notes-plugin/usage.ts
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

// Watch for changes — auto re-indexes .txt files
const watcher = brain.watch({
    onIndex: (file, indexer) => console.log(`\n👁 [${indexer}] re-indexed: ${file}`),
    onError: (err) => console.error('Watch error:', err.message),
});
console.log(`\n👁 Watching for .txt changes... (Ctrl+C to stop)`);

// In a real app you'd keep the process alive.
// For this demo, stop after 10 seconds:
setTimeout(() => {
    watcher.close();
    brain.close();
    console.log('\n✅ Done.');
}, 10_000);

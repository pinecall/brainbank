# Notes Plugin Example

A programmatic BrainBank plugin that reads `.txt` files from a directory and indexes each file as a searchable item. Local-only — no external APIs, testable immediately with included sample data.

## File Structure

```
notes-plugin/
├── notes-plugin.ts              # Plugin class + factory function
├── usage.ts                     # Script to test the plugin
└── sample-data/
    └── notes/
        ├── architecture.txt     # Sample notes about BrainBank internals
        └── plugins.txt          # Sample notes about the plugin system
```

## Try It

```bash
cd examples/notes-plugin
npx tsx usage.ts
```

This runs `usage.ts` which:
1. Creates a `BrainBank` instance with `.use(notes({ dir: './sample-data/notes' }))`
2. Calls `brain.index()` — reads `architecture.txt` and `plugins.txt`
3. Calls `brain.search('how does search work')` — returns relevant note chunks
4. Uses `brain.plugin<NotesPlugin>('notes')!.searchNotes()` for direct notes search
5. Uses `notesPlugin.listNotes()` to show all indexed files

## Code Highlights

```typescript
import { notes, NotesPlugin } from './notes-plugin';

const brain = new BrainBank({ repoPath: '.' })
    .use(notes({ dir: './sample-data/notes' }));

await brain.initialize();
await brain.index();

// Hybrid search — notes results fused via RRF
const results = await brain.search('vector search');

// Typed plugin access
const notesPlugin = brain.plugin<NotesPlugin>('notes')!;
const noteHits = await notesPlugin.searchNotes('plugin system');
const allNotes = notesPlugin.listNotes();
```

## What It Demonstrates

| Feature | How |
|---------|-----|
| Plugin lifecycle | `initialize()` → `index()` → `search()` → `close()` |
| `IndexablePlugin` | Joins `brain.index()` pipeline |
| `SearchablePlugin` | Results merge into `brain.search()` via RRF |
| Typed plugin access | `brain.plugin<NotesPlugin>('notes')` |
| Collection API | `ctx.collection('notes')` for KV store with hybrid search |
| Idempotent indexing | Skip unchanged files, update modified ones |
| `WatchablePlugin` | Plugin-driven watching via `watch(onEvent)` for `.txt` file changes |
| Factory function pattern | `export function notes(opts): Plugin` |

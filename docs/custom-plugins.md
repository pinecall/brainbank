# Custom Plugins

Build plugins to index any data source, participate in hybrid search, and expose convenience methods.

## Minimal Plugin

```typescript
import type { Plugin, PluginContext } from 'brainbank';

const myPlugin: Plugin = {
  name: 'my-plugin',
  async initialize(ctx: PluginContext) {
    const store = ctx.collection('my_data');
    await store.add('some content', { tags: ['example'] });
  },
};

const brain = new BrainBank({ repoPath: '.' }).use(myPlugin);
await brain.initialize();
```

---

## Plugin Lifecycle

```
1. brain.use(myPlugin)        →  Plugin registered (not initialized yet)
2. await brain.initialize()   →  plugin.initialize(ctx) called
3. brain.index()              →  plugin.index() called  (if IndexablePlugin)
4. brain.search()             →  plugin.search() called (if SearchablePlugin)
5. brain.watch()              →  plugin.onFileChange()  (if WatchablePlugin)
6. brain.close()              →  plugin.close()         (cleanup)
```

---

## PluginContext API

Every plugin receives a `PluginContext` during `initialize()`:

| Property | What you use it for |
|----------|---------------------|
| `ctx.collection(name)` | **Start here.** Get/create a KV collection with built-in hybrid search |
| `ctx.db` | Raw SQLite access (for custom tables) |
| `ctx.embedding` | `embed(text)` / `embedBatch(texts)` |
| `ctx.config` | `repoPath`, `dbPath`, etc. |
| `ctx.createHnsw(max?, dims?)` | Standalone HNSW index (advanced) |
| `ctx.getOrCreateSharedHnsw(type)` | Shared HNSW across same-type plugins (multi-repo) |

---

## Capability Interfaces

Implement these to hook into BrainBank's lifecycle:

| Interface | Method to implement | What happens |
|-----------|---------------------|-------------|
| `IndexablePlugin` | `index(options?)` | Runs during `brain.index()` |
| `SearchablePlugin` | `search(query, options?)` | Results merged via RRF in `brain.hybridSearch()` |
| `WatchablePlugin` | `watchPatterns()` + `onFileChange(path, event)` | Auto-re-index on file changes |

---

## Full Example: Notes Plugin

A plugin that reads `.txt` files and makes them searchable:

```typescript
import type { Plugin, PluginContext, IndexablePlugin, SearchablePlugin, SearchResult } from 'brainbank';
import * as fs from 'node:fs';
import * as path from 'node:path';

function notesPlugin(dir: string): Plugin & IndexablePlugin & SearchablePlugin {
  let ctx: PluginContext;

  return {
    name: 'notes',

    async initialize(context) {
      ctx = context;
    },

    async index() {
      const col = ctx.collection('notes');
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.txt'));

      for (const file of files) {
        const content = fs.readFileSync(path.join(dir, file), 'utf-8');
        await col.add(content, { metadata: { file } });
      }

      return { indexed: files.length, skipped: 0 };
    },

    async search(query: string, options?: { k?: number }): Promise<SearchResult[]> {
      const hits = await ctx.collection('notes').search(query, { k: options?.k ?? 5 });
      return hits.map(h => ({
        type: 'collection' as const,
        score: h.score ?? 0,
        content: h.content,
        metadata: h.metadata,
      }));
    },
  };
}

// Usage
const brain = new BrainBank({ repoPath: '.' })
  .use(notesPlugin('./notes'));

await brain.initialize();
await brain.index();
const results = await brain.hybridSearch('meeting notes about auth');
```

---

## Watch Mode Integration

Hook into `brain.watch()` to auto-re-index when files change:

```typescript
import type { Plugin, PluginContext, WatchablePlugin } from 'brainbank';
import * as fs from 'node:fs';

function csvPlugin(): Plugin & WatchablePlugin {
  let ctx: PluginContext;

  return {
    name: 'csv',

    async initialize(context) {
      ctx = context;
    },

    watchPatterns() {
      return ['**/*.csv', '**/*.tsv'];
    },

    async onFileChange(filePath: string, event: 'create' | 'update' | 'delete') {
      const col = ctx.collection('csv_data');

      // Remove old data for this file
      const existing = col.list({ limit: 1000 }).filter(
        i => i.metadata.file === filePath
      );
      for (const item of existing) col.remove(item.id);

      // Re-add if file still exists
      if (event !== 'delete') {
        const data = fs.readFileSync(filePath, 'utf-8');
        await col.add(data, { tags: ['csv'], metadata: { file: filePath } });
      }

      return true;
    },
  };
}
```

---

## CLI Auto-Discovery

Drop `.ts` files into `.brainbank/plugins/` — the CLI auto-discovers them:

```typescript
// .brainbank/plugins/my-plugin.ts
import type { Plugin } from 'brainbank';

export default {
  name: 'my-plugin',
  async initialize(ctx) { /* ... */ },
} satisfies Plugin;
```

```bash
brainbank index    # runs code + git + docs + my-plugin
brainbank stats    # shows all plugins
```

---

## Typed Plugin Access

```typescript
// Built-in plugins — typed getters
brain.docs!.addCollection({ name: 'wiki', path: './docs' });
brain.git!.suggestCoEdits('src/auth.ts');

// Custom plugins — generic access with type parameter
const myPlugin = brain.plugin<MyPlugin>('my-plugin')!;
const results = await myPlugin.searchMyData('query');
```

---

## Developing a Plugin Package

Publish a reusable plugin as a standalone npm package (like `@brainbank/git` or `@brainbank/docs`).

> 📂 **Full scaffold:** [examples/custom-package/](../examples/custom-package/) — a CSV indexer as a publishable npm package.

> ⚠️ The `@brainbank` npm scope is reserved for official plugins. Use your own scope (e.g. `brainbank-csv`, `@myorg/brainbank-csv`).

### Requirements

| Requirement | Value |
|-------------|-------|
| `brainbank` in `package.json` | `peerDependencies` (never `dependencies`) |
| Local imports | `.js` extensions (`'./my-plugin.js'`) |
| Export pattern | Factory function: `csv(opts)` → `Plugin` |
| `tsup` externals | `external: ['brainbank']` |
| `tsconfig` module | `"moduleResolution": "bundler"` |

### Build & Publish

```bash
npm run build       # → dist/index.js + dist/index.d.ts
npm publish --access public
```

### Usage

```typescript
import { BrainBank } from 'brainbank';
import { csv } from 'brainbank-csv';

const brain = new BrainBank({ repoPath: '.' }).use(csv({ dir: './data' }));
await brain.initialize();
await brain.index();
```

---

## Examples

| Example | Description | Run |
|---------|-------------|-----|
| [notes-plugin](../examples/notes-plugin/) | Programmatic plugin (reads `.txt` files) | `npx tsx examples/notes-plugin/usage.ts` |
| [custom-plugin](../examples/custom-plugin/) | CLI auto-discovery plugin (quotes) | `brainbank index` from the directory |
| [custom-package](../examples/custom-package/) | Standalone npm package scaffold (CSV) | See [README](../examples/custom-package/README.md) |

---

## See Also

- [Plugins](plugins.md) — built-in plugins overview
- [Collections](collections.md) — the KV store primitive plugins use internally
- [Configuration](config.md) — per-plugin config in `.brainbank/config.json`

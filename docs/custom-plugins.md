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
| `ctx.db` | Raw SQLite access (for custom tables or direct queries) |
| `ctx.embedding` | `embed(text)` / `embedBatch(texts)` — the global embedding provider |
| `ctx.config` | `repoPath`, `dbPath`, `embeddingDims`, `hnswM`, etc. |
| `ctx.createHnsw(max?, dims?, name?)` | Private HNSW index (persisted to `hnsw-{name}.index` if named) |
| `ctx.loadVectors(table, idCol, hnsw, cache)` | Load existing vectors from a SQLite vectors table into HNSW + cache. Skipped on dimension mismatch force-init. Tries disk file first (fast), falls back to row-by-row from SQLite. |
| `ctx.getOrCreateSharedHnsw(type, max?, dims?)` | Shared HNSW across same-type plugins (e.g. all `code:*` share one). Returns `{ hnsw, vecCache, isNew }`. Only the first caller (isNew=true) should `loadVectors`. |

### HNSW Allocation Strategy

| Use case | Method | Example |
|----------|--------|---------|
| Plugin-local search (not in main pipeline) | `ctx.createHnsw(max, dims, name)` | DocsPlugin, PatternsPlugin |
| Shared across multi-repo plugins | `ctx.getOrCreateSharedHnsw(type)` | CodePlugin (`'code'`), GitPlugin (`'git'`) |
| KV collections | N/A — owned by KVService | All `brain.collection()` calls |

---

## Capability Interfaces

Implement these to hook into BrainBank's lifecycle:

### IndexablePlugin

Participates in `brain.index()`:

```typescript
interface IndexablePlugin extends Plugin {
  index(options?: IndexOptions): Promise<IndexResult>;
}
// IndexOptions: { forceReindex?, depth?, onProgress? }
// IndexResult: { indexed: number, skipped: number, chunks?: number }
```

### SearchablePlugin

Results merged via RRF in `brain.hybridSearch()`:

```typescript
interface SearchablePlugin extends Plugin {
  search(query: string, options?: Record<string, unknown>): Promise<SearchResult[]>;
}
```

### WatchablePlugin

Auto-re-index on file changes:

```typescript
interface WatchablePlugin extends Plugin {
  onFileChange(filePath: string, event: 'create' | 'update' | 'delete'): Promise<boolean>;
  watchPatterns(): string[];  // glob patterns like ['**/*.csv']
}
```

### VectorSearchPlugin

Provides a domain-specific vector search strategy wired into CompositeVectorSearch:

```typescript
interface VectorSearchPlugin extends Plugin {
  createVectorSearch(): DomainVectorSearch | undefined;
}
// DomainVectorSearch: { search(queryVec, k, minScore, useMMR?, mmrLambda?): SearchResult[] }
```

### ContextFormatterPlugin

Contributes markdown sections to `brain.getContext()` output:

```typescript
interface ContextFormatterPlugin extends Plugin {
  formatContext(results: SearchResult[], parts: string[], options?: Record<string, unknown>): void;
}
```

### ReembeddablePlugin

Participates in `brain.reembed()` — maps text rows to vector BLOBs:

```typescript
interface ReembeddablePlugin extends Plugin {
  reembedConfig(): ReembedTable;
}
// ReembedTable: { name, textTable, vectorTable, idColumn, fkColumn, textBuilder }
```

### BM25SearchPlugin

Provides FTS5 keyword search wired into `CompositeBM25Search`:

```typescript
interface BM25SearchPlugin extends Plugin {
  searchBM25(query: string, k: number): SearchResult[];
  rebuildFTS?(): void;
}
```

### MigratablePlugin

Plugin owns its DB schema via versioned migrations. Tables are created on `initialize()` — the core schema stays domain-free:

```typescript
interface MigratablePlugin extends Plugin {
  readonly schemaVersion: number;
  readonly migrations: Record<number, string[]>;
}
// migrations: { 1: ['CREATE TABLE ...', 'CREATE INDEX ...'], 2: ['ALTER TABLE ...'] }
```

> Plugins call `runPluginMigrations(db, pluginName, plugin.schemaVersion, plugin.migrations)` at the top of their `initialize()` method. The migration runner uses the `plugin_versions` table to track which version each plugin has been migrated to.

## Full Example: Notes Plugin

A plugin that reads `.txt` files and makes them searchable:

```typescript
import type { Plugin, PluginContext, IndexablePlugin, SearchablePlugin, SearchResult, IndexResult } from 'brainbank';
import * as fs from 'node:fs';
import * as path from 'node:path';

function notesPlugin(dir: string): Plugin & IndexablePlugin & SearchablePlugin {
  let ctx: PluginContext;

  return {
    name: 'notes',

    async initialize(context) {
      ctx = context;
    },

    async index(): Promise<IndexResult> {
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

## Developing a Plugin Package

Publish a reusable plugin as a standalone npm package (like `@brainbank/git` or `@brainbank/docs`).

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

## See Also

- [Plugins](plugins.md) — built-in plugins overview
- [Collections](collections.md) — the KV store primitive plugins use internally
- [Configuration](config.md) — per-plugin config in `.brainbank/config.json`

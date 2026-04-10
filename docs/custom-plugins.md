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
5. brain.watch()              →  plugin.watch(onEvent)  (if WatchablePlugin)
6. brain.close()              →  plugin.close()         (cleanup)
```

---

## PluginContext API

Every plugin receives a `PluginContext` during `initialize()`:

| Property | What you use it for |
|----------|---------------------|
| `ctx.collection(name)` | **Start here.** Get/create a KV collection with built-in hybrid search |
| `ctx.db` | Database adapter — `DatabaseAdapter` interface (for custom tables or direct queries) |
| `ctx.embedding` | `embed(text)` / `embedBatch(texts)` — the global embedding provider |
| `ctx.config` | `repoPath`, `dbPath`, `embeddingDims`, `hnswM`, etc. |
| `ctx.createHnsw(max?, dims?, name?)` | Private HNSW index (persisted to `hnsw-{name}.index` if named) |
| `ctx.loadVectors(table, idCol, hnsw, cache)` | Load existing vectors from a SQLite vectors table into HNSW + cache. Skipped on dimension mismatch force-init. Tries disk file first (fast), falls back to row-by-row from SQLite. |
| `ctx.getOrCreateSharedHnsw(type, max?, dims?)` | Shared HNSW across same-type plugins (e.g. all `code:*` share one). Returns `{ hnsw, vecCache, isNew }`. Only the first caller (isNew=true) should `loadVectors`. |
| `ctx.createTracker()` | Returns an `IncrementalTracker` scoped to the plugin name. Standardizes add/update/delete detection during indexing. See [Incremental Tracking](#incremental-tracking). |
| `ctx.webhookServer?` | Optional `WebhookServer` for push-based watching. `undefined` if `webhookPort` not configured. |

### Data Storage Strategy

> [!TIP]
> **Start with collections.** Most plugins only need `ctx.collection('name')` — it gives you hybrid search (vector + BM25), metadata, tags, and TTL with zero SQL.

| Approach | SQL? | Best for |
|----------|:---:|---------|
| `ctx.collection(name)` | **No** | Notes, errors, decisions, logs — store + search |
| Custom tables + [migrations](migrations.md) | Yes | Relational schemas, custom FTS5, specialized indices |

Use `ctx.db` and `MigratablePlugin` **only** when you need table relationships, weighted FTS5 columns, CASCADE deletes, or domain-specific query patterns.

### Incremental Tracking

Use `ctx.createTracker()` to detect file changes without writing custom hash-checking logic. The tracker uses a shared `plugin_tracking` table with per-plugin namespacing — no custom tables needed.

```typescript
import type { Plugin, PluginContext, IndexablePlugin, IndexResult } from 'brainbank';
import { createHash } from 'node:crypto';

async index(): Promise<IndexResult> {
    const tracker = this._ctx.createTracker();
    const files = walkFiles();
    let indexed = 0, skipped = 0;

    for (const file of files) {
        const content = readFile(file);
        const hash = createHash('sha256').update(content).digest('hex').slice(0, 16);

        // Skip unchanged files
        if (tracker.isUnchanged(file, hash)) {
            skipped++;
            continue;
        }

        // Index the file
        await this._processFile(file, content);
        tracker.markIndexed(file, hash);
        indexed++;
    }

    // Detect deleted files
    const currentFiles = new Set(files);
    for (const orphan of tracker.findOrphans(currentFiles)) {
        this._removeFile(orphan);
        tracker.remove(orphan);
    }

    return { indexed, skipped };
}
```

#### IncrementalTracker API

| Method | Returns | Description |
|--------|---------|-------------|
| `isUnchanged(key, hash)` | `boolean` | `true` if the key exists with the same hash — skip indexing |
| `markIndexed(key, hash)` | `void` | Record that a key was indexed with this hash |
| `findOrphans(currentKeys)` | `string[]` | Tracked keys NOT in the current set — files that were deleted |
| `remove(key)` | `void` | Delete tracking for a single key |
| `clear()` | `void` | Delete all tracking entries for this plugin |

> [!TIP]
> The tracker key can be any string. Use file paths for simple cases, or `collection:path` for multi-collection plugins (like `@brainbank/docs` does).

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
  indexItems?(ids: string[]): Promise<IndexResult>; // optional granular re-index
}
// IndexOptions: { forceReindex?, depth?, onProgress? }
// IndexResult: { indexed: number, skipped: number, chunks?: number, removed?: number }
```

### SearchablePlugin

Results merged via RRF in `brain.hybridSearch()`:

```typescript
interface SearchablePlugin extends Plugin {
  search(query: string, options?: Record<string, unknown>): Promise<SearchResult[]>;
}
```

### WatchablePlugin

Plugin drives its own watching (fs.watch, polling, webhooks). Core only coordinates handles and triggers re-indexing:

```typescript
interface WatchablePlugin extends Plugin {
  watch(onEvent: WatchEventHandler): WatchHandle;
  watchConfig?(): WatchConfig;  // debounceMs, batchSize, priority
}
// WatchEvent: { type, sourceId, sourceName, payload? }
// WatchHandle: { stop(): Promise<void>, active: boolean }
```

### VectorSearchPlugin

Provides a domain-specific vector search strategy wired into CompositeVectorSearch:

```typescript
interface VectorSearchPlugin extends Plugin {
  createVectorSearch(): DomainVectorSearch | undefined;
}
// DomainVectorSearch: { search(queryVec, k, minScore, useMMR?, mmrLambda?, queryText?): SearchResult[] }
```

### BM25SearchPlugin

Provides FTS5 keyword search wired into `CompositeBM25Search`:

```typescript
interface BM25SearchPlugin extends Plugin {
  searchBM25(query: string, k: number, minScore?: number): SearchResult[];
  rebuildFTS?(): void;
}
```

### ContextFormatterPlugin

Contributes markdown sections to `brain.getContext()` output:

```typescript
interface ContextFormatterPlugin extends Plugin {
  formatContext(results: SearchResult[], parts: string[], fields: Record<string, unknown>): void;
}
```

### ContextFieldPlugin

Declares configurable fields that appear in the `fields` option of `getContext()`:

```typescript
interface ContextFieldPlugin extends Plugin {
  contextFields(): ContextFieldDef[];
}
// ContextFieldDef: { name, type: 'boolean'|'number'|'object', default, description }
```

### ExpandablePlugin

Powers LLM context expansion (after pruning, before formatting):

```typescript
interface ExpandablePlugin extends Plugin {
  buildManifest(excludeFilePaths: string[], excludeIds: number[]): ExpanderManifestItem[];
  resolveChunks(ids: number[]): SearchResult[];
}
```

### FileResolvablePlugin

Enables `brain.resolveFiles()` and the `brainbank files` CLI command:

```typescript
interface FileResolvablePlugin extends Plugin {
  resolveFiles(patterns: string[]): SearchResult[];
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

### MigratablePlugin

Plugin owns its DB schema via versioned migrations. Tables are created on `initialize()` — the core schema stays domain-free:

```typescript
import type { Migration } from 'brainbank';
import { runPluginMigrations } from 'brainbank';

interface MigratablePlugin extends Plugin {
  readonly schemaVersion: number;     // current version (e.g. 2)
  readonly migrations: Migration[];   // ordered list [v1, v2, ...]
}

// Each migration is an object with { version, up(adapter) }
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up(adapter) {
      adapter.exec(`CREATE TABLE IF NOT EXISTS my_items (...)`);
    },
  },
];

// Call at the top of initialize()
runPluginMigrations(ctx.db, 'my-plugin', SCHEMA_VERSION, MIGRATIONS);
```

> The migration runner reads the stored version from the `plugin_versions` table, runs only pending migrations (each in its own transaction), and stamps the new version. See [Migrations](migrations.md) for the full guide.

## Full Example: Notes Plugin

A plugin that reads `.txt` files and makes them searchable, with **incremental indexing**:

```typescript
import type { Plugin, PluginContext, IndexablePlugin, SearchablePlugin,
             SearchResult, IndexResult } from 'brainbank';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

function notesPlugin(dir: string): Plugin & IndexablePlugin & SearchablePlugin {
  let ctx: PluginContext;

  return {
    name: 'notes',

    async initialize(context) {
      ctx = context;
    },

    async index(): Promise<IndexResult> {
      const col = ctx.collection('notes');
      const tracker = ctx.createTracker();
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.txt'));
      let indexed = 0, skipped = 0;

      for (const file of files) {
        const content = fs.readFileSync(path.join(dir, file), 'utf-8');
        const hash = createHash('sha256').update(content).digest('hex').slice(0, 16);

        if (tracker.isUnchanged(file, hash)) {
          skipped++;
          continue;
        }

        await col.add(content, { metadata: { file } });
        tracker.markIndexed(file, hash);
        indexed++;
      }

      // Clean up deleted files
      for (const orphan of tracker.findOrphans(new Set(files))) {
        tracker.remove(orphan);
      }

      return { indexed, skipped };
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
await brain.index();  // → { indexed: 10, skipped: 0 }   first run
await brain.index();  // → { indexed: 0, skipped: 10 }   second run
const results = await brain.hybridSearch('meeting notes about auth');
```

---

## Watch Mode Integration

Hook into `brain.watch()` — your plugin drives its own watching:

```typescript
import type { Plugin, PluginContext, WatchablePlugin, WatchEventHandler, WatchHandle } from 'brainbank';
import * as fs from 'node:fs';
import * as path from 'node:path';

function csvPlugin(dir: string): Plugin & WatchablePlugin {
  let ctx: PluginContext;

  return {
    name: 'csv',

    async initialize(context) {
      ctx = context;
    },

    watch(onEvent: WatchEventHandler): WatchHandle {
      // Plugin controls HOW to watch — fs.watch, polling, webhook, etc.
      const watcher = fs.watch(dir, { recursive: true }, (event, filename) => {
        if (!filename?.endsWith('.csv')) return;
        onEvent({
          type: event === 'rename' ? 'create' : 'update',
          sourceId: path.join(dir, filename),
          sourceName: 'file',
        });
      });

      let active = true;
      return {
        async stop() { watcher.close(); active = false; },
        get active() { return active; },
      };
    },

    watchConfig() {
      return { debounceMs: 500 };  // batch rapid saves
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
- [Migrations](migrations.md) — versioned schema management

# Collections

Collections are the simplest way to store and search any data — API responses, Slack messages, logs, research notes, error traces, architecture decisions, anything. **No plugin needed.**

```typescript
import { BrainBank } from 'brainbank';

const brain = new BrainBank({ repoPath: '.' });
await brain.initialize();

const errors = brain.collection('errors');
const decisions = brain.collection('decisions');
```

Collections are auto-created on first use and auto-embedded for semantic search.

---

## Adding Data

```typescript
// Single item
await errors.add('TypeError: Cannot read property "id" of undefined', {
  tags: ['backend'],
  metadata: { file: 'src/user.ts', line: 42 },
});

// Batch add (uses embedBatch — much faster than individual adds)
await errors.addMany([
  { content: 'NullPointerException in AuthService', tags: ['backend'], metadata: { file: 'auth.ts' } },
  { content: 'CORS preflight failed on /api/users', tags: ['frontend'], metadata: { file: 'proxy.ts' } },
]);

// Update an existing item (re-embeds, preserves metadata/tags unless overridden)
const id = await errors.add('Old error message', { tags: ['backend'] });
await errors.update(id, 'Updated error message'); // keeps original tags
```

### Options for `add` / `update`

```typescript
{
  metadata?: Record<string, any>,  // arbitrary JSON metadata
  tags?: string[],                 // searchable tags
  ttl?: string,                    // auto-expire: '7d', '24h', '30m', '10s'
}
```

> **TTL:** Items with a `ttl` are auto-pruned from search/list results after expiration. Pruning runs lazily on `search()` and `list()` calls.

---

## Searching

```typescript
// Hybrid (default) — vector + BM25 fused with RRF
await errors.search('auth error');

// Vector only — semantic search (finds related concepts)
await errors.search('auth error', { mode: 'vector' });

// Keyword only — BM25 exact term matching
await errors.search('auth error', { mode: 'keyword' });

// With filters
await errors.search('auth error', { k: 10, tags: ['backend'], minScore: 0.3 });
```

### Search Modes

All KV collections share a **single HNSW vector index** (`kvHnsw`) owned by `KVService`. Collection isolation is enforced via `WHERE collection = ?` filters after an adaptive over-fetch from the shared index. Each collection also has its own FTS5 full-text search via the `fts_kv` virtual table.

| Mode | How it works | Best for |
|------|-------------|----------|
| `hybrid` (default) | Vector + BM25 → generic RRF fusion | General use — catches both concepts and exact terms |
| `vector` | HNSW k-NN on shared index + filter by collection | Semantic queries ("login problem" finds "auth failure") |
| `keyword` | SQLite FTS5 BM25 on `fts_kv` | Exact terms ("TypeError" finds that exact string) |

> **Adaptive over-fetch:** When searching the shared HNSW, the Collection computes `searchK = k * ratio` where `ratio = ceil(totalHnswSize / collectionCount)`, clamped to `[3, 50]`. This ensures enough candidates survive the collection filter.

---

## Management

```typescript
decisions.list({ limit: 20 });              // newest first
decisions.list({ tags: ['architecture'] });  // filter by tags
decisions.count();                           // total items (excludes expired)
decisions.remove(id);                        // remove by ID
decisions.clear();                           // remove all items
decisions.trim({ keep: 50 });               // keep N most recent
decisions.prune({ olderThan: '30d' });       // remove older than 30 days
brain.listCollectionNames();                 // → ['errors', 'decisions']
brain.deleteCollection('old_data');          // delete + evict from cache + HNSW
```

---

## API Reference

| Method | Signature | Description |
|--------|-----------|-------------|
| `add` | `add(content, options?): Promise<number>` | Add an item. Returns its ID. Embeds first — if embedding fails, no orphaned DB row. |
| `addMany` | `addMany(items): Promise<number[]>` | Batch add (uses `embedBatch`). DB writes in single transaction; HNSW updated after commit. |
| `update` | `update(id, content, options?): Promise<number>` | Replace content, re-embed. Preserves original metadata/tags unless overridden. Returns new ID. |
| `search` | `search(query, options?): Promise<CollectionItem[]>` | Hybrid search. Options: `k`, `mode`, `minScore`, `tags`. |
| `searchAsResults` | `searchAsResults(query, k): Promise<SearchResult[]>` | Search returning `SearchResult[]` (type `'collection'`) for use in top-level hybrid pipelines. |
| `list` | `list(options?): CollectionItem[]` | List items (newest first). Options: `limit`, `offset`, `tags`. Auto-prunes expired. |
| `count` | `count(): number` | Total items in collection (excludes expired). |
| `remove` | `remove(id): void` | Remove a specific item by ID. Removes from DB, HNSW, and cache. |
| `clear` | `clear(): void` | Remove all items in the collection. |
| `trim` | `trim({ keep }): Promise<{ removed }>` | Keep N most recent items, remove the rest. |
| `prune` | `prune({ olderThan }): Promise<{ removed }>` | Remove items older than a duration (e.g. `'30d'`, `'12h'`). |

---

## Collection Search vs BrainBank Search

Collections are the **low-level storage primitive**. Plugins use them internally, and you can use them directly for custom data. BrainBank's top-level search methods orchestrate across *all* sources:

```
brain.hybridSearch('auth')                  ← searches EVERYTHING via RRF
  ├── CompositeVectorSearch (shared HNSW)   ← code + git vectors (via VectorSearchPlugin)
  ├── CompositeBM25Search (FTS5 BM25)       ← plugin-driven keyword search
  ├── SearchablePlugins                     ← docs plugin (own HNSW + BM25)
  └── KV collections                        ← if named in options.sources

brain.collection('errors').search('auth')   ← searches ONLY that collection
```

| Level | Method | What it searches |
|-------|--------|-----------------|
| **BrainBank** | `hybridSearch(q, options?)` | All sources → RRF |
| **BrainBank** | `search(q, options?)` | Vector strategies + searchable plugins |
| **BrainBank** | `searchBM25(q, options?)` | Plugin-driven FTS5 keyword search |
| **Plugin** | `brain.plugin('docs').search(q)` | Document collections only |
| **Collection** | `collection.search(q)` | Single collection (shared HNSW + FTS5) |

To include a named KV collection in top-level hybrid search, pass its name in `sources`:

```typescript
// Include 'errors' and 'decisions' collections in hybrid search
await brain.hybridSearch('auth problem', {
  sources: { code: 10, git: 5, errors: 5, decisions: 3 },
});
```

> **Plugins use collections internally.** When a plugin calls `ctx.collection('notes')` in its `initialize()`, it gets the same `Collection` primitive. This is how custom plugins get hybrid search for free.

From the CLI, use `--<collection> <n>` to include them in hybrid search results:

```bash
brainbank hsearch "auth" --errors 5 --decisions 3
```

---

## See Also

- [Search](search.md) — top-level search orchestration
- [Custom Plugins](custom-plugins.md) — plugins that create collections internally

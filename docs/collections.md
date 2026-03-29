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
  ttl?: string,                    // auto-expire: '7d', '24h', '30m'
}
```

> **TTL:** Items with a `ttl` are auto-pruned from search/list results after expiration.

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

Every collection has its own **HNSW vector index** and **FTS5 full-text table**:

| Mode | How it works | Best for |
|------|-------------|----------|
| `hybrid` (default) | Vector + BM25 → RRF fusion | General use — catches both concepts and exact terms |
| `vector` | HNSW k-NN on embeddings | Semantic queries ("login problem" finds "auth failure") |
| `keyword` | SQLite FTS5 BM25 | Exact terms ("TypeError" finds that exact string) |

---

## Management

```typescript
decisions.list({ limit: 20 });              // newest first
decisions.list({ tags: ['architecture'] });  // filter by tags
decisions.count();                           // total items
decisions.remove(id);                        // remove by ID
decisions.clear();                           // remove all items
decisions.trim({ keep: 50 });               // keep N most recent
decisions.prune({ olderThan: '30d' });       // remove older than 30 days
brain.listCollectionNames();                 // → ['errors', 'decisions']
```

---

## API Reference

| Method | Signature | Description |
|--------|-----------|-------------|
| `add` | `add(content, options?): Promise<number>` | Add an item. Returns its ID. Auto-embedded for vector search. |
| `addMany` | `addMany(items): Promise<number[]>` | Batch add (uses `embedBatch` — much faster). Returns IDs. |
| `update` | `update(id, content, options?): Promise<number>` | Replace content, re-embed. Preserves original metadata/tags unless overridden. |
| `search` | `search(query, options?): Promise<CollectionItem[]>` | Hybrid search. Options: `k`, `mode`, `minScore`, `tags`. |
| `list` | `list(options?): CollectionItem[]` | List items (newest first). Options: `limit`, `offset`, `tags`. |
| `count` | `count(): number` | Total items in collection. |
| `remove` | `remove(id): void` | Remove a specific item by ID. |
| `clear` | `clear(): void` | Remove all items in the collection. |
| `trim` | `trim({ keep }): Promise<{ removed }>` | Keep N most recent items, remove the rest. |
| `prune` | `prune({ olderThan }): Promise<{ removed }>` | Remove items older than a duration (e.g. `'30d'`, `'12h'`). |

---

## Collection Search vs BrainBank Search

Collections are the **low-level storage primitive**. Plugins use them internally, and you can use them directly for custom data. BrainBank's top-level search methods orchestrate across *all* sources:

```
brain.hybridSearch('auth')                  ← searches EVERYTHING via RRF
  ├── SearchAPI (shared HNSW)               ← code + git vectors
  ├── DocsPlugin.search()                   ← doc collections (own HNSW)
  └── collection('errors').search()         ← if passed in options

brain.collection('errors').search('auth')   ← searches ONLY that collection
```

| Level | Method | What it searches |
|-------|--------|-----------------|
| **BrainBank** | `hybridSearch(q)` | All sources → RRF |
| **BrainBank** | `search(q)` | Code + git vectors (shared HNSW) |
| **BrainBank** | `searchBM25(q)` | Code + git text (FTS5) |
| **Plugin** | `brain.docs!.search(q)` | Document collections only |
| **Collection** | `collection.search(q)` | Single collection (own HNSW + FTS5) |

> **Plugins use collections internally.** When a plugin calls `ctx.collection('notes')` in its `initialize()`, it gets the same `Collection` primitive. This is how custom plugins get hybrid search for free.

Collections work standalone or alongside plugins. From the CLI, use `--<collection> <n>` to include them in hybrid search results:

```bash
brainbank hsearch "auth" --errors 5 --decisions 3
```

> 📂 See [examples/collection](../examples/collection/) for a complete runnable demo with cross-collection linking and metadata.

---

## See Also

- [Search](search.md) — top-level search orchestration
- [Custom Plugins](custom-plugins.md) — plugins that create collections internally

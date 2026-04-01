# Search

BrainBank provides three search modes at the top level, and per-collection search for custom data.

## Search Modes

| Mode | Method | Speed | Quality |
|------|--------|-------|---------|
| Keyword | `searchBM25(q)` | ⚡ instant | Good for exact terms |
| Vector | `search(q)` | ~50ms | Good for concepts |
| **Hybrid** | `hybridSearch(q)` | ~100ms | **Best — catches both** |

```typescript
// Hybrid search (recommended default)
const results = await brain.hybridSearch('authentication middleware');

// Source filtering via `sources` — control how many results per source, set to 0 to skip
const codeOnly = await brain.hybridSearch('auth', { sources: { code: 10, git: 0 } });
const gitOnly  = await brain.hybridSearch('auth', { sources: { code: 0, git: 10 } });
const balanced = await brain.hybridSearch('auth', { sources: { code: 3, git: 3 } });

// Include docs and KV collections in hybrid search
const results = await brain.hybridSearch('auth middleware', {
  sources: { code: 20, git: 8, docs: 5, errors: 3 },
});
```

---

## Source Filtering

Every search method accepts a `sources` option — a map of source name to max result count:

```typescript
interface SearchOptions {
  sources?: Record<string, number>; // { code: n, git: n, docs: n, <collection>: n }
  minScore?: number;                // default: 0.25
  useMMR?: boolean;                 // default: true — diversify results
  mmrLambda?: number;               // default: 0.7 — 0=pure diversity, 1=pure relevance
}
```

Built-in source keys: `"code"`, `"git"`. Any other key searches a KV collection with that name. Plugins that implement `SearchablePlugin` contribute results automatically.

```typescript
// Vector search filtered to code only
await brain.search('auth', { sources: { code: 8, git: 0 } });

// BM25 keyword search filtered to git only
await brain.searchBM25('fix auth bug', { sources: { code: 0, git: 8 } });
```

---

## Score Interpretation

| Score | Meaning |
|-------|---------|
| 0.8+ | Near-exact match |
| 0.5–0.8 | Strongly related |
| 0.3–0.5 | Somewhat related |
| < 0.3 | Weak match |

---

## How Search Works

BrainBank has **two levels** of search, orchestrated by `SearchAPI`:

```
brain.hybridSearch('auth')
  │
  ├── CompositeVectorSearch (via VectorSearchPlugin discovery)
  │     ├── Embed query once
  │     └── Delegate to domain strategies (code, git)
  │
  ├── KeywordSearch (FTS5 BM25)
  │     ├── fts_code (file_path×5, name×3, content×1)
  │     └── fts_commits (message×5, author×2, diff×1)
  │
  ├── SearchablePlugins (per-plugin, not in vector search)
  │     └── DocsPlugin.search() ── own HNSW + BM25 → RRF → dedup by file
  │
  ├── KV Collections (named in sources)
  │     └── collection.searchAsResults() ── shared kvHnsw + fts_kv
  │
  └── Reciprocal Rank Fusion (k=60, maxResults=15)
        └── Optional: Qwen3 Reranker (position-aware blend)
```

**Plugin-based discovery:** `createSearchAPI()` iterates over all registered plugins. Plugins implementing `VectorSearchPlugin` provide domain strategies wired into `CompositeVectorSearch`. Plugins implementing `SearchablePlugin` (but not `VectorSearchPlugin`) contribute results that get fused via RRF.

### Method Reference

| Method | Engine | What it searches |
|--------|--------|-----------------|
| `search(q, opts?)` | CompositeVectorSearch + SearchablePlugins | Vector strategies + plugin search → RRF |
| `searchBM25(q, opts?)` | KeywordSearch | Code + git text (FTS5) |
| `hybridSearch(q, opts?)` | All engines | Vector + BM25 + plugins + KV → RRF → rerank |
| `getContext(task, opts?)` | ContextBuilder | All sources → formatted markdown |

---

## Context Generation

Get formatted markdown ready for system prompt injection:

```typescript
const context = await brain.getContext('add rate limiting to the API', {
  sources: { code: 6, git: 5 },
  affectedFiles: ['src/api/routes.ts'],
  useMMR: true,
});
```

### ContextOptions

```typescript
interface ContextOptions {
  sources?: Record<string, number>; // { code: n, git: n }
  affectedFiles?: string[];         // improves co-edit suggestions
  minScore?: number;                // default: 0.25
  useMMR?: boolean;                 // default: true
  mmrLambda?: number;               // default: 0.7
}
```

The `ContextBuilder` assembles markdown from multiple sources. It discovers formatters from plugins implementing `ContextFormatterPlugin` — each plugin appends its own sections to the output. For `SearchablePlugin` plugins that aren't `ContextFormatterPlugin`, results are appended as bullet lists.

Returns structured markdown with:

- **Relevant Code** — grouped by file, with call graph annotations (from `code_refs`)
- **Related Files** — import graph expansion (2-hop traversal of `code_imports`)
- **Git History** — relevant commits with diff snippets
- **Co-Edit Patterns** — files that tend to change together
- **Relevant Documents** — matching doc chunks with collection context

CLI equivalent:

```bash
brainbank context "add rate limiting to the API"
```

---

## Search Pipeline

```
Query
  │
  ├──► Vector Search (HNSW k-NN)  ──► candidates
  ├──► Keyword Search (BM25/FTS5)  ──► candidates
  │
  ▼
Reciprocal Rank Fusion (RRF, k=60)
  │
  ▼
Optional: Qwen3-Reranker (position-aware blend)
  │
  ▼
Final results (sorted by blended score)
```

### RRF Key Generation

Each result type produces a unique key for deduplication across search systems:

| Type | Key format |
|------|-----------|
| `code` | `code:{filePath}:{startLine}-{endLine}` |
| `commit` | `commit:{hash}` |
| `document` | `document:{filePath}:{collection}:{seq}:{content[:80]}` |
| `collection` | `collection:{id}` |

---

## See Also

- [Collections](collections.md) — per-collection search modes
- [Embeddings & Reranker](embeddings.md) — reranker configuration and benchmarks
- [Indexing](indexing.md) — code graph enrichment for better search

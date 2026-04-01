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

Built-in source keys: `"code"`, `"git"`, `"docs"`. Each participates via `VectorSearchPlugin` + `BM25SearchPlugin`. Any other key in `sources` that doesn't match a registered plugin name searches a KV collection with that name.

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

> **Note on RRF scores:** Hybrid search uses Reciprocal Rank Fusion. All results in a fused set are normalized so the top result scores 1.0. Use `minScore` filters cautiously with hybrid mode — a result with score 0.8 means "80% as good as the best match", not an absolute relevance threshold.

---

## How Search Works

BrainBank has **two levels** of search, orchestrated by `SearchAPI`:

```
brain.hybridSearch('auth')
  │
  ├── CompositeVectorSearch (via VectorSearchPlugin discovery)
  │     ├── Embed query once
  │     └── Delegate to domain strategies (code, git, docs)
  │
  ├── CompositeBM25Search (via BM25SearchPlugin discovery)
  │     └── Delegates to each plugin's searchBM25() method
  │
  ├── SearchablePlugins (per-plugin, not in vector/BM25 pipelines)
  │     └── Custom plugins implementing SearchablePlugin only
  │
  ├── KV Collections (named in sources, not matching any plugin name)
  │     └── collection.searchAsResults() ── shared kvHnsw + fts_kv
  │
  └── Reciprocal Rank Fusion (k=60, maxResults=15)
        └── Optional: Qwen3 Reranker (position-aware blend)
```

**Plugin-based discovery:** `createSearchAPI()` iterates over all registered plugins:
- Plugins implementing `VectorSearchPlugin` contribute a `DomainVectorSearch` strategy wired into `CompositeVectorSearch` (embed once, search all domains). Code, git, and docs all participate this way.
- Plugins implementing `BM25SearchPlugin` get called by `CompositeBM25Search` for keyword search.
- Plugins implementing `SearchablePlugin` (but not `VectorSearchPlugin`) have their `search()` results fused via RRF — this is for custom plugins with their own search pipeline.

### Method Reference

| Method | Engine | What it searches |
|--------|--------|-----------------|
| `search(q, opts?)` | CompositeVectorSearch + SearchablePlugins | Vector strategies + plugin search → RRF |
| `searchBM25(q, opts?)` | CompositeBM25Search | Plugin-driven FTS5 BM25 (code + git) |
| `hybridSearch(q, opts?)` | All engines | Vector + BM25 + plugins + KV → RRF → optional rerank |
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
  affectedFiles?: string[];         // improves co-edit suggestions (passed to GitPlugin.formatContext)
  minScore?: number;                // default: 0.25
  useMMR?: boolean;                 // default: true
  mmrLambda?: number;               // default: 0.7
}
```

The `ContextBuilder` assembles markdown from multiple sources discovered at runtime:
1. Runs `CompositeVectorSearch.search()` to get ranked code + git results.
2. For each plugin implementing `ContextFormatterPlugin`: calls `formatContext(results, parts, options)` — each plugin appends domain-specific sections.
3. For each plugin implementing `SearchablePlugin` (but not `ContextFormatterPlugin`): calls `search()` and appends results as a simple markdown list.

Returns structured markdown with:

- **Relevant Code** — grouped by file, with call graph annotations (from `code_refs`)
- **Related Files** — import graph expansion (2-hop traversal of `code_imports`)
- **Git History** — relevant commits with diff snippets
- **Co-Edit Patterns** — files that tend to change together (from `co_edits`)
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
  ├──► Vector Search (HNSW k-NN, embed once per domain)
  ├──► Keyword Search (BM25/FTS5 per plugin)
  ├──► SearchablePlugins (custom — own hybrid pipeline)
  │
  ▼
Reciprocal Rank Fusion (RRF, k=60, maxResults=15)
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
| `commit` | `commit:{hash or shortHash}` |
| `document` | `document:{filePath}:{collection}:{seq}:{content[:80]}` |
| `collection` | `collection:{id or content[:80]}` |

### MMR Diversity

By default, vector searches use **Maximum Marginal Relevance** (MMR) to avoid returning redundant results:

```typescript
// Disable MMR for raw k-NN results
await brain.search('auth', { useMMR: false });

// Tune diversity vs relevance
await brain.search('auth', { mmrLambda: 0.5 }); // 50/50 balance (default: 0.7 = 70% relevance)
```

MMR over-fetches 3× candidates from HNSW, then greedily selects items that maximize `λ * relevance - (1-λ) * max_similarity_to_selected`.

---

## SearchResult Types

All search methods return `SearchResult[]` — a discriminated union:

```typescript
type SearchResult = CodeResult | CommitResult | DocumentResult | CollectionResult;

// Type narrowing
import { isCodeResult, isCommitResult, isDocumentResult, isCollectionResult, matchResult } from 'brainbank';

for (const r of results) {
  matchResult(r, {
    code:       (r) => console.log(`${r.filePath}:${r.metadata.startLine}`),
    commit:     (r) => console.log(`[${r.metadata.shortHash}] ${r.content}`),
    document:   (r) => console.log(`[${r.metadata.collection}] ${r.filePath}`),
    collection: (r) => console.log(`[${r.metadata.collection}] ${r.content}`),
  });
}
```

---

## See Also

- [Collections](collections.md) — per-collection search modes
- [Embeddings & Reranker](embeddings.md) — reranker configuration and benchmarks
- [Indexing](indexing.md) — code graph enrichment for better search
- [Plugins](plugins.md) — how plugins contribute to search

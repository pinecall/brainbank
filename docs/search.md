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

Built-in source keys: `"code"`, `"git"`, `"docs"`, `"memory"`. Any other key searches a KV collection with that name.

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

BrainBank has **two levels** of search:

```
brain.hybridSearch('auth')
  │
  ├── SearchAPI (centralized orchestration)
  │     ├── VectorSearch ──── shared HNSW ──── code + git vectors
  │     ├── KeywordSearch ─── FTS5 BM25 ────── code + git text
  │     └── RRF fusion ────── merges all result lists
  │
  ├── Plugin search (per-plugin, via SearchablePlugin)
  │     └── DocsPlugin.search() ── own HNSW ── doc vectors
  │
  └── KV Collections ── per-collection HNSW+FTS5 ── custom data
                        (included when named in `sources`)
```

**Centralized search** (`SearchAPI`) manages a shared multi-index HNSW that holds both code and git vectors.

**Plugin-owned search** runs independently. The docs plugin has its own HNSW index and BM25 search, because document collections can use different embedding dimensions (via per-plugin `embeddingProvider`).

**`hybridSearch()`** combines all of them — it queries the shared indices, plugin searches, and any named KV collections, then fuses everything with [Reciprocal Rank Fusion (RRF)](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf).

### Method Reference

| Method | Engine | What it searches |
|--------|--------|-----------------|
| `search(q, options?)` | VectorSearch | Code + git vectors (shared HNSW) |
| `searchBM25(q, options?)` | KeywordSearch | Code + git text (FTS5) |
| `brain.docs!.search(q)` | DocsPlugin | Document vectors (own HNSW + BM25) |
| `hybridSearch(q, options?)` | All engines | **All sources** → RRF fusion |
| `getContext(task, options?)` | All engines | All sources → formatted markdown |

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
  sources?: Record<string, number>; // { code: n, git: n, memory: n }
  affectedFiles?: string[];         // improves co-edit suggestions
  minScore?: number;                // default: 0.25
  useMMR?: boolean;                 // default: true
  mmrLambda?: number;               // default: 0.7
}
```

Returns structured markdown with:

- **Relevant Code** — grouped by file, with call graph annotations
- **Related Files** — import graph (who imports what)
- **Git History** — relevant commits with diffs
- **Co-Edit Patterns** — files that tend to change together
- **Relevant Documents** — matching doc chunks

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

---

## See Also

- [Collections](collections.md) — per-collection search modes
- [Embeddings & Reranker](embeddings.md) — reranker configuration and benchmarks
- [Indexing](indexing.md) — code graph enrichment for better search

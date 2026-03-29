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

// Source filtering — control how many results per source
const codeOnly = await brain.hybridSearch('auth', { codeK: 10, gitK: 0 });
const gitOnly  = await brain.hybridSearch('auth', { codeK: 0, gitK: 10 });
const balanced = await brain.hybridSearch('auth', { codeK: 3, gitK: 3 });

// Include KV collections in hybrid search
const results = await brain.hybridSearch('auth middleware', {
  codeK: 20,
  gitK: 8,
  collections: { errors: 5, patterns: 3 },
});
```

---

## Scoped Search

Convenience methods for searching specific sources:

```typescript
const codeHits = await brain.searchCode('parse JSON config', 8);
const commitHits = await brain.searchCommits('fix auth bug', 5);
const docHits = await brain.docs!.search('getting started', { collection: 'wiki' });
```

These are shortcuts for source-filtered search:

```typescript
// These are equivalent:
await brain.searchCode('auth', 8);
await brain.search('auth', { codeK: 8, gitK: 0 });
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
  └── Plugin search (per-plugin, via SearchablePlugin)
        └── DocsPlugin.search() ── own HNSW ── doc vectors
```

**Centralized search** (`SearchAPI`) manages a shared multi-index HNSW that holds both code and git vectors.

**Plugin-owned search** runs independently. The docs plugin has its own HNSW index and BM25 search, because document collections can use different embedding dimensions (via per-plugin `embeddingProvider`).

**`hybridSearch()`** combines both — it queries the shared indices AND plugin searches, then fuses everything with [Reciprocal Rank Fusion (RRF)](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf).

### Method Reference

| Method | Engine | What it searches |
|--------|--------|-----------------|
| `search(q)` | VectorSearch | Code + git vectors (shared HNSW) |
| `searchCode(q)` | VectorSearch (filtered) | Code vectors only |
| `searchCommits(q)` | VectorSearch (filtered) | Git vectors only |
| `searchBM25(q)` | KeywordSearch | Code + git text (FTS5) |
| `brain.docs!.search(q)` | DocsPlugin | Document vectors (own HNSW + BM25) |
| `hybridSearch(q)` | All engines | **All sources** → RRF fusion |
| `getContext(task)` | All engines | All sources → formatted markdown |

---

## Context Generation

Get formatted markdown ready for system prompt injection:

```typescript
const context = await brain.getContext('add rate limiting to the API', {
  codeResults: 6,
  gitResults: 5,
  affectedFiles: ['src/api/routes.ts'],
  useMMR: true,
});
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

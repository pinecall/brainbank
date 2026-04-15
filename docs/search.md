# Search

BrainBank provides four search methods at the top level, plus per-collection search for custom data.

## Search Modes

| Mode | Method | Speed | Quality |
|------|--------|-------|---------|
| Keyword | `searchBM25(q)` | ⚡ instant | Good for exact terms |
| Vector | `search(q)` | ~50ms | Good for concepts |
| **Hybrid** | `hybridSearch(q)` | ~100ms | **Best — catches both** |
| Context | `getContext(task)` | ~150ms | Formatted markdown for LLM |

```typescript
// Hybrid search (recommended default)
const results = await brain.hybridSearch('authentication middleware');

// Source filtering — control how many results per source, set to 0 to skip
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
  source?: 'cli' | 'mcp' | 'daemon' | 'api'; // caller origin for debug logging
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

BrainBank has **two levels** of search, orchestrated by `SearchAPI` (wired at init time by `createSearchAPI()`).

> **Multi-process safety:** All search methods call `ensureFresh()` before executing. If another process (e.g. CLI `brainbank index`) has updated the HNSW indices, stale in-memory copies are hot-reloaded from disk automatically (~5μs version check via `index_state` table).

```
brain.hybridSearch('auth')
  │
  ├── ensureFresh() ← hot-reload stale HNSW if another process indexed
  │
  ├── CompositeVectorSearch (via VectorSearchPlugin discovery)
  │     ├── Embed query ONCE
  │     └── Delegate to domain strategies: code, git, docs
  │           └── Each strategy: HNSW k-NN + optional BM25 fusion internally
  │
  ├── CompositeBM25Search (via BM25SearchPlugin discovery)
  │     └── Calls each plugin's searchBM25() → FTS5 on code_chunks / git_commits / doc_chunks
  │
  ├── SearchablePlugins (not in vector/BM25 pipelines)
  │     └── Custom plugins implementing SearchablePlugin only
  │
  ├── KV Collections (source names not matching any plugin)
  │     └── collection.searchAsResults() → shared kvHnsw + fts_kv
  │
  └── Reciprocal Rank Fusion (k=60, maxResults=15)
        └── Optional: Qwen3 Reranker (position-aware score blend)
```

### Method Reference

| Method | Engine | What it searches |
|--------|--------|-----------------|
| `search(q, opts?)` | CompositeVectorSearch + SearchablePlugins | Vector strategies → RRF |
| `searchBM25(q, opts?)` | CompositeBM25Search | Plugin-driven FTS5 BM25 keyword |
| `hybridSearch(q, opts?)` | All engines | Vector + BM25 + plugins + KV → RRF → optional rerank |
| `getContext(task, opts?)` | ContextBuilder | All sources → prune → expand → formatted markdown |

---

## Context Generation

Get formatted markdown ready for system prompt injection:

```typescript
const context = await brain.getContext('add rate limiting to the API', {
  sources: { code: 6, git: 5 },
  affectedFiles: ['src/api/routes.ts'],
  pathPrefix: 'src/api/',
  ignorePaths: ['src/api/tests/', 'src/api/mocks/'],
  fields: {
    lines: true,                  // prefix each line with source line number
    callTree: { depth: 2 },       // call tree expansion depth
    symbols: true,                // append symbol index
    imports: true,                // dependency summary
    compact: false,               // full bodies (not just signatures)
    expander: true,               // LLM context expansion (HaikuExpander)
  },
});
```

### ContextOptions

```typescript
interface ContextOptions {
  sources?: Record<string, number>;  // { code: n, git: n }
  affectedFiles?: string[];          // improves co-edit suggestions
  minScore?: number;                 // default: 0.25
  useMMR?: boolean;                  // default: true
  mmrLambda?: number;                // default: 0.7
  pathPrefix?: string;               // filter to files under this path
  ignorePaths?: string[];            // exclude results whose filePath starts with any prefix
  excludeFiles?: Set<string>;        // session-level dedup
  pruner?: Pruner;                   // per-request pruner override
  fields?: Record<string, unknown>;  // BrainBankQL field overrides
  source?: 'cli' | 'mcp' | 'daemon' | 'api'; // for debug logging
}
```

### BrainBankQL Fields

Context fields are declared by plugins via `ContextFieldPlugin.contextFields()` and resolved in three layers: **plugin defaults ← config.json `context` section ← per-query `fields`**.

`@brainbank/code` declares:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `lines` | boolean | `false` | Prefix each code line with source line number |
| `callTree` | boolean \| `{ depth: N }` | `true` | Call tree expansion. `false` = disabled, `{ depth: 2 }` = custom depth |
| `imports` | boolean | `true` | Dependency/import summary section |
| `symbols` | boolean | `false` | Symbol index for matched files |
| `compact` | boolean | `false` | Show only signatures, skip bodies |

Set defaults in `config.json`:

```jsonc
// .brainbank/config.json
{
  "context": {
    "lines": true,
    "callTree": { "depth": 2 },
    "symbols": false
  }
}
```

---

## Context Building Pipeline

```
getContext(task, options)
  │
  ├── 1. CompositeVectorSearch.search(task)  ← primary retrieval
  │
  ├── 2. filterByPath(results, pathPrefix)   ← path scoping (include)
  │
  ├── 3. filterByIgnore(results, ignorePaths) ← path exclusion (exclude)
  │
  ├── 4. pruneResults(task, results, pruner) ← LLM noise filter (optional)
  │        └── HaikuPruner: send file previews to Haiku 4.5 for keep/drop
  │
  ├── 5. Filter excludeFiles                 ← session dedup
  │
  ├── 6. _expand(task, results)              ← LLM context expansion (if expander=true)
  │        ├── buildManifest from ExpandablePlugin
  │        ├── HaikuExpander.expand() → additional chunk IDs
  │        └── resolveChunks(ids) → splice into results
  │
  ├── 7. _appendFormatterResults             ← ContextFormatterPlugin per plugin
  │        ├── CodePlugin.formatContext()    → Workflow Trace (call tree, annotations)
  │        ├── GitPlugin.formatContext()     → commit history + co-edits
  │        └── DocsPlugin.formatContext()    → document sections
  │
  ├── 8. _appendSearchableResults            ← SearchablePlugin fallback (generic list)
  │
  └── 9. Append expander note (if any)
```

---

## Search Pipeline Detail

```
Query
  │
  ├──► Vector Search (HNSW k-NN, embed once per domain)
  ├──► Keyword Search (BM25/FTS5 per plugin)
  ├──► SearchablePlugins (custom — own pipeline)
  │
  ▼
Reciprocal Rank Fusion (RRF, k=60, maxResults=15)
  │
  ▼
Optional: Qwen3-Reranker (position-aware blend)
  │    pos 1-3  → 75% retrieval / 25% reranker
  │    pos 4-10 → 60% / 40%
  │    pos 11+  → 40% / 60%
  │
  ▼
Optional: Pruner (LLM noise filter — Haiku keep/drop)
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
await brain.search('auth', { mmrLambda: 0.5 }); // 50/50 balance (default: 0.7)
```

MMR over-fetches 3× candidates from HNSW, then greedily selects items that maximize:
`λ * relevance - (1-λ) * max_similarity_to_selected`

---

## SearchResult Types

All search methods return `SearchResult[]` — a discriminated union:

```typescript
type SearchResult = CodeResult | CommitResult | DocumentResult | CollectionResult;

// Type narrowing with helpers
import { isCodeResult, isCommitResult, isDocumentResult, isCollectionResult, matchResult } from 'brainbank';

for (const r of results) {
  matchResult(r, {
    code:       (r) => console.log(`${r.filePath}:${r.metadata.startLine}`),
    commit:     (r) => console.log(`[${r.metadata.shortHash}] ${r.content}`),
    document:   (r) => console.log(`[${r.metadata.collection}] ${r.filePath}`),
    collection: (r) => console.log(`[${r.metadata.collection}] ${r.content}`),
    _:          (r) => console.log(`score: ${r.score}`), // fallback
  });
}
```

### CodeResult

```typescript
interface CodeResult {
  type: 'code';
  score: number;
  filePath: string;
  content: string;           // full file content (zero truncation)
  metadata: {
    id?: number;             // code_chunks.id (used for call graph seeding)
    chunkIds?: number[];     // all chunk IDs for file-level results
    chunkType: string;       // 'file' | 'function' | 'class' | 'method' | 'synopsis'
    name?: string;
    startLine: number;
    endLine: number;
    language: string;
    rrfScore?: number;
  };
}
```

### CommitResult

```typescript
interface CommitResult {
  type: 'commit';
  score: number;
  content: string;           // commit message
  metadata: {
    hash: string;
    shortHash: string;
    author: string;
    date: string;
    files: string[];
    additions?: number;
    deletions?: number;
    diff?: string;
  };
}
```

### DocumentResult

```typescript
interface DocumentResult {
  type: 'document';
  score: number;
  filePath: string;
  content: string;
  context?: string;          // from path_contexts tree lookup
  metadata: {
    collection?: string;
    title?: string;
    seq?: number;
    chunkId?: number;
  };
}
```

---

## `resolveFiles` — Direct File Access

Bypass search entirely and fetch files directly from the index:

```typescript
const results = brain.resolveFiles([
  'src/auth/login.ts',       // exact path
  'src/graph/',              // directory (trailing /)
  'src/**/*.service.ts',     // glob pattern
  'plugin.ts',               // fuzzy basename fallback
]);
```

Equivalent CLI command: `brainbank files <path|glob>`

Each `FileResolvablePlugin` (e.g. `@brainbank/code`) handles its own resolution with a 4-tier strategy: exact → directory → glob → fuzzy basename.

---

## Query Debug Log

All search calls are logged to `/tmp/brainbank.log`:

```
═══════════════════════════════════════════════════════════════════
[2025-01-15T10:32:11.456Z] CLI · hybridSearch
Query: "authentication middleware"
Embedding: perplexity-context | Pruner: none | Reranker: none
Duration: 142ms

Results (8):
  # 1  94% src/auth/middleware.ts                      [AuthMiddleware]
  # 2  87% src/auth/guard.ts                           [AuthGuard]
  ...
```

Log auto-truncates at 10MB (keeps newest half).

---

## See Also

- [Collections](collections.md) — per-collection search modes
- [Embeddings, Reranker & Pruner](embeddings.md) — reranker, pruner, expander config
- [Indexing](indexing.md) — code graph enrichment for better search
- [Plugins](plugins.md) — how plugins contribute to search
- [Custom Plugins](custom-plugins.md) — build plugins with search capabilities

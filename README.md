# 🧠 BrainBank

**Semantic knowledge bank for AI agents** — indexes code, documents, and git history into a single SQLite file with hybrid search (vector + BM25 + RRF). Supports multi-repository indexing into a shared database.

BrainBank gives LLMs a searchable long-term memory that persists between sessions.

- **All-in-one** — core + code + git + docs + CLI in a single `brainbank` package
- **Pluggable indexers** — `.use()` only what you need (code, git, docs, or custom)
- **Dynamic collections** — `brain.collection('errors')` for any structured data
- **Hybrid search** — vector + BM25 fused with Reciprocal Rank Fusion
- **Pluggable embeddings** — local WASM (free) or OpenAI (higher quality)
- **Multi-repo** — index multiple repositories into one shared database
- **Portable** — single `.brainbank/brainbank.db` file
- **Optional packages** — [`@brainbank/reranker`](#reranker) (Qwen3 cross-encoder) and [`@brainbank/mcp`](#mcp-server) (MCP server) as separate lightweight installs

![BrainBank Architecture](assets/architecture.png)

---

### Table of Contents

- [Installation](#installation)
- [CLI](#cli)
- [Programmatic API](#programmatic-api)
  - [Indexers](#indexers)
  - [Collections](#collections)
  - [Search](#search)
  - [Document Collections](#document-collections)
  - [Context Generation](#context-generation)
  - [Custom Indexers](#custom-indexers)
  - [Watch Mode](#watch-mode)
- [MCP Server](#mcp-server)
- [Configuration](#configuration)
  - [Embedding Providers](#embedding-providers)
  - [Reranker](#reranker)
- [Multi-Repository Indexing](#multi-repository-indexing)
- [Indexing](#indexing-1)
  - [Incremental Indexing](#incremental-indexing)
  - [Re-embedding](#re-embedding)
- [Architecture](#architecture)
  - [Search Pipeline](#search-pipeline)
- [Testing](#testing)

---

## Installation

```bash
npm install brainbank
```

### Optional Packages

| Package | When to install |
|---------|----------------|
| `@brainbank/reranker` | Cross-encoder reranker (Qwen3-0.6B, ~640MB model) |
| `@brainbank/mcp` | MCP server for AI tool integration |

```bash
# Reranker — improves search ranking with local neural inference
npm install @brainbank/reranker node-llama-cpp

# MCP server — for Antigravity, Claude Desktop, etc.
npm install @brainbank/mcp
```

---

## CLI

BrainBank can be used entirely from the command line — no config file needed.

### Indexing

`index` processes **code files + git history** only. Document collections are indexed separately with `docs`.

```bash
brainbank index [path]                      # Index code + git history
brainbank index [path] --force              # Force re-index everything
brainbank index [path] --depth 200          # Limit git commit depth
brainbank docs [--collection <name>]        # Index document collections
```

> **Multi-repo:** If `[path]` contains multiple Git subdirectories (no root `.git/`), BrainBank auto-detects them and indexes all into one shared DB. See [Multi-Repository Indexing](#multi-repository-indexing).

### Watch Mode

Auto-re-index code files when they change. Watches for file changes and re-indexes incrementally:

```bash
brainbank watch                             # Watch repo, auto re-index on save
# ━━━ BrainBank Watch ━━━
#   Watching /path/to/repo for changes...
#   14:30:02 ✓ code: src/api.ts
#   14:30:05 ✓ code: src/routes.ts
#   14:30:08 ✓ csv: data/metrics.csv       ← custom indexer
```

> Watch mode monitors **code files** by default. [Custom indexers](#custom-indexers) that implement `watchPatterns()` and `onFileChange()` are automatically picked up — their name appears in the console output alongside the built-in `code` indexer. Git history and document collections are not affected by file-system changes and must be re-indexed explicitly with `brainbank index` / `brainbank docs`.

### Document Collections

```bash
brainbank collection add <path> --name docs # Register a document folder
brainbank collection list                   # List registered collections
brainbank collection remove <name>          # Remove a collection
```

### Search

```bash
brainbank search <query>                    # Semantic search (vector)
brainbank hsearch <query>                   # Hybrid search (best quality)
brainbank ksearch <query>                   # Keyword search (BM25, instant)
brainbank dsearch <query>                   # Document search
```

### Context

```bash
brainbank context <task>                    # Get formatted context for a task
brainbank context add <col> <path> <desc>   # Add context metadata
brainbank context list                      # List context metadata
```

### KV Store (dynamic collections)

```bash
brainbank kv add <coll> <content>           # Add item to a collection
brainbank kv search <coll> <query>          # Search a collection
brainbank kv list [coll]                    # List collections or items
brainbank kv trim <coll> --keep <n>         # Keep only N most recent
brainbank kv clear <coll>                   # Clear all items
```

### Utility

```bash
brainbank stats                             # Show index statistics
brainbank reembed                           # Re-embed all vectors (provider switch)
brainbank watch                             # Watch files, auto re-index on change
brainbank serve                             # Start MCP server (stdio)
```

**Global options:** `--repo <path>`, `--force`, `--depth <n>`, `--collection <name>`, `--pattern <glob>`, `--context <desc>`, `--reranker <name>`

---

## Programmatic API

Use BrainBank as a library in your TypeScript/Node.js project.

### Indexers

BrainBank uses pluggable indexers. Register only what you need with `.use()`:

| Indexer | Import | Description |
|---------|--------|-------------|
| `code` | `brainbank/code` | Language-aware code chunking (30+ languages) |
| `git` | `brainbank/git` | Git commit history, diffs, co-edit relationships |
| `docs` | `brainbank/docs` | Document collections (markdown, wikis) |

```typescript
import { BrainBank } from 'brainbank';
import { code } from 'brainbank/code';
import { git } from 'brainbank/git';
import { docs } from 'brainbank/docs';

// Pick only the indexers you need
const brain = new BrainBank({ repoPath: '.' })
  .use(code())
  .use(git())
  .use(docs());

// Index code + git (incremental — only processes changes)
await brain.index();

// Index document collections
await brain.addCollection({ name: 'wiki', path: '~/docs', pattern: '**/*.md' });
await brain.indexDocs();
```

### Collections

The universal data primitive for agent memory. Store rich content, search semantically:

```typescript
// ── Conversation Memory ─────────────────────────────
// Store full conversation turns so the agent can recall past sessions
const conversations = brain.collection('conversations');

await conversations.add(
  `User asked to refactor the authentication module from Express middleware ` +
  `to a dedicated AuthService class. We discussed the trade-offs of dependency ` +
  `injection vs singleton pattern. Decided on DI with constructor injection ` +
  `to keep it testable. Implemented in src/auth/auth-service.ts with JWT ` +
  `validation, refresh token rotation, and role-based access control.`,
  { tags: ['auth', 'refactor'], metadata: { session: '2024-03-15' } }
);

// Later: "what did we decide about authentication?"
const hits = await conversations.search('authentication architecture decisions');
// → recalls the full refactoring discussion with context

// ── Architecture Decision Records ───────────────────
// Track design decisions so the agent stays consistent across sessions
const decisions = brain.collection('decisions');

await decisions.add(
  `ADR-012: Use SQLite with WAL mode for the local knowledge store instead of ` +
  `PostgreSQL. Rationale: BrainBank should be portable (single file), work ` +
  `offline, and require zero infrastructure. SQLite WAL mode supports ` +
  `concurrent reads with a single writer, which is sufficient for our ` +
  `use case. Trade-off: no multi-process writes, but BrainBank instances ` +
  `are single-process by design. Alternatives considered: LevelDB (no SQL), ` +
  `DuckDB (heavier, analytics-focused).`,
  { tags: ['architecture', 'storage'] }
);

// "why aren't we using postgres?" → retrieves the full ADR with rationale

// ── Error Investigation Journal ─────────────────────
// Log detailed debugging sessions, not just error messages
const investigations = brain.collection('investigations');

await investigations.add(
  `Investigation: HNSW index returning empty results after reembed. ` +
  `Root cause: the index was initialized with dims=384 but reembed switched ` +
  `to OpenAI (dims=1536). The HNSW index needs to be rebuilt with the new ` +
  `dimensionality — it can't resize in place. Fix: added dimension check in ` +
  `reembed() that rebuilds the HNSW index when dims change. Added regression ` +
  `test in test/unit/core/reembed.test.ts.`,
  { tags: ['bug', 'hnsw', 'resolved'], ttl: '90d' }
);

// "empty search results after switching embedding" → finds exact investigation
```

**Collection management:**

```typescript
const col = brain.collection('any_name');

col.list({ limit: 20 });          // list items (newest first)
col.list({ tags: ['critical'] }); // filter by tags
col.count();                      // total items
col.trim({ keep: 50 });           // keep N most recent
col.prune({ olderThan: '30d' });  // remove older than 30 days
col.remove(id);                   // remove by id
col.clear();                      // remove all

brain.listCollectionNames();      // → ['conversations', 'decisions', ...]
```

### Watch Mode

Auto-re-index when files change:

```typescript
// API
const watcher = brain.watch({
  debounceMs: 2000,
  onIndex: (file, indexer) => console.log(`${indexer}: ${file}`),
  onError: (err) => console.error(err.message),
});

// Later: watcher.close();
```

```bash
# CLI
brainbank watch
# ━━━ BrainBank Watch ━━━
# Watching /path/to/repo for changes...
# 14:30:02 ✓ code: src/api.ts
# 14:30:05 ✓ code: src/routes.ts
```

#### Custom Indexer Watch

Custom indexers can hook into watch mode by implementing `onFileChange` and `watchPatterns`:

```typescript
import type { Indexer, IndexerContext } from 'brainbank';

function csvIndexer(): Indexer {
  let ctx: IndexerContext;

  return {
    name: 'csv',

    async initialize(context) {
      ctx = context;
    },

    // Tell watch which files this indexer cares about
    watchPatterns() {
      return ['**/*.csv', '**/*.tsv'];
    },

    // Called when a watched file changes
    async onFileChange(filePath, event) {
      if (event === 'delete') return true;

      const data = fs.readFileSync(filePath, 'utf-8');
      const col = ctx.collection('csv_data');
      await col.add(data, {
        tags: ['csv'],
        metadata: { file: filePath },
      });
      return true; // handled
    },
  };
}

const brain = new BrainBank({ dbPath: './brain.db' })
  .use(code())
  .use(csvIndexer());

await brain.initialize();
brain.watch(); // Now watches .ts, .py, etc. AND .csv, .tsv
```

### Search

Three modes, from fastest to best quality:

| Mode | Method | Speed | Quality |
|------|--------|-------|---------|
| Keyword | `searchBM25(q)` | ⚡ instant | Good for exact terms |
| Vector | `search(q)` | ~50ms | Good for concepts |
| **Hybrid** | `hybridSearch(q)` | ~100ms | **Best — catches both** |

```typescript
// Hybrid search (recommended default)
const results = await brain.hybridSearch('authentication middleware');

// Scoped search
const codeHits = await brain.searchCode('parse JSON config', 8);
const commitHits = await brain.searchCommits('fix auth bug', 5);
const docHits = await brain.searchDocs('getting started', { collection: 'wiki' });
```

| Score | Meaning |
|-------|---------|
| 0.8+ | Near-exact match |
| 0.5–0.8 | Strongly related |
| 0.3–0.5 | Somewhat related |
| < 0.3 | Weak match |

### Document Collections

Register folders of documents. Files are chunked by heading structure:

```typescript
await brain.addCollection({
  name: 'docs',
  path: '~/project/docs',
  pattern: '**/*.md',
  ignore: ['**/drafts/**'],
  context: 'Project documentation',
});

await brain.indexDocs();

// Add context metadata (helps LLM understand what documents are about)
brain.addContext('docs', '/api', 'REST API reference');
brain.addContext('docs', '/guides', 'Step-by-step tutorials');
```

### Context Generation

Get formatted markdown ready for system prompt injection:

```typescript
const context = await brain.getContext('add rate limiting to the API', {
  codeResults: 6,
  gitResults: 5,
  affectedFiles: ['src/api/routes.ts'],
  useMMR: true,
});
// Returns: ## Relevant Code, ## Git History, ## Relevant Documents
```

### Custom Indexers

Implement the `Indexer` interface to build your own:

```typescript
import type { Indexer, IndexerContext } from 'brainbank';

const myIndexer: Indexer = {
  name: 'custom',
  async initialize(ctx: IndexerContext) {
    // ctx.db            — shared SQLite database
    // ctx.embedding     — shared embedding provider
    // ctx.collection()  — create dynamic collections
    const store = ctx.collection('my_data');
    await store.add('indexed content', { source: 'custom' });
  },
};

brain.use(myIndexer);
```

#### Using custom indexers with the CLI

Drop `.ts` files into `.brainbank/indexers/` — the CLI auto-discovers them:

```
.brainbank/
├── brainbank.db
└── indexers/
    ├── slack.ts
    └── jira.ts
```

Each file exports a default `Indexer`:

```typescript
// .brainbank/indexers/slack.ts
import type { Indexer } from 'brainbank';

export default {
  name: 'slack',
  async initialize(ctx) {
    const msgs = ctx.collection('slack_messages');
    // ... fetch and index slack messages
  },
} satisfies Indexer;
```

That's it — all CLI commands automatically pick up your indexers:

```bash
brainbank index                             # runs code + git + docs + slack + jira
brainbank stats                             # shows all indexers
brainbank kv search slack_messages "deploy"  # search slack data
```

#### Advanced: config file

For fine-grained control, create a `.brainbank/config.ts`:

```typescript
// .brainbank/config.ts
export default {
  builtins: ['code', 'docs'],   // exclude git (default: all three)
  brainbank: {                   // BrainBank constructor options
    dbPath: '.brainbank/brain.db',
  },
};
```

Everything lives in `.brainbank/` — DB, config, and custom indexers:

```
.brainbank/
├── brainbank.db        # SQLite database (auto-created)
├── config.ts           # Optional project config
└── indexers/           # Optional custom indexer files
    ├── slack.ts
    └── jira.ts
```

No folder and no config file? The CLI uses the built-in indexers (`code`, `git`, `docs`).

---

## MCP Server

BrainBank ships with an MCP server (stdio) for AI tool integration.

```bash
brainbank serve
```

### Antigravity / Claude Desktop

Add to your MCP config (`~/.gemini/antigravity/mcp_config.json` or Claude Desktop settings):

```json
{
  "mcpServers": {
    "brainbank": {
      "command": "npx",
      "args": ["-y", "@brainbank/mcp"],
      "env": {
        "BRAINBANK_EMBEDDING": "openai"
      }
    }
  }
}
```

The agent passes the `repo` parameter on each tool call based on the active workspace — no hardcoded paths needed.

> Set `BRAINBANK_EMBEDDING` to `openai` for higher quality search (requires `OPENAI_API_KEY`). Omit to use the free local WASM embeddings.

> Optionally set `BRAINBANK_REPO` as a default fallback repo. If omitted, every tool call must include the `repo` parameter (recommended for multi-workspace setups).

### Available Tools

| Tool | Description |
|------|-------------|
| `brainbank_hybrid_search` | Best quality: vector + BM25 + reranker |
| `brainbank_search` | Semantic vector search |
| `brainbank_keyword_search` | Instant BM25 full-text |
| `brainbank_context` | Formatted context for a task |
| `brainbank_index` | Trigger code/git indexing |
| `brainbank_stats` | Index statistics |
| `brainbank_history` | Git history for a file |
| `brainbank_coedits` | Files that change together |
| `brainbank_collection_add` | Add item to a KV collection |
| `brainbank_collection_search` | Search a KV collection |
| `brainbank_collection_trim` | Trim a KV collection |

---

## Configuration

```typescript
import { BrainBank, OpenAIEmbedding } from 'brainbank';
import { Qwen3Reranker } from '@brainbank/reranker';  // separate package

const brain = new BrainBank({
  repoPath: '.',
  dbPath: '.brainbank/brainbank.db',
  gitDepth: 500,
  maxFileSize: 512_000,
  embeddingDims: 1536,
  maxElements: 2_000_000,
  embeddingProvider: new OpenAIEmbedding(),   // or: omit for free local WASM (384d)
  reranker: new Qwen3Reranker(),              // local cross-encoder (auto-downloads ~640MB)
});
```

### Embedding Providers

| Provider | Import | Dims | Speed | Cost |
|----------|--------|------|-------|------|
| **Local (default)** | built-in | 384 | ⚡ 0ms | Free |
| **OpenAI** | `OpenAIEmbedding` | 1536 | ~100ms | $0.02/1M tokens |

```typescript
import { OpenAIEmbedding } from 'brainbank';

// Uses OPENAI_API_KEY env var by default
new OpenAIEmbedding();

// Custom options
new OpenAIEmbedding({
  model: 'text-embedding-3-large',
  dims: 512,                          // custom dims (text-embedding-3 only)
  apiKey: 'sk-...',
  baseUrl: 'https://my-proxy.com/v1/embeddings',  // Azure, proxies
});
```

> ⚠️ Switching embedding provider requires re-indexing — vectors are not cross-compatible.

### Reranker

BrainBank includes an optional cross-encoder reranker using **Qwen3-Reranker-0.6B** via `node-llama-cpp`. It runs 100% locally — no API keys needed. The reranker is **disabled by default**.

#### When to Use It

The reranker runs local neural inference on every search result, which improves ranking precision but adds significant latency. Here are real benchmarks on a ~2100 file / 4000+ chunk codebase:

| Metric | Without Reranker | With Reranker |
|--------|-----------------|---------------|
| **Warm query time** | ~480ms | ~5500ms |
| **Cold start** | ~7s | ~12s |
| **Memory overhead** | — | +640MB (model) |
| **Ranking quality** | Good (RRF) | Slightly better |

**Recommended:** Leave it disabled for interactive use (MCP, IDE integrations). The RRF fusion of vector + BM25 already produces high-quality results. Enable it only for:

- Batch processing where latency doesn't matter
- Very large codebases (50k+ files) where false positives are costly
- Server environments with RAM to spare

#### Enabling the Reranker

```typescript
import { BrainBank } from 'brainbank';
import { Qwen3Reranker } from '@brainbank/reranker';

const brain = new BrainBank({
  reranker: new Qwen3Reranker(),  // ~640MB model, auto-downloaded on first use
});
```

Or from the CLI:

```bash
brainbank hsearch "auth middleware" --reranker qwen3
```

Or via environment variable:

```bash
BRAINBANK_RERANKER=qwen3 brainbank serve
```

The model is cached at `~/.cache/brainbank/models/` after first download.

#### Position-Aware Score Blending

When enabled, the reranker uses position-aware blending — trusting retrieval scores more for top results and the reranker more for lower-ranked results:

| Position | Retrieval (RRF) | Reranker | Rationale |
|----------|----------------|----------|----------|
| 1–3 | **75%** | 25% | Preserves exact keyword matches |
| 4–10 | **60%** | 40% | Balanced blend |
| 11+ | 40% | **60%** | Trust reranker for uncertain results |

#### Custom Reranker

Implement the `Reranker` interface to use your own:

```typescript
import type { Reranker } from 'brainbank';

const myReranker: Reranker = {
  async rank(query: string, documents: string[]): Promise<number[]> {
    // Return relevance scores 0.0-1.0 for each document
  },
  async close() { /* optional cleanup */ },
};
```

Without a reranker, BrainBank uses pure RRF fusion — which is already production-quality for most use cases.

### Environment Variables

| Variable | Description |
|----------|-------------|
| `BRAINBANK_REPO` | Default repository path (optional — auto-detected from `.git/` or passed per tool call) |
| `BRAINBANK_EMBEDDING` | Embedding provider: `local` (default), `openai` |
| `BRAINBANK_RERANKER` | Reranker: `none` (default), `qwen3` to enable |
| `BRAINBANK_DEBUG` | Show full stack traces |
| `OPENAI_API_KEY` | Required when using `BRAINBANK_EMBEDDING=openai` |

---

## Multi-Repository Indexing

BrainBank can index multiple repositories into a **single shared database**. This is useful for monorepos, microservices, or any project split across multiple Git repositories.

### How It Works

When you point BrainBank at a directory that contains multiple Git repositories (subdirectories with `.git/`), the CLI **auto-detects** them and creates namespaced indexers:

```bash
~/aurora/
├── servicehub-frontend/   # .git/
├── servicehub-backend/    # .git/
└── servicehub-orchestrator/ # .git/
```

```bash
brainbank index ~/aurora --depth 200
```

```
━━━ BrainBank Index ━━━
  Repo: /Users/you/aurora
  Multi-repo: found 3 git repos: servicehub-frontend, servicehub-backend, servicehub-orchestrator
  CODE:SERVICEHUB-BACKEND [0/1075] ...
  CODE:SERVICEHUB-FRONTEND [0/719] ...
  GIT:SERVICEHUB-ORCHESTRATOR [0/200] ...

  Code: 2107 indexed, 4084 chunks
  Git:  600 indexed (200 per repo)
  Co-edit pairs: 1636
```

All code, git history, and co-edit relationships from every sub-repository go into **one** `.brainbank/brainbank.db` at the parent directory. Search queries automatically return results across all repositories:

```bash
brainbank hsearch "cancel job confirmation dialog" --repo ~/aurora
# → Results from frontend Vue components, backend NestJS controllers,
#   and orchestrator test scenarios — all in one search.
```

### Namespaced Indexers

Each sub-repository gets its own namespaced indexer instances (e.g., `code:frontend`, `git:backend`). Same-type indexers share a single HNSW vector index for efficient memory usage and unified search.

### Programmatic API

```typescript
import { BrainBank } from 'brainbank';
import { code } from 'brainbank/code';
import { git } from 'brainbank/git';

const brain = new BrainBank({ repoPath: '~/aurora' })
  .use(code({ name: 'code:frontend', repoPath: '~/aurora/frontend' }))
  .use(code({ name: 'code:backend', repoPath: '~/aurora/backend' }))
  .use(git({ name: 'git:frontend', repoPath: '~/aurora/frontend' }))
  .use(git({ name: 'git:backend', repoPath: '~/aurora/backend' }));

await brain.initialize();
await brain.index();

// Cross-repo search
const results = await brain.hybridSearch('authentication guard');
// → Results from both frontend and backend
```

### MCP Multi-Workspace

The MCP server maintains a pool of BrainBank instances — one per unique `repo` path. Each tool call can target a different workspace:

```typescript
// Agent working in frontend workspace
brainbank_hybrid_search({ query: "login form", repo: "/Users/you/aurora" })

// Agent switches to a different project
brainbank_hybrid_search({ query: "API routes", repo: "/Users/you/other-project" })
```

Instances are cached in memory after first initialization, so subsequent queries to the same repo are fast (~480ms).

---

## Indexing

### Incremental Indexing

All indexing is **incremental by default** — only new or changed content is processed:

| Indexer | How it detects changes | What gets skipped |
|---------|----------------------|-------------------|
| **Code** | FNV-1a hash of file content | Unchanged files |
| **Git** | Unique commit hash | Already-indexed commits |
| **Docs** | SHA-256 of file content | Unchanged documents |

```typescript
// First run: indexes everything
await brain.index();  // → { indexed: 500, skipped: 0 }

// Second run: skips everything unchanged
await brain.index();  // → { indexed: 0, skipped: 500 }

// Changed 1 file? Only that file re-indexes
await brain.index();  // → { indexed: 1, skipped: 499 }
```

Use `--force` to re-index everything:

```bash
brainbank index --force
```

### Re-embedding

When switching embedding providers (e.g. Local → OpenAI), you **don't need to re-index**. The `reembed()` method regenerates only the vectors — no file I/O, no git parsing, no re-chunking:

```typescript
import { BrainBank, OpenAIEmbedding } from 'brainbank';

// Previously indexed with local embeddings.
// Now switch to OpenAI:
const brain = new BrainBank({
  embeddingProvider: new OpenAIEmbedding(),
});
await brain.initialize();

// ⚠ BrainBank emits 'warning' event if provider changed.
brain.on('warning', (w) => console.warn(w.message));
// → "Embedding provider changed (LocalEmbedding/384 → OpenAIEmbedding/1536). Run brain.reembed()"

const result = await brain.reembed({
  onProgress: (table, current, total) => {
    console.log(`${table}: ${current}/${total}`);
  },
});
// → { code: 1200, git: 500, docs: 80, kv: 45, notes: 12, total: 1837 }
```

Or from the CLI:

```bash
brainbank reembed
```

| Full re-index | `reembed()` |
|---|---|
| Walks all files | **Skipped** |
| Parses git history | **Skipped** |
| Re-chunks documents | **Skipped** |
| Embeds text | ✓ |
| Replaces vectors | ✓ |
| Rebuilds HNSW | ✓ |

> BrainBank tracks provider metadata in `embedding_meta` table. It auto-detects mismatches and warns you to run `reembed()`.

---

## Architecture

<details>
<summary>Text version</summary>

```
┌──────────────────────────────────────────────────────┐
│                   BrainBank Core                     │
│  .use(code)  .use(git)  .use(docs)                   │
│  .collection('name')                                 │
├──────────────────────────────────────────────────────┤
│                                                      │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌────────────┐│
│  │  Code   │ │   Git   │ │  Docs   │ │ Collection ││
│  │ Indexer │ │ Indexer │ │ Indexer │ │ (dynamic)  ││
│  └────┬────┘ └────┬────┘ └────┬────┘ └─────┬──────┘│
│       │           │           │             │        │
│  ┌────▼────┐ ┌────▼────┐ ┌────▼────┐ ┌─────▼──────┐│
│  │  HNSW   │ │  HNSW   │ │  HNSW   │ │ Shared KV  ││
│  │  Index  │ │  Index  │ │  Index  │ │ HNSW Index ││
│  └─────────┘ └─────────┘ └─────────┘ └────────────┘│
│                                                      │
│  ┌──────────────────────────────────────────────────┐│
│  │         SQLite (.brainbank/brainbank.db)         ││
│  │  code_chunks │ git_commits │ doc_chunks          ││
│  │  kv_data │ FTS5 full-text │ vectors │ co_edits   ││
│  └──────────────────────────────────────────────────┘│
│                                                      │
│  ┌──────────────────────────────────────────────────┐│
│  │  Embedding (Local WASM 384d │ OpenAI 1536d)      ││
│  └──────────────────────────────────────────────────┘│
│  ┌──────────────────────────────────────────────────┐│
│  │  Qwen3-Reranker (opt-in cross-encoder)            ││
│  └──────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────┘
```
</details>

### Search Pipeline

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
Qwen3-Reranker (yes/no + logprobs → score 0-1)
  │
  ▼
Position-Aware Blend
  Top 1-3:  75% RRF / 25% reranker
  Top 4-10: 60% RRF / 40% reranker
  Top 11+:  40% RRF / 60% reranker
  │
  ▼
Final results (sorted by blended score)
```

### Data Flow

1. **Index** — Indexers parse files into chunks
2. **Embed** — Each chunk gets a vector (local WASM or OpenAI)
3. **Store** — Chunks + vectors → SQLite, vectors → HNSW index
4. **Search** — Query → HNSW k-NN + BM25 keyword → RRF fusion → optional reranker
5. **Context** — Top results formatted as markdown for system prompts

---

## Testing

```bash
npm test                    # Unit tests (129 tests)
npm test -- --integration   # Full suite (211 tests, includes real models + all domains)
npm test -- --filter code   # Filter by test name
npm test -- --verbose       # Show assertion details
```

### Test Structure

```
test/
├── helpers.ts                      # Shared imports, mockEmbedding(), tmpDb()
├── run.ts                          # Custom test runner (recursive discovery)
├── unit/
│   ├── core/
│   │   ├── brainbank.test.ts       # Orchestrator & .use() pattern
│   │   ├── collection.test.ts      # Dynamic KV collections
│   │   ├── config.test.ts          # Configuration resolution
│   │   ├── reembed.test.ts         # Re-embedding engine
│   │   ├── schema.test.ts          # SQLite schema & migrations
│   │   ├── tags-ttl.test.ts        # Tags, TTL & schema columns
│   │   └── watch.test.ts           # Watch mode & custom indexer routing
│   ├── embeddings/
│   │   ├── math.test.ts            # Cosine similarity, normalize, distance
│   │   └── openai-embedding.test.ts # OpenAI embedding provider
│   ├── indexers/
│   │   ├── chunker.test.ts         # Language-aware code chunking
│   │   └── languages.test.ts       # Language registry
│   ├── memory/
│   │   └── notes.test.ts           # Note memory store
│   ├── query/
│   │   ├── bm25.test.ts            # BM25 full-text search
│   │   ├── reranker.test.ts        # Pluggable reranker integration (mock)
│   │   └── rrf.test.ts             # Reciprocal Rank Fusion
│   └── vector/
│       ├── hnsw.test.ts            # HNSW vector index
│       └── mmr.test.ts             # Maximal Marginal Relevance
└── integration/
    ├── code.test.ts                # Code indexer end-to-end
    ├── git.test.ts                 # Git indexer end-to-end
    ├── docs.test.ts                # Docs indexer end-to-end
    ├── memory.test.ts              # Memory lifecycle
    ├── collections.test.ts         # KV collections end-to-end
    ├── search.test.ts              # Unified search & getContext
    └── real-model.test.ts          # Real MiniLM embedding

packages/reranker/test/
└── integration/
    └── reranker.test.ts            # Qwen3 real model: ranking, dedup, pipeline
```

All test files import from `test/helpers.ts` which centralizes shared modules and provides:

- **`mockEmbedding(dims?)`** — Deterministic mock embedding provider
- **`tmpDb(label)`** — Generates unique temp database paths

---

## License

MIT

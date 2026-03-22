# 🧠 BrainBank

**Semantic knowledge bank for AI agents** — indexes code, documents, and git history into a single SQLite file with hybrid search (vector + BM25 + RRF).

BrainBank gives LLMs a searchable long-term memory that persists between sessions.

- **Pluggable indexers** — `.use()` only what you need (code, git, docs)
- **Dynamic collections** — `brain.collection('errors')` for any structured data
- **Pluggable embeddings** — local WASM (free) or OpenAI (higher quality)
- **Optional reranker** — pluggable cross-encoder re-ranking for search
- **Portable** — single `.brainbank/brainbank.db` file
- **Hybrid search** — vector + BM25 fused with Reciprocal Rank Fusion

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
  - [Reranker](#reranker-optional)
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

---

## CLI

BrainBank can be used entirely from the command line — no config file needed.

### Indexing

```bash
brainbank index [path]                      # Index code + git history
brainbank docs [--collection <name>]        # Index document collections
```

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
brainbank serve                             # Start MCP server (stdio)
```

**Global options:** `--repo <path>`, `--force`, `--depth <n>`, `--collection <name>`, `--pattern <glob>`, `--context <desc>`

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

The universal data primitive. Store anything, search semantically:

```typescript
const errors = brain.collection('debug_errors');

// Add items (auto-embedded for vector search)
await errors.add('Null pointer in api.ts line 42', { metadata: { file: 'api.ts' } });
await errors.add('Timeout on /users endpoint', { metadata: { file: 'routes.ts' } });

// Add with tags
await errors.add('Auth token expired', {
  tags: ['critical', 'auth'],
  metadata: { file: 'auth.ts' },
});

// Add with TTL (auto-expires after 7 days)
await errors.add('Transient network error', {
  tags: ['warning', 'network'],
  ttl: '7d',
});

// Search (hybrid: vector + keyword by default)
const hits = await errors.search('null pointer', { k: 5 });
// → [{ content: 'Null pointer in api.ts...', score: 0.92, tags: [], ... }]

// Search with tag filter (items must have ALL specified tags)
const critical = await errors.search('error', { tags: ['critical'] });
const critAuth = await errors.search('error', { tags: ['critical', 'auth'] });

// List with tag filter
errors.list({ tags: ['critical'] });

// Manage
errors.list({ limit: 20 });       // list items (newest first)
errors.count();                   // total items
errors.trim({ keep: 50 });        // keep N most recent
errors.prune({ olderThan: '7d' });// remove older than 7 days
errors.remove(id);                // remove by id
errors.clear();                   // remove all

// List all collection names
brain.listCollectionNames();      // → ['debug_errors', 'decisions', ...]
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

For fine-grained control, create a `brainbank.config.ts` in your project root:

```typescript
// brainbank.config.ts
export default {
  builtins: ['code', 'docs'],   // exclude git (default: all three)
  brainbank: {                   // BrainBank constructor options
    dbPath: '.data/brain.db',
  },
};
```

No folder and no config file? The CLI uses the built-in indexers (`code`, `git`, `docs`).

---

## MCP Server

BrainBank ships with an MCP server (stdio) for AI tool integration:

```bash
brainbank serve
```

```json
{
  "mcpServers": {
    "brainbank": {
      "command": "npx",
      "args": ["brainbank", "serve"],
      "env": { "BRAINBANK_REPO": "/path/to/repo" }
    }
  }
}
```

| Tool | Description |
|------|-------------|
| `brainbank_hybrid_search` | Best quality: vector + BM25 fused |
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

const brain = new BrainBank({
  repoPath: '.',
  dbPath: '.brainbank/brainbank.db',
  gitDepth: 500,
  maxFileSize: 512_000,
  embeddingDims: 384,
  maxElements: 2_000_000,
  embeddingProvider: new OpenAIEmbedding(),  // or: default local WASM
  reranker: myReranker,                       // optional, improves search quality
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

### Reranker (optional)

Improves search quality by using a cross-encoder to evaluate each result against the query. Applied after RRF fusion (60% RRF + 40% reranker score):

```typescript
import type { Reranker } from 'brainbank';

const myReranker: Reranker = {
  async rank(query: string, documents: string[]): Promise<number[]> {
    // Return relevance scores 0.0-1.0 for each document
    // Example: call an LLM, use a cross-encoder model, etc.
  },
};

const brain = new BrainBank({ reranker: myReranker });
```

Without a reranker, BrainBank uses pure RRF fusion (still good quality).

| Env Variable | Description |
|-------------|-------------|
| `BRAINBANK_REPO` | Repository path (default: cwd) |
| `BRAINBANK_DB` | Database path |
| `BRAINBANK_DEBUG` | Show full stack traces |
| `OPENAI_API_KEY` | Required when using `OpenAIEmbedding` provider |

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
│  │  Reranker (optional, pluggable cross-encoder)    ││
│  └──────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────┘
```

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
Reranker (optional, 60% RRF + 40% reranker)
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
npm test -- --integration   # Full suite (157 tests, includes real model)
npm test -- --filter bm25   # Filter by test name
npm test -- --verbose       # Show assertion details
```

### Test Structure

```
test/
├── helpers.ts              # Shared imports, mockEmbedding(), tmpDb()
├── run.ts                  # Custom test runner
└── unit/
    ├── bm25.test.ts        # BM25 full-text search
    ├── brainbank.test.ts   # Orchestrator & .use() pattern
    ├── chunker.test.ts     # Language-aware code chunking
    ├── collection.test.ts  # Dynamic KV collections
    ├── config.test.ts      # Configuration resolution
    ├── hnsw.test.ts        # HNSW vector index
    ├── languages.test.ts   # Language registry
    ├── math.test.ts        # Cosine similarity, normalize, distance
    ├── mmr.test.ts         # Maximal Marginal Relevance
    ├── notes.test.ts       # Note memory store
    ├── openai-embedding.test.ts  # OpenAI embedding provider
    ├── reembed.test.ts     # Re-embedding engine
    ├── reranker.test.ts    # Pluggable reranker integration
    ├── rrf.test.ts         # Reciprocal Rank Fusion
    ├── schema.test.ts      # SQLite schema & migrations
    ├── tags-ttl.test.ts    # Tags, TTL & schema columns
    └── watch.test.ts       # Watch mode & custom indexer routing
└── integration/
    ├── pipeline.test.ts    # Full pipeline: search, tags, TTL, watch
    └── real-model.test.ts  # Real MiniLM embedding + cross-encoder reranker
```

All test files import from `test/helpers.ts` which centralizes shared modules and provides:

- **`mockEmbedding(dims?)`** — Deterministic mock embedding provider
- **`tmpDb(label)`** — Generates unique temp database paths

---

## License

MIT

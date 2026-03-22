# 🧠 BrainBank

**Semantic knowledge bank for AI agents** — indexes code, documents, and git history into a single SQLite file with hybrid search (vector + BM25 + RRF).

BrainBank gives LLMs a searchable long-term memory that persists between sessions.

- **Pluggable indexers** — `.use()` only what you need (code, git, docs)
- **Dynamic collections** — `brain.collection('errors')` for any structured data
- **Local embeddings** — WASM-based, no API keys needed
- **Portable** — single `.brainbank/brainbank.db` file
- **Hybrid search** — vector + BM25 fused with Reciprocal Rank Fusion

---

## Quick Start

```bash
npm install brainbank
```

```typescript
import { BrainBank } from 'brainbank';
import { code } from 'brainbank/code';
import { git } from 'brainbank/git';

const brain = new BrainBank({ repoPath: '.' })
  .use(code())
  .use(git());

await brain.index();
const context = await brain.getContext('add rate limiting');
```

---

## CLI

```bash
# Indexing
brainbank index [path]                      # Index code + git
brainbank collection add <path> --name docs # Add document collection
brainbank collection list                   # List collections
brainbank collection remove <name>          # Remove collection
brainbank docs [--collection <name>]        # Index documents

# Search
brainbank search <query>                    # Semantic search (vector)
brainbank hsearch <query>                   # Hybrid search (best quality)
brainbank ksearch <query>                   # Keyword search (BM25, instant)
brainbank dsearch <query>                   # Document search

# Context
brainbank context <task>                    # Get formatted context
brainbank context add <col> <path> <desc>   # Add context metadata
brainbank context list                      # List context metadata

# KV Store (dynamic collections)
brainbank kv add <coll> <content>           # Add item to a collection
brainbank kv search <coll> <query>          # Search a collection
brainbank kv list [coll]                    # List collections or items
brainbank kv trim <coll> --keep <n>         # Keep only N most recent
brainbank kv clear <coll>                   # Clear all items

# Utility
brainbank stats                             # Index statistics
brainbank serve                             # Start MCP server (stdio)
```

**Options:** `--repo <path>`, `--force`, `--depth <n>`, `--collection <name>`, `--pattern <glob>`, `--context <desc>`

---

## Indexers

BrainBank uses pluggable indexers. Register only what you need:

| Indexer | Import | What it does |
|---------|--------|--------------|
| `code` | `brainbank/code` | Language-aware code chunking (30+ languages), HNSW index |
| `git` | `brainbank/git` | Git commit history, diffs, co-edit relationships |
| `docs` | `brainbank/docs` | Document collections (markdown, wikis), heading-aware chunking |

### Custom indexers

Implement the `Indexer` interface to create your own:

```typescript
import type { Indexer, IndexerContext } from 'brainbank';

const myIndexer: Indexer = {
  name: 'custom',
  async initialize(ctx: IndexerContext) {
    // ctx.db        — shared SQLite database
    // ctx.embedding — shared embedding provider
    // ctx.collection('name') — create dynamic collections
    const store = ctx.collection('my_data');
    await store.add('indexed content', { source: 'custom' });
  },
};

brain.use(myIndexer);
```

---

## Collections

The universal data primitive. Any indexer or consumer can create collections on the fly:

```typescript
const coll = brain.collection('decisions');

// Add items (auto-embedded for vector search)
const id = await coll.add('Use JWT over sessions', { context: 'auth' });
await coll.addMany([
  { content: 'Redis for token blacklist', metadata: {} },
  { content: 'Rate limit at 100 req/min', metadata: {} },
]);

// Search (hybrid: vector + keyword)
const results = await coll.search('authentication tokens', {
  k: 5,
  mode: 'hybrid',      // 'hybrid' | 'vector' | 'keyword'
  minScore: 0.3,
});

// Manage
coll.list({ limit: 20 });      // list items
coll.count();                    // total items
coll.trim({ keep: 50 });        // keep N most recent
coll.prune('7d');                // remove older than 7 days
coll.remove(id);                 // remove specific item
coll.clear();                    // remove all

// List all collections
brain.listCollectionNames();     // → ['decisions', 'errors', ...]
```

---

## Search

Three modes, from fastest to best quality:

| Mode | Method | Speed | Quality |
|------|--------|-------|---------|
| Keyword | `searchBM25(q)` | ⚡ instant | Good for exact terms |
| Vector | `search(q)` | ~50ms | Good for concepts |
| Hybrid | `hybridSearch(q)` | ~100ms | **Best** — catches both |

```typescript
// Hybrid search (recommended)
const results = await brain.hybridSearch('authentication middleware');

// Vector search with options
const results = await brain.search('JWT validation', {
  codeK: 10,
  gitK: 5,
  useMMR: true,  // diversity via Maximal Marginal Relevance
});

// Code-only or commit-only
const codeHits = await brain.searchCode('parse JSON config', 8);
const commitHits = await brain.searchCommits('fix auth bug', 5);
```

| Score | Meaning |
|-------|---------|
| 0.8+ | Near-exact match |
| 0.5–0.8 | Strongly related |
| 0.3–0.5 | Somewhat related |
| < 0.3 | Weak match |

---

## Document Collections

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

const results = await brain.searchDocs('authentication', { collection: 'docs', k: 5 });

// Context metadata (helps LLM understand what documents are about)
brain.addContext('docs', '/api', 'REST API reference');
brain.addContext('docs', '/guides', 'Step-by-step tutorials');
```

---

## Context Generation

```typescript
const context = await brain.getContext('add rate limiting to the API', {
  codeResults: 6,
  gitResults: 5,
  affectedFiles: ['src/api/routes.ts'],
  useMMR: true,
});
// Returns markdown: ## Relevant Code, ## Git History, ## Relevant Documents
```

---

## MCP Server

BrainBank ships with an MCP server (stdio transport) for AI tool integration:

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
| `brainbank_search` | Semantic vector search |
| `brainbank_hybrid_search` | Best quality: vector + BM25 fused |
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
const brain = new BrainBank({
  repoPath: '.',
  dbPath: '.brainbank/brainbank.db',
  gitDepth: 500,
  maxFileSize: 512_000,
  maxDiffBytes: 8192,
  embeddingDims: 384,
  maxElements: 2_000_000,
  hnswM: 16,
  hnswEfConstruction: 200,
  hnswEfSearch: 50,
  embeddingProvider: customProvider,  // default: local WASM
});
```

| Env Variable | Description |
|-------------|-------------|
| `BRAINBANK_REPO` | Repository path (default: cwd) |
| `BRAINBANK_DB` | Database path |
| `BRAINBANK_DEBUG` | Show full stack traces |

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
│  │    Local Embedding (WASM, 384-dim, ≈0ms/query)   ││
│  └──────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────┘
```

### Data Flow

1. **Index** — Code/Git/Doc indexers parse files into chunks
2. **Embed** — Each chunk gets a 384-dim vector (local WASM)
3. **Store** — Chunks + vectors → SQLite, vectors → HNSW index
4. **Search** — Query vector → HNSW k-NN + BM25 keyword → RRF fusion
5. **Context** — Top results formatted as markdown for system prompts

### Storage Schema

| Table | What it stores |
|-------|---------------|
| `code_chunks` / `code_vectors` | Source code chunks and embeddings |
| `git_commits` / `git_vectors` | Commit metadata, diffs, embeddings |
| `commit_files` / `co_edits` | Files per commit, co-edit relationships |
| `doc_chunks` / `doc_vectors` | Document chunks and embeddings |
| `collections` / `path_contexts` | Registered doc collections, context metadata |
| `kv_data` / `kv_vectors` / `fts_kv` | Dynamic collection items, embeddings, FTS |

---

## Project Structure

```
brainbank/
├── src/
│   ├── core/
│   │   ├── brainbank.ts       # Main orchestrator (.use() builder)
│   │   ├── collection.ts      # Dynamic collection primitive
│   │   ├── config.ts          # Config defaults + resolver
│   │   └── schema.ts          # SQLite schema
│   ├── modules/
│   │   ├── types.ts           # Indexer / IndexerContext interfaces
│   │   ├── code.ts            # Code indexer
│   │   ├── git.ts             # Git history indexer
│   │   └── docs.ts            # Document collections indexer
│   ├── embeddings/            # Local WASM embedding provider
│   ├── indexers/              # Code chunker, git parser, doc parser
│   ├── memory/                # Pattern store, consolidator, note store
│   ├── query/                 # UnifiedSearch, BM25, RRF, context builder
│   ├── storage/               # SQLite database wrapper
│   ├── vector/                # HNSW index + MMR
│   ├── integrations/          # CLI, MCP server
│   └── index.ts               # Public API barrel
├── test/
│   └── unit/                  # 96 unit tests
└── package.json
```

---

## License

MIT

# 🧠 BrainBank

**Persistent, searchable memory for AI agents.** Index your codebase, git history, documents, and any custom data into a single SQLite file — then search it all with hybrid vector + keyword retrieval.

BrainBank gives LLMs a long-term memory that persists between sessions.

- **All-in-one** — core + all plugins + CLI in a single `npm i -g brainbank`
- **Pluggable plugins** — `.use()` only what you need (code, git, docs, or custom)
- **Dynamic collections** — `brain.collection('errors')` for any structured data
- **Hybrid search** — vector + BM25 fused with Reciprocal Rank Fusion
- **Pluggable embeddings** — local WASM (free), OpenAI, or Perplexity (standard & contextualized)
- **Multi-repo** — index multiple repositories into one shared database
- **Portable** — single `.brainbank/brainbank.db` file
- **Optional reranker** — Qwen3-0.6B cross-encoder via `Qwen3Reranker` (opt-in)
- **Modular packages** — each plugin also published as a standalone `@brainbank/*` package
  - [`@brainbank/code`](#packages) — AST chunking, import graph, symbols. Bundles JS/TS/HTML/Python grammars; add more with `npm i -g tree-sitter-<lang>`
  - [`@brainbank/git`](#packages) — commit search, co-edit analysis
  - [`@brainbank/docs`](#packages) — document collection search
  - [`@brainbank/memory`](#memory) — fact extraction + entity graph
  - [`@brainbank/mcp`](#mcp-server) — MCP server for AI tools

![BrainBank Architecture](assets/architecture.png)

---

## Why BrainBank?

BrainBank is a **code-aware knowledge engine** — not just a memory layer. It parses your codebase with tree-sitter ASTs, builds a **code graph** (imports, symbols, call references), indexes git history and co-edit patterns, and makes everything searchable with hybrid vector + keyword retrieval. Optional packages add conversational memory (`@brainbank/memory`) and MCP integration (`@brainbank/mcp`).

| | **BrainBank** | **QMD** | **mem0 / Zep** | **LangChain** |
|---|:---:|:---:|:---:|:---:|
| Code-aware (AST) | **20 languages** (tree-sitter) | ✗ | ✗ | ✗ |
| Code graph | **imports + symbols + calls** | ✗ | ✗ | ✗ |
| Git + co-edits | ✓ | ✗ | ✗ | ✗ |
| Search | **Vector + BM25 + RRF** | Vector + reranker | Vector + graph | Vector only |
| Infra | **SQLite file** | Local GGUF | Vector DB + cloud | Vector DB |
| Plugins | **`.use()` builder** | ✗ | ✗ | ✗ |
| Memory | **`@brainbank/memory`** (opt-in) | ✗ | **Core feature** | ✗ |

### Table of Contents

- [Why BrainBank?](#why-brainbank)
- [Installation](#installation)
- [Packages](#packages)
- [Quick Start](#quick-start)
- [CLI](#cli)
- [Programmatic API](#programmatic-api)
  - [Plugins](#plugins)
  - [Collections](#collections)
  - [Search](#search)
    - [How Search Works](#how-search-works)
  - [Document Collections](#document-collections)
  - [Context Generation](#context-generation)
  - [Building Custom Plugins](#building-custom-plugins)
  - [Developing a Plugin Package](#developing-a-plugin-package)
  - [AI Agent Integration](#ai-agent-integration)
  - [Examples](#examples)
  - [Watch Mode](#watch-mode)
- [MCP Server](#mcp-server)
- [Project Config](#project-config)
- [Configuration](#configuration)
  - [Embedding Providers](#embedding-providers)
  - [Reranker](#reranker)
- [Memory](#memory)
- [Multi-Repository Indexing](#multi-repository-indexing)
- [Indexing](#indexing-1)
  - [Code Chunking](#code-chunking-tree-sitter)
  - [Code Graph](#code-graph)
  - [Incremental Indexing](#incremental-indexing)
  - [Re-embedding](#re-embedding)
- [Architecture](#architecture)
  - [Search Pipeline](#search-pipeline)
- [Benchmarks](#benchmarks)

---

## Installation

```bash
npm i -g brainbank
```

This installs **everything**: core, code plugin, git plugin, docs plugin, all 20 tree-sitter grammars, CLI. All plugins and grammars are `optionalDependencies` — they install automatically if your system has a C++ toolchain.

---

## Packages

Every plugin is also published as a standalone `@brainbank/*` package. The core `brainbank` install bundles most of them as optional dependencies — you only install packages separately for programmatic imports or `--no-optional` setups.

### Bundled Plugins (included in `brainbank`)

| Package | What it does |
|---------|------|
| [`@brainbank/code`](./packages/code/) | AST-aware code chunking, import graph, symbol index, call refs. Includes JS/TS/JSX/TSX, HTML + Python grammars |
| [`@brainbank/git`](./packages/git/) | Git history indexing + co-edit analysis (which files change together) |
| [`@brainbank/docs`](./packages/docs/) | Document collection search with heading-aware smart chunking (qmd-inspired) |

### Tree-Sitter Grammars

`@brainbank/code` bundles **5 grammars** out of the box: JavaScript, TypeScript (JSX/TSX), Python, and HTML. These cover most projects without any extra setup.

For additional languages, install individual `tree-sitter-*` packages globally:

```bash
# Install a few extra languages
npm i -g tree-sitter-go tree-sitter-rust

# Install all 16 remaining grammars at once
npm i -g tree-sitter-go tree-sitter-rust tree-sitter-c tree-sitter-cpp \
  tree-sitter-java tree-sitter-kotlin tree-sitter-scala tree-sitter-ruby \
  tree-sitter-php tree-sitter-c-sharp tree-sitter-swift tree-sitter-lua \
  tree-sitter-bash tree-sitter-elixir tree-sitter-css
```

BrainBank auto-detects installed grammars at runtime. Missing grammars fall back to a sliding-window chunker (still functional, just less precise).

| Default (bundled) | Install separately |
|---|---|
| JavaScript | Go |
| TypeScript (JSX/TSX) | Rust |
| Python | C / C++ |
| HTML | Java / Kotlin / Scala |
| | Ruby |
| | PHP |
| | C# |
| | Swift |
| | Lua / Bash / Elixir |
| | CSS |

### Separate Packages (install individually)

| Package | What it does | Install |
|---------|------|---------|
| [`@brainbank/memory`](./packages/memory/) | Deterministic fact extraction + entity graph for conversational memory | `npm i -g @brainbank/memory` |
| [`@brainbank/mcp`](./packages/mcp/) | MCP server for Antigravity, Claude Desktop, Cursor, etc. | `npm i -g @brainbank/mcp` |

### Tree-Sitter Grammars

BrainBank uses [tree-sitter](https://tree-sitter.github.io/) for AST-aware code chunking. **5 grammars are bundled** (JS/TS/Python/HTML). Install additional languages with `npm i -g tree-sitter-<lang>`. Without grammars, the code indexer falls back to sliding-window chunking.

| Category | Languages |
|----------|-----------|
| **Web** | JavaScript, TypeScript, HTML, CSS |
| **Systems** | Go, Rust, C, C++, Swift |
| **JVM** | Java, Kotlin, Scala |
| **Scripting** | Python, Ruby, PHP, Lua, Bash, Elixir |
| **.NET** | C# |

---

## Quick Start

Get semantic search over your codebase in under a minute:

```typescript
import { BrainBank } from 'brainbank';
import { code } from 'brainbank/code';
import { git } from 'brainbank/git';

const brain = new BrainBank({ repoPath: '.' })
  .use(code())
  .use(git());

await brain.index();  // indexes code + git history (incremental)

// Search across everything
const results = await brain.hybridSearch('authentication middleware');
console.log(results.map(r => `${r.filePath}:L${r.metadata?.startLine} (${r.score.toFixed(2)})`));

// Store agent memory
const log = brain.collection('decisions');
await log.add(
  'Switched from bcrypt to argon2id for password hashing. ' +
  'Argon2id is memory-hard and recommended by OWASP for new projects. ' +
  'Updated src/auth/hash.ts and all tests.',
  { tags: ['security', 'auth'] }
);

// Recall later: "what did we decide about password hashing?"
const hits = await log.search('password hashing decision');

brain.close();
```

Or use the CLI — zero code:

```bash
npm install -g brainbank
brainbank index .                          # index code + git
brainbank hsearch "rate limiting"           # hybrid search
brainbank kv add decisions "Use Redis..."   # store a memory
brainbank kv search decisions "caching"     # recall it
```

## CLI

BrainBank can be used entirely from the command line — no config file needed.

### Indexing

`index` processes **code files + git history** by default. Use `--only` to select specific modules, and `--docs` to include document collections.

```bash
brainbank index [path]                      # Index code + git history
brainbank index [path] --force              # Force re-index everything
brainbank index [path] --depth 200          # Limit git commit depth
brainbank index [path] --only code          # Index only code (skip git)
brainbank index [path] --only git           # Index only git history
brainbank index [path] --docs ~/docs        # Include a docs folder
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
#   14:30:08 ✓ csv: data/metrics.csv       ← custom plugin
```

> Watch mode monitors **code files** by default. [Custom plugins](#custom-plugins) that implement `watchPatterns()` and `onFileChange()` are automatically picked up — their name appears in the console output alongside the built-in `code` plugin. Git history and document collections are not affected by file-system changes and must be re-indexed explicitly with `brainbank index` / `brainbank docs`.

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

**Source filtering** — all search commands accept `--<source> <n>` to control how many results come from each source. Set to `0` to skip a source. Works with built-in sources and custom plugins:

```bash
brainbank hsearch "auth" --code 0 --git 10           # git commits only
brainbank hsearch "auth" --code 10 --git 0           # code only
brainbank search "handler" --git 0                   # code only (vector)
brainbank ksearch "bugfix" --code 0                  # git only (keyword)
brainbank hsearch "auth" --code 3 --git 3            # balanced mix
brainbank hsearch "api" --docs 10 --code 0 --git 0   # docs only
brainbank hsearch "bug" --notes 5 --git 3            # custom plugin + git
brainbank hsearch "auth" --code 5 --docs 10 --slack_messages 3
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

**Global options:** `--repo <path>`, `--force`, `--depth <n>`, `--<source> <n>` (source filter), `--ignore <globs>`, `--collection <name>`, `--pattern <glob>`, `--context <desc>`, `--reranker <name>`

---

## Programmatic API

Use BrainBank as a library in your TypeScript/Node.js project.

### Plugins

BrainBank uses pluggable plugins. Register only what you need with `.use()`:

| Plugin | Import | Description |
|---------|--------|-------------|
| `code` | `brainbank/code` | AST-aware code chunking via tree-sitter (20 languages). Source code only — does **not** index documents (.md, .mdx) |
| `git` | `brainbank/git` | Git commit history, diffs, co-edit relationships |
| `docs` | `brainbank/docs` | Document collections (markdown, wikis, .md/.mdx files) |

```typescript
import { BrainBank, OpenAIEmbedding } from 'brainbank';
import { code } from 'brainbank/code';
import { git } from 'brainbank/git';
import { docs } from 'brainbank/docs';

// Each plugin can use a different embedding provider
const brain = new BrainBank({ repoPath: '.' })       // default: local WASM (384d, free)
  .use(code({
    embeddingProvider: new OpenAIEmbedding(),                // code: OpenAI (1536d)
    ignore: ['sdk/**', 'vendor/**', '**/*.generated.ts'],   // skip auto-generated code
  }))
  .use(git())                                               // git: local (384d)
  .use(docs());                                             // docs: local (384d)

// Index code + git (incremental — only processes changes)
await brain.index();

// Register and index document collections
await brain.addCollection({ name: 'wiki', path: '~/docs', pattern: '**/*.md' });
await brain.indexDocs();

// Dynamic collections — store anything
const decisions = brain.collection('decisions');
await decisions.add(
  'Use SQLite with WAL mode instead of PostgreSQL. Portable, zero infra.',
  { tags: ['architecture'] }
);
const hits = await decisions.search('why not postgres');

brain.close();
```

### Collections

**No plugin needed.** Collections are the simplest way to index any data — API responses, Slack messages, logs, research notes, error traces, anything. Just `brain.collection('name')` and start adding content. Each item is auto-embedded for semantic search.

```typescript
// Minimal setup — no plugins required
import { BrainBank } from 'brainbank';

const brain = new BrainBank({ repoPath: '.' });
await brain.initialize();

// Create collections on the fly (auto-created on first use)
const errors = brain.collection('errors');
const decisions = brain.collection('decisions');

// Store anything — auto-embedded for vector search
await errors.add('TypeError: Cannot read property "id" of undefined in UserService.getProfile()', {
  tags: ['backend'], metadata: { file: 'src/user.ts', line: 42 }
});

await decisions.add(
  'Use SQLite with WAL mode instead of PostgreSQL. Portable single-file ' +
  'storage, works offline, zero infrastructure.',
  { tags: ['architecture'], metadata: { files: ['src/db.ts'] } }
);

// Semantic search — finds by meaning, not exact keywords
const hits = await decisions.search('why not postgres');
// → [{ content: 'Use SQLite with WAL...', score: 0.95, tags: [...], metadata: {...} }]

// Batch add (uses embedBatch — much faster than individual adds)
await errors.addMany([
  { content: 'NullPointerException in AuthService', tags: ['backend'], metadata: { file: 'auth.ts' } },
  { content: 'CORS preflight failed on /api/users', tags: ['frontend'], metadata: { file: 'proxy.ts' } },
]);

// Update an existing item (re-embeds, preserves metadata/tags unless overridden)
const id = await errors.add('Old error message', { tags: ['backend'] });
await errors.update(id, 'Updated error message'); // keeps original tags

// Management
decisions.list({ limit: 20 });          // newest first
decisions.list({ tags: ['architecture'] }); // filter by tags
decisions.count();                      // total items
decisions.remove(id);                   // remove by ID
decisions.clear();                      // remove all items
decisions.trim({ keep: 50 });           // keep N most recent
decisions.prune({ olderThan: '30d' });  // remove older than 30 days
brain.listCollectionNames();            // → ['errors', 'decisions']
```

#### Collection API

| Method | Signature | Description |
|--------|-----------|-------------|
| `add` | `add(content, options?): Promise<number>` | Add an item. Returns its ID. Auto-embedded for vector search. |
| `addMany` | `addMany(items): Promise<number[]>` | Batch add (uses `embedBatch` — much faster). Returns IDs. |
| `update` | `update(id, content, options?): Promise<number>` | Replace content, re-embed. Preserves original metadata/tags unless overridden. Returns new ID. |
| `search` | `search(query, options?): Promise<CollectionItem[]>` | Hybrid search (vector + BM25 → RRF). Options: `k`, `mode`, `minScore`, `tags`. |
| `list` | `list(options?): CollectionItem[]` | List items (newest first). Options: `limit`, `offset`, `tags`. |
| `count` | `count(): number` | Total items in collection. |
| `remove` | `remove(id): void` | Remove a specific item by ID. |
| `clear` | `clear(): void` | Remove all items in the collection. |
| `trim` | `trim({ keep }): Promise<{ removed }>` | Keep N most recent items, remove the rest. |
| `prune` | `prune({ olderThan }): Promise<{ removed }>` | Remove items older than a duration (e.g. `'30d'`, `'12h'`). |

**Options for `add` / `update`:** `{ metadata?: Record, tags?: string[], ttl?: string }`

> TTL: Items with a `ttl` (e.g. `'7d'`, `'24h'`) are auto-pruned from search/list results after expiration.

Collections work standalone or alongside plugins. When used with `hsearch`, pass `--<collection> <n>` to include them in hybrid search results.

> 📂 See [examples/collection](examples/collection/) for a complete runnable demo with cross-collection linking and metadata.

### Watch Mode

Auto-re-index when files change:

```typescript
// API
const watcher = brain.watch({
  debounceMs: 2000,
  onIndex: (file, plugin) => console.log(`${plugin}: ${file}`),
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

#### Custom Plugin Watch

Custom plugins can hook into watch mode by implementing `onFileChange` and `watchPatterns`:

```typescript
import type { Plugin, PluginContext } from 'brainbank';
import * as fs from 'node:fs';

function csvPlugin(): Plugin {
  let ctx: PluginContext;

  return {
    name: 'csv',

    async initialize(context) {
      ctx = context;
    },

    // Tell watch which files this plugin cares about
    watchPatterns() {
      return ['**/*.csv', '**/*.tsv'];
    },

    // Called when a watched file changes (event: 'create' | 'update' | 'delete')
    async onFileChange(filePath, event) {
      const col = ctx.collection('csv_data');

      // Remove old data for this file (idempotent — safe if nothing exists)
      const existing = col.list({ limit: 1000 }).filter(
        i => i.metadata.file === filePath
      );
      for (const item of existing) col.remove(item.id);

      // Re-add only if the file still exists (not a delete event)
      if (event !== 'delete') {
        const data = fs.readFileSync(filePath, 'utf-8');
        await col.add(data, {
          tags: ['csv'],
          metadata: { file: filePath },
        });
      }

      return true; // handled
    },
  };
}

const brain = new BrainBank({ dbPath: './brain.db' })
  .use(code())
  .use(csvPlugin());

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

// Source filtering — control how many results per source
const codeOnly = await brain.hybridSearch('auth', { codeK: 10, gitK: 0 });
const gitOnly  = await brain.hybridSearch('auth', { codeK: 0, gitK: 10 });
const balanced = await brain.hybridSearch('auth', { codeK: 3, gitK: 3 });

// Scoped search (convenience methods)
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

#### How Search Works

BrainBank has **two levels** of search:

```
brain.hybridSearch('auth')
  │
  ├── SearchAPI (centralized orchestration)
  │     │
  │     ├── VectorSearch ──── shared HNSW ──── code + git vectors
  │     ├── KeywordSearch ─── FTS5 BM25 ────── code + git text
  │     └── RRF fusion ────── merges all result lists
  │
  └── Plugin search (per-plugin, via @expose)
        │
        └── DocsPlugin.searchDocs() ── own HNSW ── doc vectors
```

**Centralized search** (`SearchAPI`) manages a shared multi-index HNSW that holds both code and git vectors. The convenience methods `searchCode()` and `searchCommits()` are just filters on this shared index:

```typescript
// These are equivalent:
await brain.searchCode('auth', 8);
await brain.search('auth', { codeK: 8, gitK: 0 });
```

**Plugin-owned search** runs independently. The docs plugin has its own HNSW index and BM25 search, because document collections can use different embedding dimensions (via per-plugin `embeddingProvider`).

`hybridSearch()` **combines both levels** — it queries the shared vector+BM25 indices AND the docs plugin, then fuses everything with [Reciprocal Rank Fusion (RRF)](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf):

```typescript
// hybridSearch queries ALL sources and fuses with RRF:
const results = await brain.hybridSearch('auth middleware', {
  codeK: 20,   // top-20 code vectors
  gitK: 8,     // top-8 git vectors
  // docs automatically queried (top-8) if docs plugin is loaded
  // KV collections queryable too:
  collections: { errors: 5, patterns: 3 },
});
```

| Method | Engine | What it searches |
|--------|--------|-----------------|
| `search(q)` | SearchAPI → VectorSearch | Code + git vectors (shared HNSW) |
| `searchCode(q)` | SearchAPI → VectorSearch | Code vectors only |
| `searchCommits(q)` | SearchAPI → VectorSearch | Git vectors only |
| `searchBM25(q)` | SearchAPI → KeywordSearch | Code + git text (FTS5) |
| `searchDocs(q)` | DocsPlugin (via `@expose`) | Document vectors (own HNSW + BM25) |
| `hybridSearch(q)` | SearchAPI + plugins | **All sources** → RRF fusion |
| `getContext(task)` | SearchAPI + plugins | All sources → formatted markdown |

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
// Returns:
// ## Relevant Code       — grouped by file, with call graph annotations
// ## Related Files        — import graph (who imports what)
// ## Git History          — relevant commits with diffs
// ## Relevant Documents   — matching doc chunks
```

### Building Custom Plugins

BrainBank plugins implement the `Plugin` interface to index any data source, participate in hybrid search, and expose convenience methods on `brain`.

> 📂 **Full working examples:** [examples/custom-plugin/](examples/custom-plugin/) — two distinct plugins with sample data: a **notes plugin** (programmatic, reads `.txt` files) and a **quotes plugin** (CLI auto-discovery, reads `quotes.txt` line by line).

#### Plugin Lifecycle

```
1. brain.use(myPlugin)        →  Plugin registered (not initialized yet)
2. await brain.initialize()   →  plugin.initialize(ctx) called
                              →  @expose methods bound to brain instance
3. brain.index()              →  plugin.index() called  (if IndexablePlugin)
4. brain.search()             →  plugin.search() called (if SearchablePlugin)
5. brain.watch()              →  plugin.onFileChange()  (if WatchablePlugin)
6. brain.close()              →  plugin.close()         (cleanup)
```

#### Minimal Plugin

```typescript
import type { Plugin, PluginContext } from 'brainbank';

const myPlugin: Plugin = {
  name: 'my-plugin',
  async initialize(ctx: PluginContext) {
    const store = ctx.collection('my_data');
    await store.add('some content', { tags: ['example'] });
  },
};

const brain = new BrainBank({ repoPath: '.' }).use(myPlugin);
await brain.initialize();
```

#### `PluginContext` API

Every plugin receives a `PluginContext` during `initialize()`:

| Property | What you use it for |
|----------|---------------------|
| `ctx.collection(name)` | **Start here.** Get/create a KV collection with built-in hybrid search |
| `ctx.db` | Raw SQLite access (for custom tables) |
| `ctx.embedding` | `embed(text)` / `embedBatch(texts)` |
| `ctx.config` | `repoPath`, `dbPath`, etc. |
| `ctx.createHnsw(max?, dims?)` | Standalone HNSW index (advanced) |
| `ctx.getOrCreateSharedHnsw(type)` | Shared HNSW across same-type plugins (multi-repo) |

#### Capability Interfaces

| Interface | Method to implement | What happens |
|-----------|---------------------|-------------|
| `IndexablePlugin` | `index(options?)` | Runs during `brain.index()` |
| `SearchablePlugin` | `search(query, options?)` | Results merged via RRF in `brain.search()` |
| `WatchablePlugin` | `watchPatterns()` + `onFileChange(path, event)` | Auto-re-index on file changes |

#### The `@expose` Decorator

Mark methods with `@expose` to inject them onto `brain`:

```typescript
import { expose } from 'brainbank';

class MyPlugin implements Plugin {
    readonly name = 'my-plugin';
    private ctx!: PluginContext;

    async initialize(ctx: PluginContext) { this.ctx = ctx; }

    // Injected onto brain → brain.searchMyData('query')
    @expose
    async searchMyData(query: string, k = 5): Promise<SearchResult[]> {
        const hits = await this.ctx.collection('my_data').search(query, { k });
        return hits.map(h => ({
            type: 'collection' as const,
            score: h.score ?? 0,
            content: h.content,
            metadata: h.metadata,
        }));
    }
}

export function myPlugin(opts?: MyOptions): Plugin {
    return new MyPlugin(opts);
}
```

Methods **without** `@expose` stay internal — accessible via `brain.plugin('name')`.

#### CLI Auto-Discovery

Drop `.ts` files into `.brainbank/plugins/` — the CLI auto-discovers them:

```typescript
// .brainbank/plugins/my-plugin.ts
import type { Plugin } from 'brainbank';

export default {
  name: 'my-plugin',
  async initialize(ctx) { /* ... */ },
} satisfies Plugin;
```

```bash
brainbank index    # runs code + git + docs + my-plugin
brainbank stats    # shows all plugins
```

### Developing a Plugin Package

To publish a reusable plugin as a standalone npm package (like `@brainbank/git` or `@brainbank/docs`):

> 📂 **Full scaffold:** [examples/custom-package/](examples/custom-package/) — a CSV indexer as a publishable npm package, with every config file included.

> ⚠️ The `@brainbank` npm scope is reserved for official plugins. Use your own scope (e.g. `brainbank-csv`, `@myorg/brainbank-csv`).

| Requirement | Value |
|-------------|-------|
| `brainbank` in `package.json` | `peerDependencies` (never `dependencies`) |
| Local imports | `.js` extensions (`'./my-plugin.js'`) |
| Export pattern | Factory function: `csv(opts)` → `Plugin` |
| `tsup` externals | `external: ['brainbank']` |
| `tsconfig` module | `"moduleResolution": "bundler"` |

```bash
npm run build       # → dist/index.js + dist/index.d.ts
npm publish --access public
```

```typescript
import { BrainBank } from 'brainbank';
import { csv } from 'brainbank-csv';

const brain = new BrainBank({ repoPath: '.' }).use(csv({ dir: './data' }));
await brain.initialize();
await brain.index();
```

## Project Config

Drop a `.brainbank/config.json` in your repo root. Every `brainbank index` reads it automatically — no CLI flags needed.

```jsonc
// .brainbank/config.json
{
  // Which built-in plugins to load (default: all three)
  "plugins": ["code", "git", "docs"],

  // Per-plugin options
  "code": {
    "embedding": "openai",         // use OpenAI embeddings for code
    "maxFileSize": 512000,
    "ignore": [                     // glob patterns to exclude from indexing
      "sdk/**",
      "vendor/**",
      "**/*.generated.ts",
      "**/*.min.js",
      "test/fixtures/**"
    ]
  },
  "git": {
    "depth": 200                    // index last 200 commits
  },
  "docs": {
    "embedding": "perplexity-context",
    "collections": [
      { "name": "docs", "path": "./docs", "pattern": "**/*.md" },
      { "name": "wiki", "path": "~/team-wiki", "pattern": "**/*.md", "ignore": ["drafts/**"] }
    ]
  },

  // Global defaults
  "embedding": "local",            // default for plugins without their own
  "reranker": "qwen3"
}
```

**Embedding keys:** `"local"` (default, free), `"openai"`, `"perplexity"`, `"perplexity-context"`.

**Per-plugin embeddings** — each plugin creates its own HNSW index with the correct dimensions. A plugin without an `embedding` key uses the global default.

**Docs collections** — registered automatically on every `brainbank index` run. No need for `--docs` flags.

**Custom plugins** — auto-discovered from `.brainbank/plugins/`:

```
.brainbank/
├── brainbank.db        # SQLite database (auto-created)
├── config.json         # Project config (optional)
└── plugins/            # Custom plugin files (optional)
    ├── notes.ts
    └── csv.ts
```

Custom plugins can also have their own config section:

```jsonc
{
  "plugins": ["code", "git"],
  "notes": { "embedding": "local" },    // matched by plugin name
  "csv": { "embedding": "openai" }
}
```

**Config priority:** CLI flags > `config.json` > auto-resolve from DB > defaults.

> `.brainbank/config.ts` (or `.js`, `.mjs`) is still supported for programmatic config with custom plugin instances. JSON is preferred for declarative setups.

No config file? The CLI uses all built-in plugins with local embeddings — zero config required.

---

### AI Agent Integration

Teach your AI coding agent to use BrainBank as persistent memory. Add an `AGENTS.md` (or `.cursor/rules`) to your project root — works with **Antigravity**, **Claude Code**, **Cursor**, and anything that reads project-level instructions.

<details>
<summary><strong>Option A: CLI commands</strong> (zero setup)</summary>

> **Memory — BrainBank**
>
> **Store** a conversation summary after each task:
> `brainbank kv add conversations "Refactored auth to AuthService with DI. JWT + refresh tokens + RBAC."`
>
> **Record** architecture decisions:
> `brainbank kv add decisions "ADR: Fastify over Express. 2x throughput, schema validation, native TS."`
>
> **Search** before starting work:
> `brainbank hsearch "auth middleware"` · `brainbank kv search decisions "auth"`

</details>

<details>
<summary><strong>Option B: MCP tools</strong> (richer integration)</summary>

> **Memory — BrainBank (MCP)**
>
> Use the BrainBank MCP tools for persistent agent memory:
>
> **Store** via `brainbank_kv_add`:
> `{ collection: "conversations", content: "Refactored auth to AuthService with DI.", tags: ["auth"] }`
>
> **Search** via `brainbank_kv_search`:
> `{ collection: "decisions", query: "authentication approach" }`
>
> **Code search** via `brainbank_hybrid_search`:
> `{ query: "auth middleware", repo: "." }`

</details>

#### Setup

| Agent | How to connect |
|-------|---------------|
| **Antigravity** | Add `AGENTS.md` to project root |
| **Claude Code** | Add `AGENTS.md` to project root |
| **Cursor** | Add rules in `.cursor/rules` |
| **MCP** (any agent) | See [MCP Server](#mcp-server) config below |

#### Custom Plugin: Auto-Ingest Conversation Logs

For agents that produce structured logs (e.g. Antigravity's `brain/` directory), auto-index them:

```typescript
// .brainbank/plugins/conversations.ts
import type { Plugin, PluginContext } from 'brainbank';
import * as fs from 'node:fs';
import * as path from 'node:path';

export default {
  name: 'conversations',
  async initialize(ctx: PluginContext) {
    const conversations = ctx.collection('conversations');
    const logsDir = path.join(ctx.config.repoPath, '.gemini/antigravity/brain');
    if (!fs.existsSync(logsDir)) return;

    for (const dir of fs.readdirSync(logsDir)) {
      const file = path.join(logsDir, dir, '.system_generated/logs/overview.txt');
      if (!fs.existsSync(file)) continue;
      const content = fs.readFileSync(file, 'utf-8');
      if (content.length < 100) continue;
      await conversations.add(content, {
        tags: ['auto'],
        metadata: { session: dir, source: 'antigravity' },
      });
    }
  },
} satisfies Plugin;
```

```bash
brainbank index   # now auto-indexes conversation logs alongside code + git
brainbank kv search conversations "what did we decide about auth"
```

### Examples

| Example | Description | Run |
|---------|-------------|-----|
| [custom-plugin](examples/custom-plugin/) | Notes + Quotes plugins (programmatic API & CLI) | `npx tsx examples/custom-plugin/usage.ts` |
| [custom-package](examples/custom-package/) | Standalone npm package scaffold (CSV plugin) | See [README](examples/custom-package/README.md) |
| [collection](examples/collection/) | Collections, semantic search, tags, metadata linking | `npx tsx examples/collection/collection.ts` |
| [rag](examples/rag/) | RAG chatbot — docs retrieval + generation | `npx tsx examples/rag/rag.ts --docs <path>` ¹ |
| [memory](examples/memory/) | Memory chatbot — fact extraction + entity graph | `npx tsx examples/memory/memory.ts` ¹ |

> ¹ RAG and memory examples require `OPENAI_API_KEY`. RAG also requires `PERPLEXITY_API_KEY`. All other examples use local embeddings — zero config.

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
      "args": ["-y", "@brainbank/mcp"]
    }
  }
}
```

**Zero-config.** The MCP server auto-detects:
- **Repo path** — from `repo` tool param > `findRepoRoot(cwd)`
- **Embedding provider** — from `provider_key` stored in the DB (set during `brainbank index --embedding openai`)

> [!TIP]
> Index your repo once with the CLI to set up the embedding provider:
> ```bash
> brainbank index . --embedding openai   # stores provider_key=openai in DB
> ```
> After that, the MCP server (and any future CLI runs) auto-resolve the correct provider from the DB — no env vars needed.

> [!NOTE]
> If you switch embedding providers (e.g. local → OpenAI), run `brainbank reembed` to regenerate all vectors. BrainBank auto-detects dimension mismatches and warns you.

### Available Tools

| Tool | Description |
|------|-------------|
| `brainbank_search` | Unified search — `mode: hybrid` (default), `vector`, or `keyword` |
| `brainbank_context` | Formatted context block for a task (code + git + co-edits) |
| `brainbank_index` | Trigger incremental code/git/docs indexing |
| `brainbank_stats` | Index statistics (files, commits, chunks, collections) |
| `brainbank_history` | Git history for a specific file |
| `brainbank_collection` | KV collection ops — `action: add`, `search`, or `trim` |

---

## Configuration

```typescript
import { BrainBank, OpenAIEmbedding } from 'brainbank';
import { Qwen3Reranker } from 'brainbank';  // built-in, requires node-llama-cpp

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
| **Perplexity** | `PerplexityEmbedding` | 2560 (4b) / 1024 (0.6b) | ~100ms | $0.02/1M tokens |
| **Perplexity Context** | `PerplexityContextEmbedding` | 2560 (4b) / 1024 (0.6b) | ~100ms | $0.06/1M tokens |

#### How It Works

BrainBank **auto-resolves** the embedding provider. Set it once → it's stored in the DB → every future run uses the same provider automatically.

**Programmatic API** — pass `embeddingProvider` to the constructor:

```typescript
import { BrainBank, OpenAIEmbedding } from 'brainbank';

const brain = new BrainBank({
  repoPath: '.',
  embeddingProvider: new OpenAIEmbedding(),  // stored in DB on first index
});
```

**CLI** — use the `--embedding` flag on first index:

```bash
brainbank index . --embedding openai        # stores provider_key=openai in DB
brainbank index .                            # auto-resolves openai from DB
brainbank hsearch "auth middleware"           # uses the same provider
```

**MCP** — zero-config. Reads the provider from the DB automatically.

> The provider key is persisted in the `embedding_meta` table. Priority on startup: explicit `embeddingProvider` in config > stored `provider_key` in DB > local WASM (default).

**Per-plugin override** — each plugin can use a different embedding provider:

```typescript
import { BrainBank, OpenAIEmbedding } from 'brainbank';
import { PerplexityContextEmbedding } from 'brainbank';
import { code } from 'brainbank/code';
import { git } from 'brainbank/git';
import { docs } from 'brainbank/docs';

const brain = new BrainBank({ repoPath: '.' })       // default: local WASM (384d)
  .use(code({ embeddingProvider: new OpenAIEmbedding() }))              // code: OpenAI (1536d)
  .use(git())                                                           // git: local (384d)
  .use(docs({ embeddingProvider: new PerplexityContextEmbedding() }));  // docs: Perplexity (2560d)
```

> Each plugin creates its own HNSW index with the correct dimensions. The global `embeddingProvider` (or local default) is used for any plugin that doesn't specify one.

#### OpenAI

```typescript
import { OpenAIEmbedding } from 'brainbank';

new OpenAIEmbedding();                        // uses OPENAI_API_KEY env var
new OpenAIEmbedding({
  model: 'text-embedding-3-large',
  dims: 512,                                  // Matryoshka reduction
  apiKey: 'sk-...',
  baseUrl: 'https://my-proxy.com/v1/embeddings',
});
```

#### Perplexity (Standard)

Best for independent texts, queries, and code chunks.

```typescript
import { PerplexityEmbedding } from 'brainbank';

new PerplexityEmbedding();                    // uses PERPLEXITY_API_KEY env var
new PerplexityEmbedding({
  model: 'pplx-embed-v1-0.6b',               // smaller, faster (1024d)
  dims: 512,                                  // Matryoshka reduction
});
```

#### Perplexity (Contextualized)

Chunks share document context → better retrieval for related code/docs.

```typescript
import { PerplexityContextEmbedding } from 'brainbank';

new PerplexityContextEmbedding();             // uses PERPLEXITY_API_KEY env var
new PerplexityContextEmbedding({
  model: 'pplx-embed-context-v1-0.6b',       // smaller, faster (1024d)
  dims: 512,                                  // Matryoshka reduction
});
```

#### Benchmarks

Real benchmarks on a production NestJS backend (1052 code chunks + git history):

| Provider | Dims | Index Time | Avg Search | Cost |
|----------|------|------------|------------|------|
| **Local WASM** | 384 | 87s | **8ms** | Free |
| **OpenAI** | 1536 | 106s | 202ms | $0.02/1M tok |
| **Perplexity** | 2560 | **66s** ⚡ | 168ms | $0.02/1M tok |
| **Perplexity Context** | 2560 | 78s | 135ms | $0.06/1M tok |

- **Fastest indexing:** Perplexity standard — 38% faster than OpenAI
- **Fastest search (API):** Perplexity Context — 33% faster than OpenAI
- **Fastest search (total):** Local WASM — no network latency
- **Best context awareness:** Perplexity Context — finds semantically related chunks others miss

> [!WARNING]
> Switching embedding provider (e.g. local → OpenAI) changes the vector dimensions. BrainBank will **refuse to initialize** if the stored dimensions don't match the current provider. Use `initialize({ force: true })` and then `reembed()` to migrate, or switch back to the original provider.

### Reranker

BrainBank ships with an optional cross-encoder reranker using **Qwen3-Reranker-0.6B** via `node-llama-cpp`. It runs 100% locally — no API keys needed. The reranker is **disabled by default**.

```bash
# Only requirement — the LLM runtime (model auto-downloads on first use)
npm install node-llama-cpp
```

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
import { Qwen3Reranker } from 'brainbank';

const brain = new BrainBank({
  reranker: new Qwen3Reranker(),  // ~640MB model, auto-downloaded on first use
});
```

Or from the CLI:

```bash
brainbank hsearch "auth middleware" --reranker qwen3
```

Or via `.brainbank/config.json`:

```jsonc
{ "reranker": "qwen3" }
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

### Agent Memory (Patterns)

The memory plugin enables **learning from experience** — your agent records what worked (and what didn't) across tasks, then distills patterns into reusable strategies.

```typescript
import { BrainBank } from 'brainbank';
import { memory } from 'brainbank';

const brain = new BrainBank({ repoPath: '.' });
brain.use(memory());
await brain.initialize();

const mem = brain.plugin('memory');

// Record a learning pattern
await mem.learn({
  taskType: 'refactor',
  task: 'Extract auth logic into middleware',
  approach: 'Created Express middleware, moved JWT validation from routes',
  outcome: 'Reduced route handler size by 60%, improved testability',
  successRate: 0.95,
  critique: 'Should have added integration tests before refactoring',
});

// Search for similar patterns before starting a new task
const patterns = await mem.search('refactor database queries');

// Consolidate: prune old failures + merge duplicates
const { pruned, deduped } = mem.consolidate();

// Distill top patterns into a strategy
const strategy = mem.distill('refactor');
// → "Strategy for 'refactor' (5 patterns, avg success 88%):
//    • Created middleware, moved validation from routes (95%)
//      └ Should have added integration tests before refactoring"
```

**How it works:**
1. **Learn** — Records task, approach, outcome, and success rate. Embeds for semantic search
2. **Search** — Finds similar successful patterns (filters by `successRate ≥ 0.5`)
3. **Consolidate** — Auto-runs every 50 patterns: prunes failures older than 90 days, deduplicates (cosine > 0.95)
4. **Distill** — Aggregates top patterns per task type into a single strategy text with confidence score

---

## Memory

`@brainbank/memory` adds **deterministic memory extraction** to any LLM conversation. After every turn, it automatically extracts facts, deduplicates against existing memories, and decides `ADD` / `UPDATE` / `NONE` — no function calling needed.

Optionally extracts **entities and relationships** (knowledge graph) from the same LLM call — no extra cost. Includes **LLM-powered entity resolution** to merge aliases (e.g. "TS" → "TypeScript").

Inspired by [mem0](https://github.com/mem0ai/mem0)'s pipeline, but framework-agnostic and built on BrainBank collections.

```bash
npm install @brainbank/memory
```

```typescript
import { BrainBank } from 'brainbank';
import { Memory, EntityStore, OpenAIProvider } from '@brainbank/memory';

const brain = new BrainBank({ dbPath: './memory.db' });
await brain.initialize();

const llm = new OpenAIProvider({ model: 'gpt-4.1-nano' });

// Opt-in entity extraction (knowledge graph)
const entityStore = new EntityStore(brain, {
  onEntity: (op) => console.log(`${op.action}: ${op.name}`),
});

const memory = new Memory(brain, {
  llm,              // auto-shared with EntityStore
  entityStore,      // optional — omit for facts-only mode
  onOperation: (op) => console.log(`${op.action}: ${op.fact}`),
});

// After every conversation turn
const result = await memory.process(userMessage, assistantResponse);
// result.operations → [{ fact, action: "ADD", reason }]
// result.entities   → { entitiesProcessed: 2, relationshipsProcessed: 1 }

// System prompt with memories + entities
const context = memory.buildContext();
// → "## Memories\n- User's name is Berna\n\n## Known Entities\n- Berna (person, 3x)\n..."
```

The `LLMProvider` interface works with any framework:

| Framework | Adapter |
|-----------|--------|
| OpenAI | Built-in `OpenAIProvider` |
| LangChain | `ChatOpenAI.invoke()` → string |
| Vercel AI SDK | `generateText()` → string |
| Any LLM | Implement `{ generate(messages) → string }` |

> 📂 See [examples/memory](examples/memory/) for a runnable demo. All three LLM backends supported via `--llm` flag.

> 📦 Full docs: [packages/memory/README.md](packages/memory/README.md)

---

### Environment Variables

| Variable | Description |
|----------|-------------|
| `BRAINBANK_DEBUG` | Show full stack traces in CLI errors |
| `OPENAI_API_KEY` | Required when using `--embedding openai` |
| `PERPLEXITY_API_KEY` | Required when using `--embedding perplexity` or `perplexity-context` |

> **Note:** `BRAINBANK_EMBEDDING` env var has been removed. Use `brainbank index --embedding <provider>` on first index — the provider is stored in the DB and auto-resolved on subsequent runs.

---

## Multi-Repository Indexing

BrainBank can index multiple repositories into a **single shared database**. This is useful for monorepos, microservices, or any project split across multiple Git repositories.

### How It Works

When you point BrainBank at a directory that contains multiple Git repositories (subdirectories with `.git/`), the CLI **auto-detects** them and creates namespaced plugins:

```bash
~/projects/
├── webapp-frontend/   # .git/
├── webapp-backend/    # .git/
└── webapp-shared/     # .git/
```

```bash
brainbank index ~/projects --depth 200
```

```
━━━ BrainBank Index ━━━
  Repo: /Users/you/projects
  Multi-repo: found 3 git repos: webapp-frontend, webapp-backend, webapp-shared
  CODE:WEBAPP-BACKEND [0/1075] ...
  CODE:WEBAPP-FRONTEND [0/719] ...
  GIT:WEBAPP-SHARED [0/200] ...

  Code: 2107 indexed, 4084 chunks
  Git:  600 indexed (200 per repo)
  Co-edit pairs: 1636
```

All code, git history, and co-edit relationships from every sub-repository go into **one** `.brainbank/brainbank.db` at the parent directory. Search queries automatically return results across all repositories:

```bash
brainbank hsearch "cancel job confirmation" --repo ~/projects
# → Results from frontend components, backend controllers,
#   and shared utilities — all in one search.
```

### Namespaced Plugins

Each sub-repository gets its own namespaced plugin instances (e.g., `code:frontend`, `git:backend`). Same-type plugins share a single HNSW vector index for efficient memory usage and unified search.

### Programmatic API

```typescript
import { BrainBank } from 'brainbank';
import { code } from 'brainbank/code';
import { git } from 'brainbank/git';

const brain = new BrainBank({ repoPath: '~/projects' })
  .use(code({ name: 'code:frontend', repoPath: '~/projects/webapp-frontend' }))
  .use(code({ name: 'code:backend', repoPath: '~/projects/webapp-backend' }))
  .use(git({ name: 'git:frontend', repoPath: '~/projects/webapp-frontend' }))
  .use(git({ name: 'git:backend', repoPath: '~/projects/webapp-backend' }));

await brain.initialize();
await brain.index();

// Cross-repo search
const results = await brain.hybridSearch('authentication guard');
// → Results from both frontend and backend
```

### MCP Multi-Workspace

The MCP server maintains a pool of BrainBank instances — one per unique `repo` path. Each tool call can target a different workspace:

```typescript
// Agent working in one workspace
brainbank_hybrid_search({ query: "login form", repo: "/Users/you/projects" })

// Agent switches to a different project
brainbank_hybrid_search({ query: "API routes", repo: "/Users/you/other-project" })
```

Instances are cached in memory after first initialization, so subsequent queries to the same repo are fast (~480ms).

---

## Indexing

### Code Chunking (tree-sitter)

BrainBank uses **native tree-sitter** to parse source code into ASTs and extract semantic blocks — functions, classes, methods, interfaces — as individual chunks. This produces dramatically better embeddings than naive line-based splitting.

**Supported languages (AST-parsed):**

| Category | Languages |
|----------|-----------|
| Web | TypeScript, JavaScript, HTML, CSS |
| Systems | Go, Rust, C, C++, Swift |
| JVM | Java, Kotlin, Scala |
| Scripting | Python, Ruby, PHP, Lua, Bash, Elixir |
| .NET | C# |

For large classes (>80 lines), the chunker descends into the class body and extracts each method as a separate chunk. For unsupported languages, it falls back to a sliding window with overlap.

> 5 grammars (JS/TS/Python/HTML) are bundled. Install additional languages with `npm i -g tree-sitter-<lang>`.

### Code Graph

Beyond chunking, BrainBank builds a **relationship-aware code graph** during indexing. This gives the context builder (and your LLM) a deeper understanding of how code connects — not just what's in each file, but who calls what and what depends on what.

#### What Gets Indexed

The code graph adds three dimensions to each indexed file:

| Layer | Table | What it captures | Example |
|-------|-------|------------------|---------|
| **Imports** | `code_imports` | File-level dependencies | `agent.ts` → `call`, `config`, `emitter` |
| **Symbols** | `code_symbols` | Function/class/method definitions | `TurnManager.on_vad_start` (method, L420) |
| **Call Refs** | `code_refs` | Function calls within each chunk | `on_vad_start` calls `_clear_all_bot_audio`, `emit` |

**Import extraction** is regex-based (fast, no AST needed) and supports all 20 languages:

| Language Family | Patterns Matched |
|----------------|------------------|
| JS/TS | `import ... from '...'`, `require('...')` |
| Python | `import X`, `from X import Y` |
| Go | `import "pkg"`, `import (...)` |
| Ruby | `require 'X'`, `require_relative 'X'` |
| Rust | `use X::Y`, `mod X` |
| Java/Kotlin/Scala | `import X.Y.Z` |
| C/C++ | `#include <X>`, `#include "X"` |
| Others | PHP, Elixir, Lua, Swift, Bash, CSS, HTML |

**Symbol & call extraction** uses tree-sitter ASTs — the same parse tree used for chunking. Symbols are linked to their chunk IDs, enabling cross-references.

#### Enriched Embeddings

The code graph also improves **embedding quality**. Each chunk's embedding text now includes import context and parent class:

```diff
- File: src/session/turn_manager.py
- function: on_vad_start
- <code>

+ File: src/session/turn_manager.py
+ Imports: asyncio, logging, domain.turn, processors.audio.vad
+ Class: TurnManager
+ method: TurnManager.on_vad_start
+ <code>
```

This means searching for "VAD processing in turn manager" finds the right chunk even if the code itself doesn't mention "turn manager" explicitly — because the embedding captures the file context.

#### Context Output

The `getContext()` / `brainbank context` output gains two new sections:

**1. Call graph annotations** on each code block:
```
**method `on_vad_start` (L420-480)** — 95% match *(calls: _clear_all_bot_audio, emit | called by: on_speech_ended)*
```

**2. Related Files section** showing the import graph:
```markdown
## Related Files (Import Graph)

- → domain.turn                      # this file imports
- → processors.audio.vad             # this file imports
- ← tests/test_turn_manager.py       # imported by
- ← session/call_handler.py          # imported by
```

This makes `getContext()` return a complete picture — the code, who calls it, who depends on it, and its git history — in a single query.

#### Multi-Project Isolation

Each project has its own `.brainbank/` database, so `code_imports`, `code_symbols`, and `code_refs` are fully isolated per repo. In multi-repo setups (same DB, different `code:frontend` / `code:backend` plugins), file paths are relative to each repo root — no collisions.

> **Schema v5:** The code graph tables are new in schema version 5. Existing `.brainbank/` databases will auto-migrate when you re-index with `--force`.

### Incremental Indexing

All indexing is **incremental by default** — only new or changed content is processed:

| Plugin | How it detects changes | What gets skipped |
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

// force: true bypasses the dimension mismatch check for recovery
await brain.initialize({ force: true });

const result = await brain.reembed({
  onProgress: (table, current, total) => {
    console.log(`${table}: ${current}/${total}`);
  },
});
// → { code: 1200, git: 500, docs: 80, kv: 45, total: 1837 }
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

## Benchmarks

### Document Retrieval (Perplexity Context Embeddings, 2560d)

Tested with BrainBank's hybrid pipeline (Vector + BM25 → RRF):

| Benchmark | Metric | Score |
|---|---|:---:|
| **BEIR SciFact** (5,183 docs, 300 queries) | NDCG@10 | **0.761** |
| **Custom semantic** (127 docs, 20 queries) | R@5 | **83%** |

#### Pipeline Progression (Custom Eval)

| Pipeline Stage | R@5 | Delta |
|---|:---:|---|
| Vector-only (HNSW) | 57% | baseline |
| + BM25 (RRF fusion) | 78% | **+21pp** |
| + Qwen3 Reranker | 83% | **+5pp** |

> The hybrid pipeline improved R@5 by **+26pp over vector-only**, reducing misses from 6/20 to 1/20.

### Head-to-Head: BrainBank vs QMD

Compared against [QMD](https://github.com/tobi/qmd), a fully local markdown search engine (embeddinggemma 768d + query expansion). Same corpus, same 20 semantic queries:

| Metric | BrainBank + Reranker | QMD + Reranker |
|---|:---:|:---:|
| **R@5** | **83%** | 65% |
| **R@3** | **63%** | 53% |
| **MRR** | **0.57** | 0.45 |
| **Misses** | **1/20** | 6/20 |

> BrainBank wins overall (+18pp R@5). QMD is competitive on broad queries (83% vs 83%) — impressive for a fully local pipeline with zero API calls.

### Pending Benchmarks

The following benchmarks haven't been run yet:

- **Code search quality** — vector vs hybrid on code queries across multiple languages
- **Local embeddings** — same benchmarks with the WASM local provider (384d) — no API keys needed
- **OpenAI embeddings** — `text-embedding-3-small` (1536d) comparison against Perplexity
- **Indexing speed** — time to index repos of various sizes (1K, 10K, 100K files)
- **Memory usage** — HNSW RAM consumption at different scales
- **Watch mode latency** — time from file save to re-indexed and searchable

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
│  │ Plugin  │ │ Indexer │ │ Indexer │ │ (dynamic)  ││
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
│  │  code_imports│ code_symbols│ code_refs            ││
│  │  kv_data │ FTS5 full-text │ vectors │ co_edits   ││
│  └──────────────────────────────────────────────────┘│
│                                                      │
│  ┌──────────────────────────────────────────────────┐│
│  │  Embedding (Local 384d│OpenAI 1536d│Perplexity)  ││
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

1. **Index** — Plugins parse files into chunks (tree-sitter AST for code, heading-based for docs)
2. **Embed** — Each chunk gets a vector (local WASM or OpenAI)
3. **Store** — Chunks + vectors → SQLite, vectors → HNSW index
4. **Search** — Query → HNSW k-NN + BM25 keyword → RRF fusion → optional reranker
5. **Context** — Top results formatted as markdown for system prompts

---

## Testing

```bash
npm test                    # Unit tests (207 tests)
npm test -- --integration   # Full suite (includes real models + all domains)
npm test -- --filter code   # Filter by test name
npm test -- --verbose       # Show assertion details
```

---

## License

MIT

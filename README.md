# 🧠 BrainBank

**Persistent, searchable memory for AI agents.** Index your codebase, git history, documents, and any custom data into a single SQLite file — then search it all with hybrid vector + keyword retrieval.

BrainBank gives LLMs a long-term memory that persists between sessions.

- **All-in-one** — core + code + git + docs + CLI in a single `brainbank` package
- **Pluggable plugins** — `.use()` only what you need (code, git, docs, or custom)
- **Dynamic collections** — `brain.collection('errors')` for any structured data
- **Hybrid search** — vector + BM25 fused with Reciprocal Rank Fusion
- **Pluggable embeddings** — local WASM (free), OpenAI, or Perplexity (standard & contextualized)
- **Multi-repo** — index multiple repositories into one shared database
- **Portable** — single `.brainbank/brainbank.db` file
- **Optional packages** — [`@brainbank/memory`](#memory) (fact extraction + entity graph), [`@brainbank/mcp`](#mcp-server) (MCP server)
- **Optional reranker** — Qwen3-0.6B cross-encoder via `Qwen3Reranker` (opt-in)

![BrainBank Architecture](assets/architecture.png)

---

## Why BrainBank?

Built for a multi-repo codebase that needed unified AI context. Zero infrastructure, zero ongoing cost.

Most AI memory solutions (mem0, Zep, LangMem) require cloud services, external databases, or LLM calls just to store a memory. BrainBank takes a different approach:

| | **BrainBank** | **mem0** | **Zep** | **LangMem** |
|---|:---:|:---:|:---:|:---:|
| Infrastructure | **SQLite file** | Vector DB + cloud | Neo4j + cloud | LangGraph Platform |
| LLM required to write | **No**¹ | Yes | Yes | Yes |
| Code-aware | **19 AST-parsed languages (tree-sitter), git, co-edits** | ✗ | ✗ | ✗ |
| Custom plugins | **`.use()` plugin system** | ✗ | ✗ | ✗ |
| Search | **Vector + BM25 + RRF** | Vector + graph² | Vector + BM25 + graph | Vector only |
| Framework lock-in | **None** | Optional | Zep cloud | LangChain |
| Portable | **Copy one file** | Tied to DB | Tied to cloud | Tied to platform |

> ¹ mem0 and Zep use LLMs to auto-extract memories from raw text. BrainBank is explicit — you decide what gets stored. Less magic, more control.
>
> ² mem0's graph store (mem0g) is available in the paid platform version.

**In short:**
- **Code-first** — the only memory layer that understands code structure, git history, and file co-edit relationships
- **Framework-agnostic** — plain TypeScript, works with any agent framework (LangChain, Vercel AI SDK, custom) or none at all. Unopinionated — doesn't force you into a specific pattern
- **$0 memory bill** — no LLM calls to extract/consolidate. You store what you want, BrainBank embeds deterministically
- **Truly portable** — `.brainbank/brainbank.db` is a normal file. Copy it, back it up, `git lfs` it

### Table of Contents

- [Why BrainBank?](#why-brainbank)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [CLI](#cli)
- [Programmatic API](#programmatic-api)
  - [Plugins](#plugins)
  - [Collections](#collections)
  - [Search](#search)
  - [Document Collections](#document-collections)
  - [Context Generation](#context-generation)
  - [Custom Plugins](#custom-plugins)
  - [AI Agent Integration](#ai-agent-integration)
  - [Examples](#examples)
  - [Watch Mode](#watch-mode)
- [MCP Server](#mcp-server)
- [Configuration](#configuration)
  - [Embedding Providers](#embedding-providers)
  - [Reranker](#reranker)
- [Memory](#memory)
- [Multi-Repository Indexing](#multi-repository-indexing)
- [Indexing](#indexing-1)
  - [Incremental Indexing](#incremental-indexing)
  - [Re-embedding](#re-embedding)
- [Architecture](#architecture)
  - [Search Pipeline](#search-pipeline)
- [Benchmarks](#benchmarks)
  - [Search Quality: AST vs Sliding Window](#search-quality-ast-vs-sliding-window)
  - [Grammar Support](#grammar-support)
  - [RAG Retrieval Quality](#rag-retrieval-quality) · [Full Results →](./BENCHMARKS.md)

---

## Installation

```bash
npm install brainbank
```

### Optional Packages

| Package | When to install |
|---------|----------------|
| `@brainbank/memory` | Deterministic memory extraction + entity graph for LLM conversations |
| `@brainbank/mcp` | MCP server for AI tool integration |

```bash
# Memory — automatic fact extraction & dedup for chatbots/agents
npm install @brainbank/memory

# Reranker — built-in, install the runtime dependency to enable
npm install node-llama-cpp

# MCP server — for Antigravity, Claude Desktop, etc.
npm install @brainbank/mcp
```

### Tree-Sitter Grammars

BrainBank uses [tree-sitter](https://tree-sitter.github.io/) for AST-aware code chunking. **JavaScript and TypeScript grammars are included by default.** Other languages require installing the corresponding grammar package:

```bash
# Install only the grammars you need
npm install tree-sitter-python tree-sitter-go tree-sitter-rust
```

If you index a file whose grammar isn't installed, BrainBank will throw a clear error:

```
BrainBank: Grammar 'tree-sitter-python' is not installed. Run: npm install tree-sitter-python
```

<details>
<summary>All available grammars (19 languages)</summary>

| Category | Packages |
|----------|----------|
| **Included** | `tree-sitter-javascript`, `tree-sitter-typescript` |
| Web | `tree-sitter-html`, `tree-sitter-css` |
| Systems | `tree-sitter-go`, `tree-sitter-rust`, `tree-sitter-c`, `tree-sitter-cpp`, `tree-sitter-swift` |
| JVM | `tree-sitter-java`, `tree-sitter-kotlin`, `tree-sitter-scala` |
| Scripting | `tree-sitter-python`, `tree-sitter-ruby`, `tree-sitter-php`, `tree-sitter-lua`, `tree-sitter-bash`, `tree-sitter-elixir` |
| .NET | `tree-sitter-c-sharp` |

</details>

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

### Plugins

BrainBank uses pluggable plugins. Register only what you need with `.use()`:

| Plugin | Import | Description |
|---------|--------|-------------|
| `code` | `brainbank/code` | AST-aware code chunking via tree-sitter (19 languages) |
| `git` | `brainbank/git` | Git commit history, diffs, co-edit relationships |
| `docs` | `brainbank/docs` | Document collections (markdown, wikis) |

```typescript
import { BrainBank } from 'brainbank';
import { code } from 'brainbank/code';
import { git } from 'brainbank/git';
import { docs } from 'brainbank/docs';

// Pick only the plugins you need
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

Dynamic key-value collections with semantic search — the building block for agent memory:

```typescript
const decisions = brain.collection('decisions');

// Store rich content (auto-embedded for vector search)
await decisions.add(
  'Use SQLite with WAL mode instead of PostgreSQL. Portable single-file ' +
  'storage, works offline, zero infrastructure.',
  { tags: ['architecture'], metadata: { files: ['src/db.ts'] } }
);

// Semantic search — finds by meaning, not keywords
const hits = await decisions.search('why not postgres');
// → [{ content: 'Use SQLite with WAL...', score: 0.95, tags: [...], metadata: {...} }]

// Management
decisions.list({ limit: 20 });          // newest first
decisions.list({ tags: ['architecture'] }); // filter by tags
decisions.count();                      // total items
decisions.trim({ keep: 50 });           // keep N most recent
decisions.prune({ olderThan: '30d' });  // remove older than 30 days
brain.listCollectionNames();            // → ['decisions', ...]
```

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

### Custom Plugins

Implement the `Plugin` interface to build your own:

```typescript
import type { Plugin, PluginContext } from 'brainbank';

const myPlugin: Plugin = {
  name: 'custom',
  async initialize(ctx: PluginContext) {
    // ctx.db            — shared SQLite database
    // ctx.embedding     — shared embedding provider
    // ctx.collection()  — create dynamic collections
    const store = ctx.collection('my_data');
    await store.add('indexed content', { source: 'custom' });
  },
};

brain.use(myPlugin);
```

#### Using custom plugins with the CLI

Drop `.ts` files into `.brainbank/indexers/` — the CLI auto-discovers them:

```
.brainbank/
├── brainbank.db
└── indexers/
    ├── slack.ts
    └── jira.ts
```

Each file exports a default `Plugin`:

```typescript
// .brainbank/indexers/slack.ts
import type { Plugin } from 'brainbank';

export default {
  name: 'slack',
  async initialize(ctx) {
    const msgs = ctx.collection('slack_messages');
    // ... fetch and index slack messages
  },
} satisfies Plugin;
```

That's it — all CLI commands automatically pick up your plugins:

```bash
brainbank index                             # runs code + git + docs + slack + jira
brainbank stats                             # shows all plugins
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

Everything lives in `.brainbank/` — DB, config, and custom plugins:

```
.brainbank/
├── brainbank.db        # SQLite database (auto-created)
├── config.ts           # Optional project config
└── indexers/           # Optional custom plugin files
    ├── slack.ts
    └── jira.ts
```

No folder and no config file? The CLI uses the built-in plugins (`code`, `git`, `docs`).

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
// .brainbank/indexers/conversations.ts
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
| [rag](examples/rag/) | RAG chatbot — docs retrieval + generation | `OPENAI_API_KEY=sk-... PERPLEXITY_API_KEY=pplx-... npx tsx examples/rag/rag.ts --docs <path>` |
| [memory](examples/memory/) | Memory chatbot — fact extraction + entity graph | `OPENAI_API_KEY=sk-... npx tsx examples/memory/memory.ts` |
| [collection](examples/collection/) | Collections, semantic search, tags, metadata linking | `npx tsx examples/collection/collection.ts` |

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
- **Repo path** — from `repo` tool param > `BRAINBANK_REPO` env > `findRepoRoot(cwd)`
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

### Notes

The notes plugin gives your agent **persistent conversation memory** — store structured digests of past sessions and recall them via hybrid search.

```typescript
import { BrainBank } from 'brainbank';
import { notes } from 'brainbank/notes';

const brain = new BrainBank({ repoPath: '.' });
brain.use(notes());
await brain.initialize();

const notesPlugin = brain.plugin('notes');

// Store a conversation digest
await notesPlugin.remember({
  title: 'Refactored auth module',
  summary: 'Extracted JWT validation into middleware, added refresh token rotation',
  decisions: ['Use RS256 over HS256', 'Refresh tokens stored in httpOnly cookie'],
  filesChanged: ['src/auth/jwt.ts', 'src/middleware/auth.ts'],
  patterns: ['Always validate token expiry before DB lookup'],
  openQuestions: ['Should we add rate limiting to the refresh endpoint?'],
  tags: ['auth', 'security'],
});

// Recall relevant notes
const relevant = await notesPlugin.recall('JWT token validation', { k: 3 });

// List recent notes
const recent = notesPlugin.list(10);
const longTermOnly = notesPlugin.list(10, 'long');

// Consolidate: promote old short-term notes to long-term (keeps last 20 as short)
const { promoted } = notesPlugin.consolidate(20);
```

**Memory tiers:**
- **`short`** (default) — Full digest with all fields, kept for recent sessions
- **`long`** — Compressed: only title, summary, decisions, and patterns preserved. Files and open questions dropped

Consolidation automatically promotes notes beyond the keep window from `short` → `long`, reducing storage while preserving key learnings.

### Agent Memory (Patterns)

The memory plugin enables **learning from experience** — your agent records what worked (and what didn't) across tasks, then distills patterns into reusable strategies.

```typescript
import { BrainBank } from 'brainbank';
import { memory } from 'brainbank/memory';

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
| `BRAINBANK_REPO` | Default repository path (optional — auto-detected from `.git/` or passed per tool call) |
| `BRAINBANK_RERANKER` | Reranker: `none` (default), `qwen3` |
| `BRAINBANK_DEBUG` | Show full stack traces |
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

> Tree-sitter grammars are **optional dependencies**. If a grammar isn't installed, that language falls back to the generic sliding window. Install only the grammars you need: `npm install tree-sitter-ruby tree-sitter-go` etc.

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

## Benchmarks

BrainBank includes benchmark scripts to validate chunking quality and search relevance. Run them against your own codebase to see the impact.

### Search Quality: AST vs Sliding Window

We compared BrainBank's **tree-sitter AST chunker** against the traditional **sliding window** (80-line blocks) on a production NestJS backend (3,753 lines across 8 service files). Both strategies chunk the same files; all chunks are embedded and searched with the same 10 domain-specific queries.

#### How It Works

```
Sliding Window                          Tree-Sitter AST
┌────────────────────┐                  ┌────────────────────┐
│ import { ... }     │                  │ ✓ constructor()    │  → named chunk
│ @Injectable()      │  → L1-80 block   │ ✓ findAll()        │  → named chunk
│ class JobsService {│                  │ ✓ createJob()      │  → named chunk
│   constructor()    │                  │ ✓ cancelJob()      │  → named chunk
│   findAll() { ... }│                  │ ✓ updateStatus()   │  → named chunk
│   createJob()      │                  └────────────────────┘
│   ...              │
│ ────────────────── │  overlaps ↕
│   cancelJob()      │  → L75-155 block
│   updateStatus()   │
│   ...              │
└────────────────────┘
```

**Sliding window** mixes imports, constructors, and multiple methods into one embedding. Search for "cancel a job" and you get a generic block.
**AST chunking** gives each method its own embedding. Search for "cancel a job" → direct hit on `cancelJob()`.

#### Results (Production NestJS Backend — 3,753 lines)

Tested with 10 domain-specific queries on 8 service files (`orders.service.ts`, `bookings.service.ts`, `notifications.service.ts`, etc.):

| Metric | Sliding Window | Tree-Sitter AST |
|--------|:-:|:-:|
| **Query Wins** | 0/10 | **8/10** (2 ties) |
| **Top-1 Relevant** | 3/10 | **8/10** |
| **Avg Precision@3** | 1.1/3 | **1.7/3** |
| **Avg Score Delta** | — | **+0.035** |

#### Per-Query Breakdown

| Query | SW Top Result | AST Top Result | Δ Score |
|-------|:---:|:---:|:---:|
| cancel an order | generic `L451-458` | **`updateOrderStatus`** | +0.005 |
| create a booking | generic `L451-458` | **`createInstantBooking`** | +0.068 |
| confirm booking | generic `L451-458` | **`confirm`** | +0.034 |
| send notification | generic `L226-305` | **`publishNotificationEvent`** | +0.034 |
| authenticate JWT | generic `L1-80` | **`AuthModule`** | +0.032 |
| tenant DB connection | `L76-155` | **`onModuleDestroy`** | +0.037 |
| list orders paginated | `L76-155` | **`findAllActive`** | +0.045 |
| reject booking | generic `L451-458` | **`reject`** | +0.090 |

> Notice how the sliding window returns the **same generic block `L451-458`** for 4 different queries. The AST chunker returns a different, correctly named method each time.

#### Chunk Quality Comparison

| | Sliding Window | Tree-Sitter AST |
|---|:-:|:-:|
| Total chunks | 53 | **83** |
| Avg lines/chunk | 75 | **39** |
| Named chunks | 0 | **83** (100%) |
| Chunk types | `block` | `method`, `interface`, `class` |

### Grammar Support

All 9 core grammars verified, each parsing in **<0.05ms**:

| Language | AST Nodes Extracted | Parse Time |
|----------|:---:|:---:|
| TypeScript | `export_statement`, `interface_declaration` | 0.04ms |
| JavaScript | `function_declaration` × 3 | 0.04ms |
| Python | `class_definition`, `function_definition` × 2 | 0.03ms |
| Go | `function_declaration`, `method_declaration` × 3 | 0.04ms |
| Rust | `struct_item`, `impl_item`, `function_item` | 0.03ms |
| Ruby | `class`, `method` | 0.03ms |
| Java | `class_declaration` | 0.02ms |
| C | `function_definition` × 3 | 0.05ms |
| PHP | `class_declaration` | 0.03ms |

> Additional grammars available: C++, Swift, C#, Kotlin, Scala, Lua, Elixir, Bash, HTML, CSS

### RAG Retrieval Quality

BrainBank's hybrid search pipeline (Vector + BM25 → RRF) with Perplexity Context embeddings (2560d):

| Benchmark | Metric | Score |
|---|---|:---:|
| **BEIR SciFact** (5,183 docs, 300 queries) | NDCG@10 | **0.761** |
| **Custom semantic** (69 docs, 20 queries) | R@5 | **83%** |

The hybrid pipeline improved R@5 by **+26pp over vector-only** retrieval on our custom eval.

#### BrainBank vs QMD (Head-to-Head)

Compared against [QMD](https://github.com/tobi/qmd), a local-first search engine using GGUF models (embeddinggemma-300M + query expansion + reranker) — same corpus, same 20 queries:

| Metric | BrainBank + Reranker | QMD + Reranker |
|---|:---:|:---:|
| **R@5** | **83%** | 65% |
| **MRR** | **0.57** | 0.45 |
| **Misses** | **1/20** | 6/20 |

> BrainBank wins by +18pp R@5. QMD is competitive on semantic queries (81% vs 94%) and ties on broad queries (83% vs 83%) — impressive for a fully local pipeline with zero API calls.

See **[BENCHMARKS.md](./BENCHMARKS.md)** for full pipeline progression, per-technique impact, QMD comparison details, and reproduction instructions.

#### Running the RAG Eval

```bash
# Custom eval on your own docs
PERPLEXITY_API_KEY=pplx-... npx tsx test/benchmarks/rag/eval.ts --docs ~/path/to/docs

# BEIR standard benchmark
PERPLEXITY_API_KEY=pplx-... npx tsx test/benchmarks/rag/beir-eval.ts --dataset scifact
```

### Running Benchmarks

```bash
# Grammar support (9 languages, parse speed)
node test/benchmarks/grammar-support.mjs

# Search quality A/B (uses BrainBank's own source files)
node test/benchmarks/search-quality.mjs

# RAG retrieval quality (requires Perplexity API key + docs folder)
PERPLEXITY_API_KEY=pplx-... npx tsx test/benchmarks/rag/eval.ts --docs ~/path/to/docs
```

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
npm test                    # Unit tests (172 tests)
npm test -- --integration   # Full suite (includes real models + all domains)
npm test -- --filter code   # Filter by test name
npm test -- --verbose       # Show assertion details
```

---

## License

MIT

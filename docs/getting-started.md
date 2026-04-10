# Getting Started

Install BrainBank, index your first project, and run your first search.

## Installation

```bash
npm i -g brainbank                                         # core framework + CLI
npm i -g @brainbank/code @brainbank/git @brainbank/docs    # plugins you need
```

`brainbank` is the core framework with the CLI. Plugins are separate `@brainbank/*` packages — install only what you need. Each plugin declares `brainbank` as a peer dependency.

### Tree-Sitter Grammars

`@brainbank/code` bundles **5 grammars** out of the box: JavaScript, TypeScript (JSX/TSX), Python, and HTML. For additional languages, install individual `tree-sitter-*` packages globally:

```bash
npm i -g tree-sitter-go tree-sitter-rust
```

BrainBank auto-detects installed grammars at runtime. Missing grammars fall back to a sliding-window chunker (still functional, just less precise).

| Default (bundled) | Install separately |
|---|---|
| JavaScript | Go |
| TypeScript (JSX/TSX) | Rust |
| Python | C / C++ |
| HTML | Java / Kotlin / Scala |
| | Ruby / PHP / C# |
| | Swift / Lua / Bash / Elixir / CSS |

<details>
<summary>Install all remaining grammars at once</summary>

```bash
npm i -g tree-sitter-go tree-sitter-rust tree-sitter-c tree-sitter-cpp \
  tree-sitter-java tree-sitter-kotlin tree-sitter-scala tree-sitter-ruby \
  tree-sitter-php tree-sitter-c-sharp tree-sitter-swift tree-sitter-lua \
  tree-sitter-bash tree-sitter-elixir tree-sitter-css
```

</details>

---

## Quick Start (CLI)

```bash
brainbank index .                          # interactive: scan → select → index
brainbank hsearch "authentication"         # hybrid search (best quality)
brainbank search "auth middleware"         # vector search
brainbank ksearch "TypeError"             # keyword search (BM25, instant)
```

Store and retrieve agent knowledge:

```bash
brainbank kv add decisions "Use Redis for session storage"
brainbank kv search decisions "caching strategy"
```

Get formatted context for an LLM prompt:

```bash
brainbank context "add rate limiting to the auth API"
brainbank context "add rate limiting to the auth API" | pbcopy   # → clipboard
```

> **Zero config.** The CLI uses local embeddings (free, no API key) and all built-in plugins by default.

---

## Quick Start (Programmatic)

```typescript
import { BrainBank } from 'brainbank';
import { code } from '@brainbank/code';
import { git } from '@brainbank/git';
import { docs } from '@brainbank/docs';

const brain = new BrainBank({ repoPath: '.' })
  .use(code())
  .use(git())
  .use(docs());

// Auto-initializes; incremental — only processes changes
await brain.index();

// Hybrid search across everything: code + git + docs + KV
const results = await brain.hybridSearch('authentication middleware');
console.log(results.map(r => `[${r.type}] ${r.filePath ?? r.content.slice(0, 60)}`));

// Store agent knowledge in a KV collection
const log = brain.collection('decisions');
await log.add(
  'Switched from bcrypt to argon2id for password hashing. Argon2id is memory-hard.',
  { tags: ['security', 'auth'] }
);

// Recall later
const hits = await log.search('password hashing decision');
console.log(hits.map(h => h.content));

brain.close();
```

---

## BrainBank Config Resolution

On startup BrainBank resolves the embedding provider in this order:

1. `embeddingProvider` passed to constructor (highest priority)
2. `--embedding` CLI flag
3. `embedding` key in `.brainbank/config.json`
4. `BRAINBANK_EMBEDDING` environment variable
5. `provider_key` stored in the database from a previous run
6. Local WASM model (default, free, offline)

---

## First Search Walkthrough

### 1. Index your project

```bash
cd ~/my-project
brainbank index .
```

BrainBank runs a **3-phase interactive flow**: scan → select → index.

**Phase 1 — Scan** (no BrainBank init required, instant):

```
━━━ BrainBank Scan ━━━
  Repo: /Users/you/my-project

  📁 Code — 342 files (3 languages)
     ├── TypeScript     189 files
     ├── JavaScript      87 files
     └── Python          66 files

  📜 Git — 1,204 commits (depth: 500)
     Last: fix null check in auth (2 hours ago)

  📄 Docs — no documents found

  💾 DB: new (first index)
```

**Phase 2 — Select** (interactive checkboxes):

```
  Select modules to index:
  ◉ Code  — 342 files (3 languages)
  ◉ Git   — 1,204 commits
  ◯ Docs  — no documents found (disabled)
```

If no `.brainbank/config.json` exists, BrainBank offers to generate one from your selection, including embedding provider choice (`perplexity-context`, `perplexity`, `openai`, or `local`).

**Phase 3 — Index**:

```
━━━ Indexing: code, git ━━━
  CODE [150/342] src/auth/middleware.ts

  Code: 342 indexed, 0 skipped, 891 chunks
  Git:  500 indexed, 0 skipped
```

> Use `--yes` to skip the interactive prompt and auto-select all available modules.

### 2. Search for code

```bash
brainbank hsearch "rate limiting middleware"
```

Returns results ranked by relevance with file paths, line numbers, and scores.

### 3. Get formatted context for an LLM

```bash
brainbank context "add rate limiting to the API"
```

Returns a **Workflow Trace** — formatted markdown with:
- Relevant code blocks with `called by` annotations
- Full call tree (depth-configurable)
- Related git history with diff snippets
- Co-edit patterns (files that tend to change together)
- Relevant docs from registered collections

---

## Project Structure Created

After first index, BrainBank creates:

```
.brainbank/
├── config.json              # generated by interactive setup (optional)
└── data/
    ├── brainbank.db         # SQLite database (all indexed data)
    ├── hnsw-kv.index        # HNSW graph for KV collections
    ├── hnsw-code.index      # HNSW graph for code vectors
    ├── hnsw-git.index       # HNSW graph for git commit vectors
    └── hnsw-docs.index      # HNSW graph for document vectors
```

Add `.brainbank/data/` to `.gitignore` — generated files, not for version control.

---

## What's Next?

| Topic | Guide |
|-------|-------|
| Full command reference | [CLI Reference](cli.md) |
| Programmatic search modes | [Search](search.md) |
| Store custom data | [Collections](collections.md) |
| Build your own plugin | [Custom Plugins](custom-plugins.md) |
| Configure embeddings | [Embeddings & Reranker](embeddings.md) |
| MCP integration | [MCP Server](mcp.md) |
| Multi-repo indexing | [Multi-Repo](multi-repo.md) |
| Local development setup | [Local Development](local-development.md) |

# Getting Started

Install BrainBank, index your first project, and run your first search.

## Installation

```bash
npm i -g brainbank                                         # core framework + CLI
npm i -g @brainbank/code @brainbank/git @brainbank/docs    # plugins you need
```

`brainbank` is the core framework with the CLI. Plugins are separate `@brainbank/*` packages — install only what you need. Each plugin has `brainbank` as a peer dependency.

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
<summary>Install all 16 remaining grammars at once</summary>

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
brainbank index .                          # index code + git history
brainbank hsearch "authentication"         # hybrid search (best quality)
brainbank search "auth middleware"         # vector search
brainbank ksearch "TypeError"             # keyword search (BM25)
```

Store and retrieve agent memory:

```bash
brainbank kv add decisions "Use Redis for session storage"
brainbank kv search decisions "caching strategy"
```

> **Zero config.** The CLI uses local embeddings (free, no API key) and all built-in plugins by default.

---

## Quick Start (Programmatic)

```typescript
import { BrainBank } from 'brainbank';
import { code } from '@brainbank/code';
import { git } from '@brainbank/git';

const brain = new BrainBank({ repoPath: '.' })
  .use(code())
  .use(git());

await brain.index();  // incremental — only processes changes

// Search across everything
const results = await brain.hybridSearch('authentication middleware');
console.log(results.map(r => `${r.filePath}:L${r.metadata?.startLine} (${r.score.toFixed(2)})`));

// Store agent memory
const log = brain.collection('decisions');
await log.add(
  'Switched from bcrypt to argon2id for password hashing. ' +
  'Argon2id is memory-hard and recommended by OWASP.',
  { tags: ['security', 'auth'] }
);

// Recall later
const hits = await log.search('password hashing decision');

brain.close();
```

---

## First Search Walkthrough

### 1. Index your project

```bash
cd ~/my-project
brainbank index .
```

BrainBank scans your repo first, then shows an interactive prompt:

```
━━━ BrainBank Scan ━━━
  Repo: /Users/you/my-project

  📁 Code — 342 files (3 languages)
     ├── TypeScript     189 files
     ├── JavaScript      87 files
     └── Python          66 files

  📜 Git — 1,204 commits (depth: 500)
     Last: fix null check in auth (2 hours ago)

  💾 DB: new (first index)

  Select modules to index:
  ◉ Code  — 342 files (3 languages)
  ◉ Git   — 1,204 commits
  ◯ Docs  — no documents found
```

Select what to index and the results appear:

```
━━━ Indexing: code, git ━━━
  Code: 342 indexed, 891 chunks
  Git:  500 indexed
  Co-edit pairs: 423
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

Returns markdown with relevant code, import graphs, git history, and co-edit patterns — ready for system prompt injection.

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

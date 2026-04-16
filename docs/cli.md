# CLI Reference

BrainBank can be used entirely from the command line — no config file needed.

## Commands

| Command | Description |
|---------|-------------|
| [`index`](#index) | Index code + git history |
| [`search`](#search) | Semantic search (vector) |
| [`hsearch`](#search) | Hybrid search (best quality) |
| [`ksearch`](#search) | Keyword search (BM25, instant) |
| [`dsearch`](#search) | Document search |
| [`context`](#context) | Formatted context for LLM prompts |
| [`files`](#files) | View full indexed files directly |
| [`kv`](#kv-store) | Dynamic collection operations |
| [`collection`](#document-collections) | Manage document collections |
| [`docs`](#document-collections) | Index document collections |
| [`stats`](#utility) | Show index statistics |
| [`reembed`](#utility) | Re-embed all vectors |
| [`watch`](#watch-mode) | Auto re-index on changes (plugin-driven) |
| [`mcp`](#utility) | Start MCP server (stdio) |
| [`mcp:export`](#mcp-export) | Generate MCP config for AI IDEs |
| [`daemon`](#http-daemon) | Start HTTP daemon |
| [`status`](#http-daemon) | Show daemon status |

---

## Index

`brainbank index` uses a **3-phase interactive flow**: scan → select → index.

### Phase 1: Scan

Scans the repo without initializing BrainBank and shows a summary tree — code files by language, git commits, docs collections, config status, and DB state:

```
━━━ BrainBank Scan ━━━
  Repo: /Users/you/my-project

  📁 Code — 342 files (5 languages)
     ├── TypeScript     189 files
     ├── JavaScript      87 files
     ├── Python          41 files
     ├── HTML            15 files
     └── CSS             10 files

  📜 Git — 1,204 commits (depth: 500)
     Last: fix auth middleware (2 hours ago)

  📄 Docs — 2 collections (23 files)
     ├── docs       → ./docs (18 files)
     └── wiki       → ~/team-wiki (5 files)

  ⚙️  Config: .brainbank/config.json ✓
  💾 DB: 12.3 MB, last indexed 2h ago
```

### Phase 2: Select

Interactive checkboxes (via `@inquirer/prompts`) to choose which modules to index. Modules with no content are shown as disabled:

```
  Select modules to index:
  ◉ Code  — 342 files (5 languages)
  ◉ Git   — 1,204 commits
  ◉ Docs  — 2 collections (23 files)
```

If no `.brainbank/config.json` exists, BrainBank offers to generate one from your selection (including embedding provider choice: `perplexity-context`, `perplexity`, `openai`, or `local`) and pruner selection.

### Phase 3: Index

Runs the selected modules with live progress output:

```
━━━ Indexing: code, git, docs ━━━
  CODE [150/342] src/auth/middleware.ts

  Code: 342 indexed, 0 skipped, 891 chunks
  Git:  500 indexed, 704 skipped
```

### Flags

```bash
brainbank index [path]                      # Interactive scan → select → index
brainbank index [path] --yes                # Skip prompts (auto-select all available)
brainbank index [path] --only code          # Skip selection, index only code
brainbank index [path] --only code,git      # Skip selection, index code + git
brainbank index [path] --force              # Force re-index everything
brainbank index [path] --depth 200          # Limit git commit depth
brainbank index [path] --docs ~/docs        # Include a docs folder
brainbank index [path] --ignore "sdk/**,vendor/**"  # Custom ignore patterns
```

> **Multi-repo:** If `[path]` contains multiple Git subdirectories (no root `.git/`), BrainBank auto-detects them and indexes all into one shared DB. See [Multi-Repo](multi-repo.md).

---

## Search

```bash
brainbank search <query>                    # Semantic search (vector)
brainbank hsearch <query>                   # Hybrid search (best quality)
brainbank ksearch <query>                   # Keyword search (BM25, instant)
brainbank dsearch <query>                   # Document search
```

### Source Filtering

All search commands accept `--<source> <n>` to control how many results come from each source. Set to `0` to skip a source entirely:

```bash
brainbank hsearch "auth" --code 0 --git 10           # git commits only
brainbank hsearch "auth" --code 10 --git 0           # code only
brainbank search "handler" --git 0                   # code only (vector)
brainbank ksearch "bugfix" --code 0                  # git only (keyword)
brainbank hsearch "auth" --code 3 --git 3            # balanced mix
brainbank hsearch "api" --docs 10 --code 0 --git 0   # docs only
brainbank hsearch "bug" --notes 5 --git 3            # custom plugin + git
```

Any `--<name> <number>` flag not in the known non-source list (`--repo`, `--depth`, `--collection`, `--pattern`, `--context`, `--name`, `--keep`, `--reranker`, `--pruner`, `--only`, `--docs`, `--mode`, `--limit`, `--ignore`, `--meta`, `--k`, `--yes`, `--force`, `--verbose`) is treated as a source filter. Source names that don't match a registered plugin are routed to KV collections.

Results are filtered to a minimum score of 70% and capped at 20 results in the CLI output.

---

## Context

Get formatted markdown context for a task, ready for system prompt injection:

```bash
brainbank context <task>                    # Get formatted context for a task
brainbank context <task> --pruner haiku     # With LLM noise filter
brainbank context add <col> <path> <desc>   # Add context metadata for a path
brainbank context list                      # List all context metadata entries
```

### Path Scoping & Exclusion

```bash
brainbank context "auth flow" --path src/auth/       # Only files under src/auth/
brainbank context "auth flow" --ignore src/tests/     # Exclude test files
brainbank context "auth flow" --ignore src/tests/,src/mocks/  # Exclude multiple paths
brainbank context "auth flow" --ignore src/tests/ --ignore vendor/  # Repeated flags
```

`--ignore` accepts comma-separated values or repeated flags. Results whose `filePath` starts with any prefix are excluded from the context output.

### BrainBankQL Context Field Flags

The `context` command supports field flags directly on the command line:

```bash
brainbank context "auth flow" --lines                 # Show source line numbers
brainbank context "auth flow" --symbols               # Append symbol index
brainbank context "auth flow" --compact               # Signatures only
brainbank context "auth flow" --no-callTree           # Disable call tree
brainbank context "auth flow" --callTree.depth=2      # Custom call tree depth
brainbank context "auth flow" --no-imports            # Skip dependency summary
brainbank context "auth flow" --expander              # LLM context expansion
```

---

## Files

Fetch full indexed file contents directly — bypasses search entirely:

```bash
brainbank files <path|glob> [...paths] [--lines]
```

Supports 4 resolution modes:

```bash
brainbank files src/auth/login.ts           # Exact path
brainbank files src/graph/                  # All files under directory (trailing /)
brainbank files "src/**/*.service.ts"       # Glob pattern
brainbank files plugin.ts                   # Fuzzy basename match
brainbank files src/auth/ --lines           # With source line numbers
```

> Use `brainbank files` after `brainbank context` to view the complete content of files identified by search.

---

## KV Store

Dynamic collections for storing any data — agent memories, decisions, error logs:

```bash
brainbank kv add <coll> <content>           # Add item to a collection
brainbank kv search <coll> <query>          # Search a collection
brainbank kv list [coll]                    # List collections or items in a collection
brainbank kv trim <coll> --keep <n>         # Keep only N most recent items
brainbank kv clear <coll>                   # Clear all items in a collection
```

### Examples

```bash
# Store architecture decisions
brainbank kv add decisions "ADR: Fastify over Express. 2x throughput, schema validation."

# Search past decisions
brainbank kv search decisions "which web framework"

# Search modes: --mode hybrid (default), keyword, vector
brainbank kv search decisions "caching" --mode keyword

# Lifecycle management
brainbank kv trim decisions --keep 50       # keep 50 most recent
brainbank kv list                           # list all collection names + counts
brainbank kv list decisions                 # list items (--limit <n>, default 20)
```

---

## Document Collections

Register and manage folders of documents:

```bash
brainbank collection add <path> --name <name>  # Register a document folder
brainbank collection add <path> --name <name> --pattern "**/*.md" --ignore "drafts/**" --context "desc"
brainbank collection list                       # List registered collections
brainbank collection remove <name>              # Remove a collection
brainbank docs [--collection <name>]            # Index document collections
```

### dsearch

```bash
brainbank dsearch <query>
brainbank dsearch <query> --collection wiki     # Filter to specific collection
brainbank dsearch <query> --k 10               # Max results (default: 8)
```

---

## Watch Mode

Auto-re-index when plugins detect changes:

```bash
brainbank watch
```

Output:

```
━━━ BrainBank Watch ━━━
  Watching /path/to/repo for changes...
  14:30:02 ✓ code: src/api.ts
  14:30:05 ✓ code: src/routes.ts
```

Watch mode delegates watching to each plugin. Plugins that implement `WatchablePlugin` drive their own watching (e.g. `fs.watch` for file-based plugins, API polling, or webhooks). The core applies per-plugin debounce (default: 2 seconds) and coordinates re-indexing.

---

## HTTP Daemon

BrainBank includes a lightweight HTTP daemon that keeps models and indexes hot in memory. When the daemon is running, CLI `context` commands auto-delegate to it — skipping the cold-start cost of loading embeddings and HNSW indices.

### Start / Stop

```bash
brainbank daemon                            # Start daemon (foreground)
brainbank daemon start                      # Start daemon (background)
brainbank daemon start --port 9090          # Custom port (default: 8181)
brainbank daemon stop                       # Stop background daemon
brainbank daemon restart                    # Stop + start
brainbank status                            # Show daemon state
```

### How Delegation Works

When you run `brainbank context "task"`, the CLI:

1. Checks if an HTTP server is running (via PID file at `~/.cache/brainbank/server.pid`)
2. If running → sends the query to `POST http://localhost:<port>/context` → prints the result
3. If not running → falls back to local mode (loads models, queries, then exits)

### Multi-Repo

A single server handles all repos. The `--repo` flag in each CLI call selects the workspace:

```bash
brainbank context "auth flow" --repo ~/aurora     # loads aurora workspace
brainbank context "search bug" --repo ~/drift     # loads drift workspace
```

Workspaces are cached in memory with a 30-minute TTL.

### HTTP API

| Method | Path | Body | Description |
|--------|------|------|-------------|
| `GET` | `/health` | — | Server status (pid, port, uptime, workspaces) |
| `POST` | `/context` | `{ task, repo?, sources?, pathPrefix? }` | Get formatted context |
| `POST` | `/index` | `{ repo?, forceReindex? }` | Trigger re-indexing |

> **Note:** The HTTP server is a core brainbank feature — no `@brainbank/mcp` dependency required.

---

## Utility

```bash
brainbank stats                             # Show index statistics
brainbank reembed                           # Re-embed all vectors (after provider switch)
brainbank mcp                               # Start MCP server (stdio, requires @brainbank/mcp)
```

---

## MCP Export

Auto-generate MCP server config for AI IDEs:

```bash
brainbank mcp:export antigravity            # Google Antigravity
brainbank mcp:export cursor                 # Cursor
brainbank mcp:export claude                 # Claude Desktop
```

`mcp:export` resolves:
- **Node binary** — absolute path to the current `node` executable
- **`cli.js` path** — from global install or local `npm link`
- **API keys** — from `.brainbank/config.json` `keys` section or env vars
- **`BRAINBANK_REPO`** — injects the repo root into the MCP config env

For Antigravity, it also appends a concise BrainBank section to `~/.gemini/GEMINI.md` with agent instructions (paste-output workflow, source filtering rules, repo requirement).

Existing MCP entries are preserved — the command only adds/overwrites the `brainbank` server entry.

---

## Global Options

| Option | Description |
|--------|-------------|
| `--repo <path>` | Repository path (default: `.`) |
| `--force` | Force re-index everything |
| `--depth <n>` | Git commit depth (default: 500) |
| `--<source> <n>` | Source filter (e.g. `--code 10 --git 0`) |
| `--ignore <globs>` | Glob patterns to exclude (comma-separated) |
| `--collection <name>` | Target collection |
| `--pattern <glob>` | File pattern for docs (default: `**/*.md`) |
| `--context <desc>` | Context description |
| `--reranker <name>` | Reranker (`qwen3`) |
| `--pruner <name>` | LLM noise filter (`haiku`) — drops irrelevant results before formatting |
| `--embedding <key>` | Embedding provider (`local`, `openai`, `perplexity`, `perplexity-context`) |
| `--port <n>` | HTTP server port (default: `8181`) |
| `--yes` / `--y` | Skip interactive prompts (auto-select all available) |

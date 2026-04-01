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
| [`kv`](#kv-store) | Dynamic collection operations |
| [`collection`](#document-collections) | Manage document collections |
| [`docs`](#document-collections) | Index document collections |
| [`stats`](#utility) | Show index statistics |
| [`reembed`](#utility) | Re-embed all vectors |
| [`watch`](#watch-mode) | Auto re-index on file changes |
| [`serve`](#utility) | Start MCP server (stdio) |

---

## Index

`brainbank index` uses a **3-phase interactive flow**: scan → select → index.

### Phase 1: Scan

Scans the repo and shows a summary tree — code files by language, git commits, docs collections, config status, and DB state:

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

Interactive checkboxes to choose which modules to index:

```
  Select modules to index:
  ◉ Code  — 342 files (5 languages)
  ◉ Git   — 1,204 commits
  ◉ Docs  — 2 collections (23 files)
```

If no `.brainbank/config.json` exists, BrainBank offers to generate one from your selection (including embedding provider choice).

### Phase 3: Index

Runs the selected modules, showing progress:

```
━━━ Indexing: code, git, docs ━━━
  CODE [150/342] src/auth/middleware.ts

  Code: 342 indexed, 0 skipped, 891 chunks
  Git:  500 indexed, 704 skipped
  Docs: [docs] 18 indexed, 0 skipped, 45 chunks
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

Any `--<name> <number>` flag not in the known non-source flags (`--repo`, `--depth`, `--collection`, `--pattern`, `--context`, `--name`, `--keep`, `--reranker`, `--only`, `--docs-path`, `--mode`, `--limit`, `--ignore`, `--meta`, `--k`, `--yes`, `--force`, `--verbose`) is treated as a source filter.

---

## Context

Get formatted markdown context for a task, ready for system prompt injection:

```bash
brainbank context <task>                    # Get formatted context for a task
brainbank context add <col> <path> <desc>   # Add context metadata
brainbank context list                      # List context metadata
```

---

## KV Store

Dynamic collections for storing any data — agent memories, decisions, error logs:

```bash
brainbank kv add <coll> <content>           # Add item to a collection
brainbank kv search <coll> <query>          # Search a collection
brainbank kv list [coll]                    # List collections or items
brainbank kv trim <coll> --keep <n>         # Keep only N most recent
brainbank kv clear <coll>                   # Clear all items
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
brainbank kv list                           # list all collections
brainbank kv list decisions                 # list items in a collection
```

---

## Document Collections

Register and manage folders of documents:

```bash
brainbank collection add <path> --name docs # Register a document folder
brainbank collection list                   # List registered collections
brainbank collection remove <name>          # Remove a collection
brainbank docs [--collection <name>]        # Index document collections
```

---

## Watch Mode

Auto-re-index code files when they change:

```bash
brainbank watch
```

Output:

```
━━━ BrainBank Watch ━━━
  Watching /path/to/repo for changes...
  14:30:02 ✓ code: src/api.ts
  14:30:05 ✓ code: src/routes.ts
  14:30:08 ✓ csv: data/metrics.csv       ← custom plugin
```

> Watch mode monitors **code files** by default. Custom plugins that implement `watchPatterns()` and `onFileChange()` are automatically picked up. Git history and document collections must be re-indexed explicitly with `brainbank index` / `brainbank docs`.

---

## Utility

```bash
brainbank stats                             # Show index statistics
brainbank reembed                           # Re-embed all vectors (provider switch)
brainbank serve                             # Start MCP server (stdio)
```

---

## Global Options

| Option | Description |
|--------|-------------|
| `--repo <path>` | Repository path |
| `--force` | Force re-index everything |
| `--depth <n>` | Git commit depth |
| `--<source> <n>` | Source filter (e.g. `--code 10 --git 0`) |
| `--ignore <globs>` | Glob patterns to exclude (comma-separated) |
| `--collection <name>` | Target collection |
| `--pattern <glob>` | File pattern for docs |
| `--context <desc>` | Context description |
| `--reranker <name>` | Reranker (`qwen3` or `none`) |
| `--embedding <key>` | Embedding provider (`local`, `openai`, `perplexity`, `perplexity-context`) |
| `--yes` / `-y` | Skip interactive prompts |

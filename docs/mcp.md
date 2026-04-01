# MCP Server

BrainBank ships with an MCP server (stdio) for AI tool integration — Antigravity, Claude Desktop, Cursor, and any MCP-compatible client.

## Setup

### Antigravity

Add to `~/.gemini/antigravity/mcp_config.json`:

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

### Claude Desktop

Add to Claude Desktop settings → Developer → MCP Servers:

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

### Cursor

Add to `.cursor/mcp.json` in your project:

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

### CLI (standalone)

```bash
brainbank serve
```

---

## Zero-Config

The MCP server auto-detects everything:

- **Repo path** — from `repo` tool param > `BRAINBANK_REPO` env > `findRepoRoot(cwd)` (walks up looking for `.git/`)
- **Embedding provider** — from `.brainbank/config.json` > `BRAINBANK_EMBEDDING` env > `provider_key` stored in DB > falls back to local
- **Plugins** — reads `plugins` array from `config.json` (default: `['code', 'git', 'docs']`)
- **Ignore patterns** — reads `code.ignore` from `config.json`

> Index your repo once with the CLI to set up the embedding provider:
> ```bash
> brainbank index .   # interactive — prompts for modules and embedding provider
> ```
> The selection is saved to `.brainbank/config.json`. After that, the MCP server auto-resolves the correct provider — no env vars needed.

---

## Available Tools

| Tool | Description |
|------|-------------|
| `brainbank_search` | Unified search — `mode: hybrid` (default), `vector`, or `keyword`. Supports `codeK`, `gitK`, `minScore`, and dynamic `collections` map. |
| `brainbank_context` | Formatted context block for a task (code + git + co-edits + docs). Options: `affectedFiles`, `codeResults`, `gitResults`. |
| `brainbank_index` | Trigger incremental code/git/docs indexing. Options: `modules`, `docsPath`, `forceReindex`, `gitDepth`. |
| `brainbank_stats` | Index statistics (files, commits, chunks, KV collections). |
| `brainbank_history` | Git history for a specific file. Options: `filePath`, `limit`. |
| `brainbank_collection` | KV collection ops — `action: add` (with metadata), `search` (with k), or `trim` (with keep). |

---

## Multi-Workspace

The MCP server maintains a **pool of BrainBank instances** — one per unique `repo` path (LRU, max 10):

```typescript
// Agent working in one workspace
brainbank_search({ query: "login form", repo: "/Users/you/project-a" })

// Agent switches to another project — new instance auto-created
brainbank_search({ query: "API routes", repo: "/Users/you/project-b" })
```

Instances are cached in memory after first initialization (~480ms). Health checks detect stale instances (HNSW empty but DB >100KB) and evict them for re-creation.

---

## Environment Variables

All optional — the server works without any env vars.

| Variable | Description | Default |
|----------|-------------|------------|
| `BRAINBANK_REPO` | Fallback repo path (if `repo` param not provided and no `.git/` found) | auto-detect from cwd |
| `BRAINBANK_EMBEDDING` | Embedding provider key: `local`, `openai`, `perplexity`, `perplexity-context` | from `config.json` or DB |
| `BRAINBANK_RERANKER` | Reranker: `none`, `qwen3` | `none` |
| `OPENAI_API_KEY` | Required when embedding provider is `openai` | — |
| `PERPLEXITY_API_KEY` | Required when embedding provider is `perplexity` or `perplexity-context` | — |

---

## AI Agent Integration

Teach your AI coding agent to use BrainBank as persistent memory. Add an `AGENTS.md` (or `.cursor/rules`) to your project root:

<details>
<summary><strong>Option A: CLI commands</strong> (zero setup)</summary>

> **Memory — BrainBank**
>
> **Store** a conversation summary after each task:
> `brainbank kv add conversations "Refactored auth to AuthService with DI."`
>
> **Record** architecture decisions:
> `brainbank kv add decisions "ADR: Fastify over Express. 2x throughput."`
>
> **Search** before starting work:
> `brainbank hsearch "auth middleware"` · `brainbank kv search decisions "auth"`

</details>

<details>
<summary><strong>Option B: MCP tools</strong> (richer integration)</summary>

> **Memory — BrainBank (MCP)**
>
> **Store** via `brainbank_collection`:
> `{ action: "add", collection: "conversations", content: "Refactored auth.", metadata: { tags: ["auth"] } }`
>
> **Search** via `brainbank_collection`:
> `{ action: "search", collection: "decisions", query: "authentication approach" }`
>
> **Code search** via `brainbank_search`:
> `{ query: "auth middleware", repo: "." }`

</details>

| Agent | How to connect |
|-------|---------------|
| **Antigravity** | Add `AGENTS.md` to project root |
| **Claude Code** | Add `AGENTS.md` to project root |
| **Cursor** | Add rules in `.cursor/rules` |
| **MCP** (any agent) | JSON config above |

---

## How It Works

```
AI Agent  ←→  stdio  ←→  @brainbank/mcp  ←→  BrainBank core  ←→  SQLite
```

1. Agent sends an MCP tool call (e.g., `brainbank_search`)
2. Server resolves the `repo` param → gets/creates a BrainBank instance from the pool
3. BrainBank executes against its local SQLite database
4. Results returned as structured markdown text to the agent

### Corruption Recovery

If `initialize()` fails with `Invalid the given array length` (corrupted DB), the server auto-deletes the DB file and retries with a fresh instance.

---

## See Also

- [Multi-Repo](multi-repo.md) — multi-workspace indexing
- [Configuration](config.md) — embedding config
- [packages/mcp/README.md](../packages/mcp/README.md) — package-level docs

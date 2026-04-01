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
- **Plugins** — reads `plugins` array from `config.json` (default: `['code', 'git', 'docs']`). Plugins are loaded dynamically by the core factory — the MCP server has no hardcoded plugin imports
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
| `brainbank_workspaces` | Pool observability — `action: list`, `evict`, or `stats`. Shows loaded workspaces, memory usage, last access time, and active operations. |

---

## Multi-Workspace

The MCP server manages a **`WorkspacePool`** of BrainBank instances — one per unique `repo` path. The pool uses **memory-pressure eviction** (configurable max memory, default 2GB) and **TTL eviction** (configurable idle timeout, default 30 minutes) instead of an arbitrary fixed count:

```typescript
// Agent working in one workspace
brainbank_search({ query: "login form", repo: "/Users/you/project-a" })

// Agent switches to another project — new instance auto-created
brainbank_search({ query: "API routes", repo: "/Users/you/project-b" })
```

Instances are cached in memory after first initialization (~480ms). On each request, the server calls `brain.ensureFresh()` to detect whether another process (e.g. a CLI `brainbank index`) has updated the HNSW indices since the pool entry was created. Stale indices are hot-reloaded from disk automatically — no server restart needed.

Active operations are tracked — the pool never evicts a workspace that has an in-flight query or indexing operation.

### Pool Observability

Use the `brainbank_workspaces` tool to monitor pool state:

```
brainbank_workspaces({ action: "list" })
→ Shows each workspace, its memory usage, last access time, and active ops

brainbank_workspaces({ action: "evict", repo: "/path/to/project" })
→ Force-evicts a workspace from the pool

brainbank_workspaces({ action: "stats" })
→ Total pool memory usage and configuration
```

---

## Environment Variables

All optional — the server works without any env vars.

| Variable | Description | Default |
|----------|-------------|--------|
| `BRAINBANK_REPO` | Fallback repo path (if `repo` param not provided and no `.git/` found) | auto-detect from cwd |
| `BRAINBANK_EMBEDDING` | Embedding provider key: `local`, `openai`, `perplexity`, `perplexity-context` | from `config.json` or DB |
| `BRAINBANK_RERANKER` | Reranker: `none`, `qwen3` | `none` |
| `BRAINBANK_MAX_MEMORY_MB` | Maximum total pool memory in MB | `2048` |
| `BRAINBANK_TTL_MINUTES` | Idle workspace eviction timeout in minutes | `30` |
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
2. `WorkspacePool` resolves `repo` → gets/creates a BrainBank instance from the pool
3. Pool tracks the active operation to prevent mid-query eviction
4. BrainBank calls `ensureFresh()` → hot-reloads stale HNSW if needed
5. BrainBank executes against its local SQLite database
6. Results returned as structured markdown text to the agent

### Architecture

```
@brainbank/mcp
├── mcp-server.ts          ← MCP stdio server (7 tools)
├── workspace-pool.ts      ← Memory-pressure + TTL eviction, active-op tracking
└── workspace-factory.ts   ← Delegates to core createBrain() — no plugin hardcoding
```

The MCP server imports `createBrain()` from the core `brainbank` package. Plugin packages (`@brainbank/code`, `@brainbank/git`, `@brainbank/docs`) are optional `peerDependencies` — they are discovered and loaded dynamically by the core factory, not imported directly by the MCP server.

### Corruption Recovery

If `initialize()` fails with `Invalid the given array length` (corrupted DB), the server auto-deletes the DB file and retries with a fresh instance.

---

## See Also

- [Multi-Repo](multi-repo.md) — multi-workspace indexing
- [Configuration](config.md) — embedding config
- [packages/mcp/README.md](../packages/mcp/README.md) — package-level docs

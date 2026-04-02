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
- **Plugins** — reads `plugins` array from `config.json` (default: `['code']`). Plugins are loaded dynamically by the core factory — no hardcoded imports
- **Ignore patterns** — reads `code.ignore` from `config.json`

> Index your repo once with the CLI:
> ```bash
> brainbank index . --yes
> ```
> The selection is saved to `.brainbank/config.json`. After that, the MCP server auto-resolves the correct provider — no env vars needed.

---

## Tool: `brainbank_context`

The server exposes a **single tool**: `brainbank_context`.

```typescript
brainbank_context({
  task: string,              // what you're trying to understand or implement
  affectedFiles?: string[],  // files you plan to modify (improves co-edit suggestions)
  codeResults?: number,      // max code results (default: 6)
  gitResults?: number,       // max git commit results (default: 5)
  repo?: string,             // repository path (default: auto-detect)
})
```

Returns a **Workflow Trace** — a single flat `## Code Context` section with:
- **Search hits** with `% match` scores
- **Full call tree** (3 levels deep) with `called by` annotations
- **Part adjacency boost** — multi-part functions shown complete (no gaps)
- **Trivial wrapper collapse** — delegation functions shown as one-liners
- **Test file filtering** — `test/`, `tests/`, `__tests__`, `.spec.`, `.test.` excluded
- All source code included — **no trimming, no truncation**

If the project is **not indexed**, the tool returns an error with the CLI command to run.

### `brainbank_index`

A secondary tool for re-indexing from the AI agent. Requires `.brainbank/config.json` to exist.

```typescript
brainbank_index({
  forceReindex?: boolean,  // force full re-index (default: false)
  repo?: string,           // repository path (default: auto-detect)
})
```

---

## Multi-Workspace

The MCP server manages a **`WorkspacePool`** of BrainBank instances — one per unique `repo` path. The pool uses **memory-pressure eviction** (configurable max memory, default 2GB) and **TTL eviction** (configurable idle timeout, default 30 minutes):

```typescript
brainbank_context({ task: "login flow", repo: "/project-a" })
brainbank_context({ task: "API routes", repo: "/project-b" })
```

Instances are cached in memory after first initialization (~480ms). On each request, the server calls `brain.ensureFresh()` to detect whether another process (e.g. a CLI `brainbank index`) has updated the HNSW indices. Stale indices are hot-reloaded automatically.

Active operations are tracked — the pool never evicts a workspace with in-flight queries.

---

## Environment Variables

All optional — the server works without any env vars.

| Variable | Description | Default |
|----------|-------------|--------|
| `BRAINBANK_REPO` | Fallback repo path | auto-detect from cwd |
| `BRAINBANK_EMBEDDING` | Embedding provider key: `local`, `openai`, `perplexity`, `perplexity-context` | from `config.json` or DB |
| `BRAINBANK_MAX_MEMORY_MB` | Maximum total pool memory in MB | `2048` |
| `BRAINBANK_TTL_MINUTES` | Idle workspace eviction timeout in minutes | `30` |
| `OPENAI_API_KEY` | Required when embedding provider is `openai` | — |
| `PERPLEXITY_API_KEY` | Required when embedding provider is `perplexity` / `perplexity-context` | — |

---

## AI Agent Integration

Configure your AI agent rules to use **only** `brainbank_context`:

```
brainbank_context({ task: "<what you're trying to understand>" })
```

After each call, batch-read the full output in 800-line chunks. The output is a
complete, untrimmed Workflow Trace with `called by` annotations and full source.

> **Configuration:** Add BrainBank rules to your agent's system prompt (GEMINI.md,
> AGENTS.md, .cursor/rules) pointing it to use `brainbank_context` only.

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

1. Agent sends `brainbank_context({ task: "..." })`
2. `WorkspacePool` resolves `repo` → gets/creates a BrainBank instance
3. BrainBank calls `ensureFresh()` → hot-reloads stale HNSW if needed
4. BrainBank executes search + call tree + formatting
5. Workflow Trace returned as markdown to the agent

### Architecture

```
@brainbank/mcp
├── mcp-server.ts          ← MCP stdio server (1 tool: brainbank_context)
├── workspace-pool.ts      ← Memory-pressure + TTL eviction, active-op tracking
└── workspace-factory.ts   ← Delegates to core createBrain() — no plugin hardcoding
```

The MCP server imports `createBrain()` from the core `brainbank` package. Plugin packages are optional `peerDependencies` — discovered and loaded dynamically by the core factory.

### Corruption Recovery

If `initialize()` fails with `Invalid the given array length` (corrupted DB), the server auto-deletes the DB file and retries with a fresh instance.

---

## See Also

- [Multi-Repo](multi-repo.md) — multi-workspace indexing
- [Configuration](config.md) — embedding config
- [packages/mcp/README.md](../packages/mcp/README.md) — package-level docs

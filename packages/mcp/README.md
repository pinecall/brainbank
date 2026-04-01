# @brainbank/mcp

[MCP](https://modelcontextprotocol.io/) server for [BrainBank](https://github.com/pinecall/brainbank) — exposes code search, git history, and collections as tools for AI agents via stdio transport.

## Install

```bash
npm install @brainbank/mcp
```

Plugin packages are optional peer dependencies — install whichever you need:

```bash
npm install @brainbank/code @brainbank/git @brainbank/docs
```

## Quick Start

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

## Zero-Config

The MCP server auto-detects everything:

- **Repo path** — from `repo` tool param > `BRAINBANK_REPO` env > `findRepoRoot(cwd)`
- **Embedding provider** — from `.brainbank/config.json` > `BRAINBANK_EMBEDDING` env > `provider_key` stored in DB > falls back to local
- **Plugins** — reads `plugins` array from `config.json` (default: `['code', 'git', 'docs']`). Loaded dynamically by the core factory — no hardcoded imports

Index your repo once with the CLI to set up the embedding provider:

```bash
brainbank index .   # interactive — prompts for modules and embedding provider
```

After that, the MCP server auto-resolves the correct provider — no env vars needed.

## Environment Variables

All optional — the server works without any env vars.

| Variable | Description | Default |
|----------|-------------|---------|
| `BRAINBANK_REPO` | Fallback repo path (if `repo` param not provided and no `.git/` found) | auto-detect from cwd |
| `BRAINBANK_EMBEDDING` | Embedding provider key | from `config.json` or DB |
| `BRAINBANK_RERANKER` | Reranker: `none`, `qwen3` | `none` |
| `BRAINBANK_MAX_MEMORY_MB` | Maximum total pool memory in MB | `2048` |
| `BRAINBANK_TTL_MINUTES` | Idle workspace eviction timeout in minutes | `30` |
| `OPENAI_API_KEY` | Required when embedding provider is `openai` | — |
| `PERPLEXITY_API_KEY` | Required when embedding provider is `perplexity` or `perplexity-context` | — |

## Tools (7)

| Tool | Description |
|------|-------------|
| `brainbank_search` | Unified search — `mode: hybrid` (default), `vector`, or `keyword` |
| `brainbank_context` | Formatted context block for a task (code + git + co-edits + docs) |
| `brainbank_index` | Trigger incremental code/git/docs indexing |
| `brainbank_stats` | Index statistics (files, commits, chunks, collections) |
| `brainbank_history` | Git history for a specific file |
| `brainbank_collection` | KV collection ops — `action: add`, `search`, or `trim` |
| `brainbank_workspaces` | Pool observability — `action: list`, `evict`, or `stats` |

## Multi-Workspace

The MCP server manages a `WorkspacePool` of BrainBank instances — one per unique `repo` path. The pool uses memory-pressure eviction (configurable max memory) and TTL eviction (configurable idle timeout):

```typescript
// Agent working in one workspace
brainbank_search({ query: "login form", repo: "/Users/you/project-a" })

// Agent switches to another project — new instance auto-created
brainbank_search({ query: "API routes", repo: "/Users/you/project-b" })
```

Instances are cached in memory after first initialization (~480ms). Active operations are tracked — the pool never evicts a workspace with in-flight queries.

## Architecture

```
@brainbank/mcp
├── mcp-server.ts          ← MCP stdio server (7 tools)
├── workspace-pool.ts      ← Memory-pressure + TTL eviction, active-op tracking
└── workspace-factory.ts   ← Delegates to core createBrain() — no plugin hardcoding
```

The MCP server imports `createBrain()` from the core `brainbank` package. Plugin packages are optional `peerDependencies` — discovered and loaded dynamically by the core factory.

## How it works

```
AI Agent  ←→  stdio  ←→  @brainbank/mcp  ←→  BrainBank core  ←→  SQLite
```

1. Agent sends an MCP tool call (e.g., `brainbank_search`)
2. `WorkspacePool` resolves `repo` → gets/creates a BrainBank instance
3. Pool tracks active operations to prevent mid-query eviction
4. BrainBank calls `ensureFresh()` → hot-reloads stale HNSW if needed
5. BrainBank executes against its local SQLite database
6. Results returned as structured markdown to the agent

## License

MIT

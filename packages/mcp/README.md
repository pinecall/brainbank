# @brainbank/mcp

[MCP](https://modelcontextprotocol.io/) server for [BrainBank](https://github.com/pinecall/brainbank) — exposes code search, git history, and collections as tools for AI agents via stdio transport.

## Install

```bash
npm install @brainbank/mcp
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
- **Embedding provider** — from `provider_key` stored in DB (set during `brainbank index --embedding openai`)

Index your repo once with the CLI to set up the embedding provider:

```bash
brainbank index . --embedding openai   # stores provider_key=openai in DB
```

After that, the MCP server auto-resolves the correct provider — no env vars needed.

## Environment Variables

All optional — the server works without any env vars.

| Variable | Description | Default |
|----------|-------------|---------|
| `BRAINBANK_REPO` | Fallback repo path (if `repo` param not provided and no `.git/` found) | auto-detect from cwd |
| `BRAINBANK_RERANKER` | Reranker: `none`, `qwen3` | `none` |
| `OPENAI_API_KEY` | Required when embedding provider is `openai` | — |
| `PERPLEXITY_API_KEY` | Required when embedding provider is `perplexity` or `perplexity-context` | — |

## Tools (6)

| Tool | Description |
|------|-------------|
| `brainbank_search` | Unified search — `mode: hybrid` (default), `vector`, or `keyword` |
| `brainbank_context` | Formatted context block for a task (code + git + co-edits) |
| `brainbank_index` | Trigger incremental code/git/docs indexing |
| `brainbank_stats` | Index statistics (files, commits, chunks, collections) |
| `brainbank_history` | Git history for a specific file |
| `brainbank_collection` | KV collection ops — `action: add`, `search`, or `trim` |

## Multi-Workspace

The MCP server maintains a pool of BrainBank instances — one per unique `repo` path. Each tool call can target a different workspace:

```typescript
// Agent working in one workspace
brainbank_search({ query: "login form", repo: "/Users/you/project-a" })

// Agent switches to another project — new instance auto-created
brainbank_search({ query: "API routes", repo: "/Users/you/project-b" })
```

Instances are cached in memory after first initialization (~480ms), so subsequent queries to the same repo are fast.

## How it works

```
AI Agent  ←→  stdio  ←→  @brainbank/mcp  ←→  BrainBank core  ←→  SQLite
```

1. Agent sends an MCP tool call (e.g., `brainbank_search`)
2. Server routes to the correct BrainBank instance (by `repo` path)
3. BrainBank executes the search against its local SQLite database
4. Results returned as structured JSON to the agent

## License

MIT

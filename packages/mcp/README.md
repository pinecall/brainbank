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
      "args": ["-y", "@brainbank/mcp"],
      "env": {
        "BRAINBANK_EMBEDDING": "openai"
      }
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
      "args": ["-y", "@brainbank/mcp"],
      "env": {
        "BRAINBANK_EMBEDDING": "openai",
        "OPENAI_API_KEY": "sk-..."
      }
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
      "args": ["-y", "@brainbank/mcp"],
      "env": {
        "BRAINBANK_EMBEDDING": "openai"
      }
    }
  }
}
```

### CLI (standalone)

```bash
brainbank serve
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `BRAINBANK_REPO` | Default repo path (fallback if `repo` param not provided) | — |
| `BRAINBANK_EMBEDDING` | Embedding provider: `local`, `openai`, `perplexity`, `perplexity-context` | `local` |
| `OPENAI_API_KEY` | Required when using `openai` embeddings | — |
| `PERPLEXITY_API_KEY` | Required when using `perplexity` or `perplexity-context` embeddings | — |

> The agent passes the `repo` parameter per tool call based on the active workspace — no hardcoded paths needed.

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

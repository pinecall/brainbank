# @brainbank/mcp

[MCP](https://modelcontextprotocol.io/) server for [BrainBank](https://github.com/pinecall/brainbank) — exposes code context as a single tool for AI agents via stdio transport.

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
- **Plugins** — reads `plugins` array from `config.json` (default: `['code']`). Loaded dynamically by the core factory — no hardcoded imports

Index your repo once with the CLI:

```bash
brainbank index . --yes
```

After that, the MCP server auto-resolves the correct provider — no env vars needed.

## Tools (2)

### `brainbank_context`

**Primary tool.** Returns a Workflow Trace:

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
- Search hits with `% match` scores
- Full call tree (3 levels deep) with `called by` annotations
- Part adjacency boost (multi-part functions shown complete)
- Trivial wrapper collapse (one-liners for delegation)
- All source code included — no trimming, no truncation

If the project is **not indexed**, the tool returns an error with the CLI command to run.

### `brainbank_index`

Re-index code/git/docs. Requires `.brainbank/config.json`. Incremental — only changed files are processed.

```typescript
brainbank_index({
  forceReindex?: boolean,  // force full re-index (default: false)
  repo?: string,           // repository path
})
```

## Multi-Workspace

The MCP server manages a `WorkspacePool` of BrainBank instances — one per unique `repo` path. The pool uses memory-pressure eviction (configurable max memory) and TTL eviction (configurable idle timeout):

```typescript
brainbank_context({ task: "login form", repo: "/project-a" })
brainbank_context({ task: "API routes", repo: "/project-b" })
```

Instances are cached in memory after first initialization (~480ms). Active operations are tracked — the pool never evicts a workspace with in-flight queries.

## Environment Variables

All optional — the server works without any env vars.

| Variable | Description | Default |
|----------|-------------|---------|
| `BRAINBANK_REPO` | Fallback repo path | auto-detect from cwd |
| `BRAINBANK_EMBEDDING` | Embedding provider key | from `config.json` or DB |
| `BRAINBANK_MAX_MEMORY_MB` | Maximum total pool memory in MB | `2048` |
| `BRAINBANK_TTL_MINUTES` | Idle workspace eviction timeout in minutes | `30` |
| `OPENAI_API_KEY` | Required when embedding provider is `openai` | — |
| `PERPLEXITY_API_KEY` | Required when embedding provider is `perplexity` / `perplexity-context` | — |

## Architecture

```
@brainbank/mcp
├── mcp-server.ts          ← MCP stdio server (1 tool: brainbank_context)
├── workspace-pool.ts      ← Memory-pressure + TTL eviction, active-op tracking
└── workspace-factory.ts   ← Delegates to core createBrain() — no plugin hardcoding
```

## How it works

```
AI Agent  ←→  stdio  ←→  @brainbank/mcp  ←→  BrainBank core  ←→  SQLite
```

1. Agent sends `brainbank_context({ task: "..." })`
2. `WorkspacePool` resolves `repo` → gets/creates a BrainBank instance
3. BrainBank calls `ensureFresh()` → hot-reloads stale HNSW if needed
4. BrainBank executes search + call tree + formatting
5. Workflow Trace returned as markdown to the agent

## License

MIT

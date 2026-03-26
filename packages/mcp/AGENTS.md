# AGENTS.md — @brainbank/mcp

MCP server that exposes BrainBank as a Model Context Protocol service via stdio.
Single file: `src/mcp-server.ts` (~380 lines). Uses `@modelcontextprotocol/sdk` + `zod/v3`.

## Commands

- Build: `npx tsup` (from this directory)
- No tests — this package is integration-tested via the MCP clients.

## Architecture

- Single entry point: `src/mcp-server.ts`
- Multi-workspace pool: one `BrainBank` instance per unique `repo` path, cached in `_pool`
- Shared reranker and embedding provider across all pool instances
- 6 tools registered:
  - `brainbank_search` — unified search (hybrid/vector/keyword via `mode` param)
  - `brainbank_context` — formatted task context with code + git + co-edits
  - `brainbank_index` — trigger code/git/docs indexing
  - `brainbank_stats` — index statistics
  - `brainbank_history` — git history for a file
  - `brainbank_collection` — KV collection ops (add/search/trim via `action` param)

## Gotchas

- Uses `zod/v3` subpath import (NOT `zod` directly) — requires zod v4+
- `BRAINBANK_RERANKER` env var is supported (defaults to `none`)
- Auto-recovery: if HNSW dimension mismatch, it deletes the DB and re-creates. This is intentional.

## Permissions

- NEVER modify this package without understanding the MCP protocol
- NEVER change tool schemas — that's a breaking change for all connected clients
- Adding new tools requires understanding the `registerTool` pattern and zod schemas

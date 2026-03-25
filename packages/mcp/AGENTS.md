# AGENTS.md — @brainbank/mcp

MCP server that exposes BrainBank as a Model Context Protocol service via stdio.
Single file: `src/mcp-server.ts` (~617 lines). Uses `@modelcontextprotocol/sdk` + `zod/v3`.

## Commands

- Build: `npx tsup` (from this directory)
- No tests — this package is integration-tested via the MCP clients.

## Architecture

- Single entry point: `src/mcp-server.ts`
- Multi-workspace pool: one `BrainBank` instance per unique `repo` path, cached in `_pool`
- Shared reranker and embedding provider across all pool instances
- 11 tools registered (`brainbank_search`, `brainbank_hybrid_search`, `brainbank_index`, etc.)

## Gotchas

- Uses `zod/v3` subpath import (NOT `zod` directly) — requires zod v4+
- `brainbank.module('docs')` on L271 should be `brainbank.indexer('docs')` — stale API call
- `BRAINBANK_RERANKER` env var IS supported here (defaults to `none`), even though the CLI doesn't support it
- Auto-recovery: if HNSW dimension mismatch, it deletes the DB and re-creates. This is intentional.

## Permissions

- NEVER modify this package without understanding the MCP protocol
- NEVER change tool schemas — that's a breaking change for all connected clients
- Adding new tools requires understanding the `registerTool` pattern and zod schemas

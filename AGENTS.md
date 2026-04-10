# AGENTS.md

## Project
BrainBank — lightweight semantic memory framework for AI agents. Hybrid search (vector + BM25) in a single SQLite file. Core package (`brainbank`) + independent `@brainbank/*` plugins.
Stack: TypeScript (strict, ESM) · Node ≥18 · better-sqlite3 · hnswlib-node.

## Dev
- Install: `npm install --legacy-peer-deps`
- Build all: `npm run build` | Core only: `npm run build:core`
- Type-check: `npx tsc --noEmit`
- Test (targeted): `npm test -- --filter <name>` | Full suite: `npm test` (~200 tests)
- Dev CLI: `npm run dev`

## Architecture (4 layers — imports flow downward only)
- **Layer 0** — Foundation: `types.ts`, `config.ts`, `lib/`, `db/`
- **Layer 1** — Infrastructure: `providers/`, `search/`
- **Layer 2** — Domain: `plugin.ts`, `services/`, `lib/languages.ts`
- **Layer 3** — Application: `brainbank.ts`, `engine/`, `cli/`
- **packages/** — All plugin implementations (`@brainbank/code`, `/git`, `/docs`, `/mcp`). Never in `src/`.

## Key Files
`src/brainbank.ts` · `src/plugin.ts` · `src/constants.ts` · `src/services/collection.ts`
`src/engine/search-api.ts` · `src/db/sqlite-adapter.ts` · `src/db/tracker.ts`

## MCP Tools (2-step workflow)
1. **`brainbank_context`** — Semantic search. Pass `task` to find relevant code by meaning. Returns chunks with BrainBankQL enrichments (call tree, symbols, imports, line numbers).
2. **`brainbank_files`** — Direct file viewer. Use AFTER `brainbank_context` to fetch complete files identified by search. No search runs — reads directly from the index.

`brainbank_files` supports:
- Exact paths: `"src/auth/login.ts"`
- Directories: `"src/graph/"` (trailing `/` = all files under path)
- Glob patterns: `"src/**/*.service.ts"`
- Fuzzy basename: `"plugin.ts"` (matches `src/plugin.ts` when exact fails)
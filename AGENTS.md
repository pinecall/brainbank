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
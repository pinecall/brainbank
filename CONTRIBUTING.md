# Contributing to BrainBank

Thanks for your interest in contributing! Here's how to get started.

## Development Setup

```bash
git clone https://github.com/pinecall/brainbank.git
cd brainbank
npm install
npm test                    # Unit tests (207)
npm test -- --integration   # Full suite with real models
```

## Running Tests

```bash
npm test                        # Unit tests only
npm test -- --integration       # Include real model tests
npm test -- --filter bm25       # Filter by name
npm test -- --verbose           # Show assertion details
```

## Project Structure

```
src/
├── brainbank.ts       Main orchestrator (facade)
├── types.ts           All shared types and interfaces
├── config/            Defaults, resolver
├── db/                SQLite schema, database wrapper
├── lib/               Pure functions: math, rrf, fts
├── providers/         Embeddings (local, OpenAI, Perplexity), vector (HNSW), rerankers
├── search/            Search strategies: vector, keyword, context-builder
├── domain/            Core primitives: collection, memory
├── indexers/          Plugins: code, git, docs + base interface
├── services/          Reembed, watch
├── bootstrap/         System wiring: initializer, registry
├── api/               Use cases: search-api, index-api
└── cli/               CLI commands and factory
```

See [docs/architecture.md](docs/architecture.md) for the complete architecture reference.

## Writing a Custom Plugin

Implement the `Plugin` interface:

```typescript
import type { Plugin, PluginContext } from 'brainbank';

function myPlugin(): Plugin {
  return {
    name: 'my-plugin',
    async initialize(ctx) {
      // ctx.db, ctx.embedding, ctx.collection() available
    },
    watchPatterns() { return ['**/*.csv']; },
    async onFileChange(path, event) {
      // Handle file changes in watch mode
      return true;
    },
  };
}
```

See [docs/custom-plugins.md](docs/custom-plugins.md) for the full plugin guide.

## Code Style

- TypeScript strict mode
- ESM only (`"type": "module"`)
- JSDoc on all public interfaces
- No `any` types in new code
- Imports use `@/` for cross-directory, `./` for same-directory (never `../`)
- Tests for every new feature

## Pull Request Process

1. Fork and create a feature branch
2. Write tests for new features
3. Ensure `npm test -- --integration` passes
4. Update `CHANGELOG.md` under `## [Unreleased]`
5. Submit PR with a clear description

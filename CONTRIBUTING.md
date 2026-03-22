# Contributing to BrainBank

Thanks for your interest in contributing! Here's how to get started.

## Development Setup

```bash
git clone https://github.com/pinecall/brainbank.git
cd brainbank
npm install
npm test                    # Unit tests (129)
npm test -- --integration   # Full suite with real models (157)
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
├── core/          Main orchestrator, collections, config, schema
├── embeddings/    Embedding providers (local, OpenAI)
├── indexers/      Code, git, doc indexer implementations
├── integrations/  CLI, MCP server
├── memory/        Note store, patterns, consolidation
├── plugins/       Plugin factories and Indexer interface
├── query/         Search, BM25, RRF, context builder
├── storage/       SQLite database wrapper
└── vector/        HNSW index, MMR diversity
```

## Writing a Custom Indexer

Implement the `Indexer` interface:

```typescript
import type { Indexer, IndexerContext } from 'brainbank';

function myIndexer(): Indexer {
  return {
    name: 'my-indexer',
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

## Code Style

- TypeScript strict mode
- JSDoc on all public interfaces
- No `any` types in public API
- Tests for every new feature

## Pull Request Process

1. Fork and create a feature branch
2. Write tests for new features
3. Ensure `npm test -- --integration` passes
4. Submit PR with a clear description

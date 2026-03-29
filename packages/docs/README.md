# @brainbank/docs

Document collection indexing plugin for [BrainBank](https://github.com/pinecall/brainbank). Indexes folders of markdown/text files with heading-aware smart chunking inspired by [qmd](https://github.com/qmd-ai/qmd), then provides hybrid search (vector + BM25 → RRF).

## Install

Included in core `brainbank`. Also available as a standalone package:

```bash
# Already included when you install brainbank globally
npm i -g brainbank

# Or install standalone (e.g. for programmatic use)
npm i -g @brainbank/docs
```

## Quick Start

```typescript
import { BrainBank } from 'brainbank';
import { docs } from '@brainbank/docs';

const brain = new BrainBank({ dbPath: '.brainbank/db' })
  .use(docs());

await brain.initialize();

// Register a document collection
const docsPlugin = brain.plugin('docs');
docsPlugin.addCollection({
  name: 'wiki',
  path: '/path/to/wiki',
  pattern: '**/*.md',
});

// Index all collections
await docsPlugin.indexCollections();

// Search documents
const results = await docsPlugin.search('deployment guide');
```

## API

### `docs(options?): Plugin`

Factory function — creates a document collections plugin.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `embeddingProvider` | `EmbeddingProvider` | global | Per-plugin embedding override |

### `DocsPlugin` Methods

#### `addCollection(collection): void`

Register a document collection for indexing.

```typescript
docsPlugin.addCollection({
  name: 'notes',           // unique collection name
  path: '/path/to/notes',  // directory to index
  pattern: '**/*.md',      // glob pattern (default: '**/*.md')
  ignore: ['drafts/**'],   // optional ignore patterns
  context: 'Personal development notes',  // optional context for embeddings
});
```

#### `indexCollections(options?): Promise<Results>`

Index all (or specific) collections. Incremental — skips unchanged files.

```typescript
// Index everything
await docsPlugin.indexCollections();

// Index specific collections
await docsPlugin.indexCollections({ collections: ['wiki', 'notes'] });

// With progress callback
await docsPlugin.indexCollections({
  onProgress: (collection, file, current, total) => {
    console.log(`[${collection}] ${file} (${current}/${total})`);
  },
});
```

#### `search(query, options?): Promise<SearchResult[]>`

Hybrid search across indexed documents.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `collection` | `string` | all | Filter to specific collection |
| `k` | `number` | `8` | Max results |
| `minScore` | `number` | `0` | Minimum relevance threshold |
| `mode` | `'hybrid' \| 'vector' \| 'keyword'` | `'hybrid'` | Search mode |

#### `addContext(collection, path, context): void`

Add context descriptions to document paths for better search relevance.

```typescript
// Add context to a directory
docsPlugin.addContext('wiki', '/api', 'REST API documentation and endpoint reference');
```

#### `removeCollection(name): void`

Remove a collection and all its indexed data.

#### `listCollections(): DocumentCollection[]`

List all registered collections.

### `DocsIndexer`

Core indexing engine with heading-aware smart chunking.

**Chunking strategy (qmd-inspired):**
- Target ~3000 chars per chunk (~900 tokens)
- Breaks at markdown boundaries (headings, code fences, horizontal rules)
- Scores break points by quality (H1 > H2 > code fence > blank line)
- Applies distance decay — prefers breaks near the target length
- Minimum chunk size: 200 chars (tiny chunks are merged)

### `DocumentSearch`

Hybrid search engine combining vector similarity and BM25 keyword search:
- Over-fetches from both backends (2×k)
- Fuses results with Reciprocal Rank Fusion (RRF)
- Deduplicates by file path (keeps best chunk per file)
- Optional reranking with Qwen3 cross-encoder

## Peer Dependencies

- `brainbank` >= 0.7.0

## License

MIT

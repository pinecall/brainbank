# Plugins

BrainBank uses a pluggable architecture. Register only what you need with `.use()`:

```typescript
import { BrainBank } from 'brainbank';
import { code } from '@brainbank/code';
import { git } from '@brainbank/git';
import { docs } from '@brainbank/docs';

const brain = new BrainBank({ repoPath: '.' })
  .use(code())
  .use(git())
  .use(docs());
```

## Built-in Plugins

| Plugin | Package | Description |
|--------|---------|-------------|
| `code` | `@brainbank/code` | AST-aware code chunking via tree-sitter (20+ languages), import graph, symbol index, call references |
| `git` | `@brainbank/git` | Git commit history, diffs, co-edit relationships |
| `docs` | `@brainbank/docs` | Document collections (markdown, wikis, .md/.mdx files), heading-aware smart chunking |

---

## Plugin Configuration

Each plugin accepts options and can use a different embedding provider:

```typescript
import { BrainBank, OpenAIEmbedding, PerplexityContextEmbedding } from 'brainbank';
import { code } from '@brainbank/code';
import { git } from '@brainbank/git';
import { docs } from '@brainbank/docs';

const brain = new BrainBank({ repoPath: '.' })       // default: local WASM (384d, free)
  .use(code({
    embeddingProvider: new OpenAIEmbedding(),                // code: OpenAI (1536d)
    ignore: ['sdk/**', 'vendor/**', '**/*.generated.ts'],   // skip auto-generated code
  }))
  .use(git())                                               // git: local (384d)
  .use(docs({
    embeddingProvider: new PerplexityContextEmbedding(),     // docs: Perplexity (2560d)
  }));
```

> Each plugin creates its own HNSW index with the correct dimensions. A plugin without an `embeddingProvider` uses the global default.

---

## Plugin Lifecycle

```
1. brain.use(myPlugin)        →  Plugin registered (not initialized yet)
2. await brain.initialize()   →  plugin.initialize(ctx) called
3. brain.index()              →  plugin.index() called  (if IndexablePlugin)
4. brain.search()             →  results from VectorSearchPlugin / SearchablePlugin
5. brain.watch()              →  plugin.watch(onEvent)  (if WatchablePlugin)
6. brain.close()              →  plugin.close()         (cleanup)
```

---

## Capability Interfaces

Plugins implement zero or more capability interfaces discovered at runtime via type guards:

| Interface | Type Guard | Method | What happens |
|-----------|-----------|--------|-------------|
| `IndexablePlugin` | `isIndexable()` | `index(options?)` | Participates in `brain.index()` |
| `SearchablePlugin` | `isSearchable()` | `search(query, options?)` | Results merged via RRF in `brain.hybridSearch()` |
| `WatchablePlugin` | `isWatchable()` | `watch(onEvent)` + `watchConfig?()` | Plugin drives its own watching, core coordinates re-indexing |
| `VectorSearchPlugin` | `isVectorSearchPlugin()` | `createVectorSearch()` | Provides domain-specific vector strategy for CompositeVectorSearch |
| `ContextFormatterPlugin` | `isContextFormatterPlugin()` | `formatContext(results, parts)` | Contributes sections to `brain.getContext()` output |
| `BM25SearchPlugin` | `isBM25SearchPlugin()` | `searchBM25(query, k)` | Provides FTS5 keyword search for CompositeBM25Search |
| `MigratablePlugin` | `isMigratable()` | `schemaVersion` + `migrations` | Plugin owns its DB schema via versioned migrations |
| `ReembeddablePlugin` | `isReembeddable()` | `reembedConfig()` | Participates in `brain.reembed()` |
| `CoEditPlugin` | `isCoEditPlugin()` | `coEdits.suggest()` | Provides co-edit suggestions |

---

## Plugin Access

Access plugin instances via the typed `plugin<T>()` method:

```typescript
import type { DocsPlugin } from 'brainbank';

// Typed access
const docsPlugin = brain.plugin<DocsPlugin>('docs');
docsPlugin?.addCollection({ name: 'wiki', path: './docs' });
docsPlugin?.search('getting started');

// Check if a plugin is loaded (supports prefix matching)
brain.has('code');    // true for 'code', 'code:frontend', 'code:backend'
brain.has('docs');    // true if docs plugin loaded

// List all plugins
brain.plugins; // → ['code', 'git', 'docs']
```

---

## Document Collections

The `docs` plugin manages collections of markdown and text files. It implements both `IndexablePlugin` (participates in `brain.index()`) and `SearchablePlugin` (participates in hybrid search).

```typescript
const docsPlugin = brain.plugin<DocsPlugin>('docs');

// Register a collection
docsPlugin!.addCollection({
  name: 'docs',
  path: '~/project/docs',
  pattern: '**/*.md',
  ignore: ['**/drafts/**'],
  context: 'Project documentation',
});

// Index documents (incremental)
await docsPlugin!.indexDocs();

// Or index via brain.index() — docs participates automatically
await brain.index({ modules: ['docs'] });

// Add context metadata (helps LLM understand what documents are about)
docsPlugin!.addContext('docs', '/api', 'REST API reference');
docsPlugin!.addContext('docs', '/guides', 'Step-by-step tutorials');

// Search documents (hybrid: vector + BM25 → RRF → dedup by file)
const results = await docsPlugin!.search('authentication flow', { collection: 'docs' });
```

---

## See Also

- [Custom Plugins](custom-plugins.md) — build your own plugin
- [Embeddings](embeddings.md) — per-plugin embedding providers
- [Configuration](config.md) — plugin config in `.brainbank/config.json`

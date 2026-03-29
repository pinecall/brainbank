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
| `code` | `@brainbank/code` | AST-aware code chunking via tree-sitter (20 languages). Source code only — does **not** index documents (.md, .mdx) |
| `git` | `@brainbank/git` | Git commit history, diffs, co-edit relationships |
| `docs` | `@brainbank/docs` | Document collections (markdown, wikis, .md/.mdx files) |

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
4. brain.search()             →  plugin.search() called (if SearchablePlugin)
5. brain.watch()              →  plugin.onFileChange()  (if WatchablePlugin)
6. brain.close()              →  plugin.close()         (cleanup)
```

---

## Typed Plugin Access

Access plugin methods directly via typed getters:

```typescript
// Built-in plugins — typed getters
brain.docs!.addCollection({ name: 'wiki', path: './docs' });
brain.docs!.search('getting started');
brain.git!.suggestCoEdits('src/auth.ts');

// Custom plugins — generic access with type parameter
const myPlugin = brain.plugin<MyPlugin>('my-plugin')!;
await myPlugin.searchMyData('query');

// List all plugins
brain.plugins; // → ['code', 'git', 'docs', 'my-plugin']
```

---

## Document Collections

The `docs` plugin manages collections of markdown and text files:

```typescript
// Register a collection
brain.docs!.addCollection({
  name: 'docs',
  path: '~/project/docs',
  pattern: '**/*.md',
  ignore: ['**/drafts/**'],
  context: 'Project documentation',
});

// Index documents (incremental)
await brain.docs!.indexDocs();

// Add context metadata (helps LLM understand what documents are about)
brain.docs!.addContext('docs', '/api', 'REST API reference');
brain.docs!.addContext('docs', '/guides', 'Step-by-step tutorials');

// Search documents
const results = await brain.docs!.search('authentication flow', { collection: 'docs' });
```

---

## See Also

- [Custom Plugins](custom-plugins.md) — build your own plugin
- [Embeddings](embeddings.md) — per-plugin embedding providers
- [Configuration](config.md) — plugin config in `.brainbank/config.json`

# Plugins

BrainBank uses a capability-based plugin architecture. The core is **plugin-agnostic** — every search, indexing, context formatting, and re-embedding operation is discovered at runtime via typed interfaces. Register only what you need with `.use()`:

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

---

## Built-in Plugins

| Plugin | Package | Description |
|--------|---------|-------------|
| `code` | `@brainbank/code` | AST-aware code chunking (tree-sitter, 20+ languages), import graph, symbol index, call references, dual-level hybrid search |
| `git` | `@brainbank/git` | Git commit history, diffs, co-edit file relationships |
| `docs` | `@brainbank/docs` | Document collections (markdown, wikis), heading-aware smart chunking, hybrid search |

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
    include: ['src/**', 'lib/**'],                           // only index these folders
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
                                 ├── runPluginMigrations() creates DB tables
                                 ├── getOrCreateSharedHnsw() or createHnsw()
                                 └── loadVectors() populates HNSW from SQLite
3. brain.index()              →  plugin.index() called  (if IndexablePlugin)
4. brain.search()             →  results from VectorSearchPlugin / SearchablePlugin
5. brain.watch()              →  plugin.watch(onEvent)  (if WatchablePlugin)
6. brain.close()              →  plugin.close()         (cleanup)
```

### What Happens at `initialize(ctx)`

Each plugin receives a `PluginContext` with all the infrastructure it needs:

```typescript
interface PluginContext {
  db: DatabaseAdapter;           // per-plugin DB (per-repo for namespaced plugins)
  embedding: EmbeddingProvider;  // global or per-plugin embedding
  config: ResolvedConfig;        // repoPath, dims, HNSW params, etc.
  createHnsw(max?, dims?, name?): Promise<HNSWIndex>;
  loadVectors(table, idCol, hnsw, cache): void;
  getOrCreateSharedHnsw(type, max?, dims?): Promise<{ hnsw, vecCache, isNew }>;
  collection(name): ICollection;
  createTracker(): IncrementalTracker;
  webhookServer?: WebhookServer;
}
```

---

## Capability Interfaces

Plugins implement zero or more capability interfaces, discovered at runtime via type guards. No hardcoded names — the core iterates over registered plugins and uses duck-typing:

| Interface | Type Guard | Key Method(s) | What happens |
|-----------|-----------|---------------|-------------|
| `IndexablePlugin` | `isIndexable()` | `index(options?)` | Participates in `brain.index()` |
| `SearchablePlugin` | `isSearchable()` | `search(query, options?)` | Results merged via RRF in `brain.hybridSearch()` |
| `WatchablePlugin` | `isWatchable()` | `watch(onEvent)` + `watchConfig?()` | Plugin drives its own watching, core coordinates re-indexing |
| `VectorSearchPlugin` | `isVectorSearchPlugin()` | `createVectorSearch()` | Provides domain-specific HNSW strategy for `CompositeVectorSearch` |
| `BM25SearchPlugin` | `isBM25SearchPlugin()` | `searchBM25(query, k)` + `rebuildFTS?()` | Provides FTS5 keyword search for `CompositeBM25Search` |
| `ContextFormatterPlugin` | `isContextFormatterPlugin()` | `formatContext(results, parts, fields)` | Contributes markdown sections to `brain.getContext()` |
| `ContextFieldPlugin` | `isContextFieldPlugin()` | `contextFields()` | Declares configurable fields (lines, callTree, symbols…) |
| `ExpandablePlugin` | `isExpandablePlugin()` | `buildManifest()` + `resolveChunks()` | Powers LLM context expansion (HaikuExpander) |
| `FileResolvablePlugin` | `isFileResolvable()` | `resolveFiles(patterns)` | Enables `brain.resolveFiles()` and `brainbank files` command |
| `MigratablePlugin` | `isMigratable()` | `schemaVersion` + `migrations` | Plugin owns its DB schema via versioned migrations |
| `ReembeddablePlugin` | `isReembeddable()` | `reembedConfig()` | Participates in `brain.reembed()` |
| `CoEditPlugin` | `isCoEditPlugin()` | `coEdits.suggest()` | Provides co-edit file suggestions (git plugin) |
| `DocsPlugin` | `isDocsPlugin()` | `addCollection()`, `indexDocs()`, etc. | Full document collection management |

---

## HNSW Sharing Strategy

Plugins use different HNSW sharing strategies depending on their needs:

| Plugin | HNSW key | Sharing | File |
|--------|----------|---------|------|
| `code:frontend` | `'code:frontend'` | Per-repo — isolated | `hnsw-code:frontend.index` |
| `code:backend` | `'code:backend'` | Per-repo — isolated | `hnsw-code:backend.index` |
| `git` (all `git:*`) | `'git'` | Shared — one index | `hnsw-git.index` |
| `docs` (all `docs:*`) | `'docs'` | Shared — one index | `hnsw-docs.index` |
| KV collections | `KVService._hnsw` | Shared — all collections | `hnsw-kv.index` |

Code plugins use their full name as the key (`this.name`) — each repo gets its own isolated HNSW. Git and docs plugins use literal string keys — all instances of the same type share one index, saving memory.

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

## @brainbank/code — Code Plugin

**Capabilities:** `IndexablePlugin`, `VectorSearchPlugin`, `BM25SearchPlugin`, `ContextFormatterPlugin`, `ContextFieldPlugin`, `ExpandablePlugin`, `FileResolvablePlugin`, `ReembeddablePlugin`, `MigratablePlugin`

**Schema:** `code_chunks`, `code_vectors`, `indexed_files`, `code_imports`, `code_symbols`, `code_refs`, `code_call_edges`, `fts_code`

```typescript
import { code } from '@brainbank/code';

brain.use(code({
  repoPath: '.',               // repository root
  maxFileSize: 512_000,        // skip files larger than 500KB
  include: ['src/**', 'lib/**'],            // whitelist — only index matching paths
  ignore: ['sdk/**', '*.generated.ts'],     // blacklist — exclude wins over include
  embeddingProvider: ...,      // optional override
}));
```

> **Include + Ignore:** When both are set, `include` restricts which files are considered, then `ignore` removes files from that set. Exclude always wins. See [Configuration — Include Whitelist](config.md#include-whitelist-code-plugin) for details.

**What gets indexed per file:**
1. AST-aware chunks (functions, classes, methods) via tree-sitter
2. A `synopsis` chunk (file-level embedding for broad matching)
3. Import graph edges → `code_imports`
4. Symbol definitions → `code_symbols`
5. Call references → `code_refs`
6. After all files: chunk-to-chunk call edges → `code_call_edges`

**Dual-level search:** HNSW hits are split into `synopsis` (file-level) and `chunk` (function-level). Cross-level boost (1.4×) when both match; chunk-only penalty (0.7×) to reduce false positives. BM25 fused via RRF.

**Workflow Trace formatter:** Flat `## Code Context` section with topologically-ordered code, `called by` annotations, part-adjacency expansion, and import/symbol summary.

**Context fields:**

| Field | Default | Description |
|-------|---------|-------------|
| `lines` | `false` | Source line number prefix on each line |
| `callTree` | `true` | Call tree expansion (pass `{ depth: N }` for custom depth) |
| `imports` | `true` | Dependency/import summary |
| `symbols` | `false` | Symbol index for matched files |
| `compact` | `false` | Signatures only (no bodies) |

---

## @brainbank/git — Git Plugin

**Capabilities:** `IndexablePlugin`, `VectorSearchPlugin`, `BM25SearchPlugin`, `ContextFormatterPlugin`, `ReembeddablePlugin`, `CoEditPlugin`, `MigratablePlugin`

**Schema:** `git_commits`, `commit_files`, `co_edits`, `git_vectors`, `fts_commits`

```typescript
import { git } from '@brainbank/git';

brain.use(git({
  repoPath: '.',
  depth: 500,               // max commits to index
  maxDiffBytes: 8192,       // truncate diffs larger than this
  embeddingProvider: ...,   // optional override
}));
```

**What gets indexed per commit:**
- Message, author, date, files changed, diff (truncated)
- Embedding text: `"Commit: {msg}\nAuthor:\nDate:\nFiles:\nChanges:\n{diff[:2000]}"`
- Co-edit pairs: files that changed together in the same commit

**Co-edit suggestions:**

```typescript
const gitPlugin = brain.plugin('git') as any;
const coEdits = gitPlugin.suggestCoEdits('src/auth/login.ts', 5);
// → [{ file: 'src/auth/middleware.ts', count: 12 }, ...]
```

**Context formatting:** `## Related Git History` with commit blocks + diff snippets, plus `## Co-Edit Patterns` when `affectedFiles` is provided.

---

## @brainbank/docs — Docs Plugin

**Capabilities:** `IndexablePlugin`, `VectorSearchPlugin`, `BM25SearchPlugin`, `ContextFormatterPlugin`, `SearchablePlugin`, `ReembeddablePlugin`, `DocsPlugin`, `MigratablePlugin`

**Schema:** `collections`, `doc_chunks`, `doc_vectors`, `path_contexts`, `fts_docs`

```typescript
import { docs } from '@brainbank/docs';

brain.use(docs({
  embeddingProvider: ...,   // optional override
}));
```

**Collection management:**

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

// Or via brain.index() — docs participates automatically
await brain.index({ modules: ['docs'] });

// Add path-level context for enriched search
docsPlugin!.addContext('docs', '/api', 'REST API reference');

// Search with per-collection filtering
const results = await docsPlugin!.search('auth flow', {
  collection: 'docs',
  k: 8,
  mode: 'hybrid',
});
```

**Smart chunking:** ~3000 chars per chunk. Break point scoring: H1=100, H2=90, H3=80, code-fence=80, HR=60, blank=20. Distance decay: `score × (1 - (dist/600)² × 0.7)`. Minimum chunk: 200 chars.

**Important — true upsert:** `addCollection()` uses `ON CONFLICT DO UPDATE` (not `INSERT OR REPLACE`) to prevent cascade-deleting all indexed chunks on startup.

---

## Document Collections

The `docs` plugin manages collections of markdown and text files. It participates in the main search pipeline via `VectorSearchPlugin` + `BM25SearchPlugin`, and also provides direct `search()` with per-collection filtering.

```typescript
const docsPlugin = brain.plugin<DocsPlugin>('docs');

// List registered collections
const collections = docsPlugin!.listCollections();

// List path contexts
const contexts = docsPlugin!.listContexts();

// Remove context
docsPlugin!.removeContext('docs', '/api');

// Remove collection (cascades to all indexed chunks)
docsPlugin!.removeCollection('old-wiki');
```

---

## See Also

- [Custom Plugins](custom-plugins.md) — build your own plugin
- [Embeddings](embeddings.md) — per-plugin embedding providers
- [Configuration](config.md) — plugin config in `.brainbank/config.json`
- [Migrations](migrations.md) — plugin-owned database schema

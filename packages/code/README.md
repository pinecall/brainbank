# @brainbank/code

AST-aware code indexing plugin for [BrainBank](https://github.com/pinecall/brainbank). Parses 20+ languages with tree-sitter, builds an import graph, extracts symbols with call references, and produces enriched embeddings for semantic code search.

## Install

```bash
# Global install (CLI + programmatic)
npm i -g brainbank @brainbank/code

# Or as a project dependency
npm i @brainbank/code
```

> **⚠️ Peer dep conflict:** Some bundled `tree-sitter-*` grammars have overlapping peer dependency ranges on `tree-sitter`. If you hit an `ERESOLVE` error during install, use `npm i --force` or `npm i --legacy-peer-deps`.

**Bundled grammars:** JavaScript, TypeScript (JSX/TSX), Python, and HTML ship with this package. For additional languages, install individual `tree-sitter-*` packages globally:

```bash
# Install a few extra languages
npm i -g tree-sitter-go tree-sitter-rust

# Install all remaining grammars
npm i -g tree-sitter-go tree-sitter-rust tree-sitter-c tree-sitter-cpp \
  tree-sitter-java tree-sitter-kotlin tree-sitter-scala tree-sitter-ruby \
  tree-sitter-php tree-sitter-c-sharp tree-sitter-swift tree-sitter-lua \
  tree-sitter-bash tree-sitter-elixir tree-sitter-css
```

BrainBank auto-detects installed grammars at runtime. Missing grammars fall back to a sliding-window chunker.

## Quick Start

```typescript
import { BrainBank } from 'brainbank';
import { code } from '@brainbank/code';

const brain = new BrainBank({ dbPath: '.brainbank/db' })
  .use(code({ repoPath: '.' }));

await brain.initialize();
await brain.index({ modules: ['code'] });

// Search by meaning, not just keywords
const results = await brain.search('authentication middleware');
```

## Multi-Repo

Index multiple repositories into one shared database. Each code plugin gets its own namespace to avoid key collisions:

```typescript
const brain = new BrainBank({ dbPath: '.brainbank/db' })
  .use(code({ repoPath: './frontend', name: 'code:frontend' }))
  .use(code({ repoPath: './backend',  name: 'code:backend' }));
```

## API

### `code(options?): Plugin`

Factory function — creates a code indexing plugin.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `repoPath` | `string` | `'.'` | Repository root to index |
| `maxFileSize` | `number` | `512000` | Max file size in bytes (skips larger files) |
| `ignore` | `string[]` | `[]` | Glob patterns to ignore (e.g. `['sdk/**', '*.generated.ts']`) |
| `name` | `string` | `'code'` | Plugin name for multi-repo (e.g. `'code:frontend'`) |
| `embeddingProvider` | `EmbeddingProvider` | global | Per-plugin embedding override |

### `CodeChunker`

AST-aware code splitter. Uses tree-sitter to extract semantic blocks (functions, classes, methods, interfaces). Falls back to sliding window for unsupported languages or when grammars are not installed.

```typescript
import { CodeChunker } from '@brainbank/code';

const chunker = new CodeChunker({ maxLines: 80, minLines: 3, overlap: 5 });
const chunks = await chunker.chunk('utils.ts', sourceCode, 'typescript');
// → [{ filePath, chunkType, name, startLine, endLine, content, language }]
```

### `extractImports(content, language): string[]`

Regex-based import extractor. Supports 19 languages:

| Category | Languages |
|----------|-----------|
| Web | JavaScript, TypeScript, HTML, CSS |
| Systems | Go, Rust, C, C++, Swift |
| JVM | Java, Kotlin, Scala |
| Scripting | Python, Ruby, PHP, Lua, Bash, Elixir |
| .NET | C# |

```typescript
import { extractImports } from '@brainbank/code';

extractImports(`import { Router } from 'express';`, 'typescript');
// → ['express']
```

### `extractSymbols(rootNode, filePath, language): SymbolDef[]`

AST-based symbol extractor. Requires a tree-sitter parse tree.

```typescript
import { extractSymbols } from '@brainbank/code';

const symbols = extractSymbols(tree.rootNode, 'auth.ts', 'typescript');
// → [{ name: 'AuthService', kind: 'class', line: 5, filePath: 'auth.ts' },
//    { name: 'AuthService.login', kind: 'method', line: 12, filePath: 'auth.ts' }]
```

### `extractCallRefs(node, language): string[]`

Extracts function/method call names from a chunk's AST subtree. Filters out common builtins (`console`, `print`, `map`, etc.).

```typescript
import { extractCallRefs } from '@brainbank/code';

const refs = extractCallRefs(chunkNode, 'typescript');
// → ['validateToken', 'hashPassword', 'createSession']
```

### `GRAMMARS`

Registry of all supported tree-sitter grammars. Each entry is a lazy-loading factory.

## How It Works

### Indexing Pipeline

```
Repository → walk files → filter by extension/size/ignore
    → parse AST (tree-sitter) → extract semantic chunks
    → enrich with imports + parent class context
    → embed chunks → store in SQLite + HNSW
    → extract import graph → code_imports table
    → extract symbols → code_symbols table
    → extract call refs → code_refs table
```

### Enriched Embeddings

Each code chunk embedding includes contextual metadata for better semantic matching:

```
File: src/auth/login.ts
Imports: bcrypt, jsonwebtoken, UserRepository
Class: AuthService
method: AuthService.login
<actual code content>
```

### Incremental Indexing

Uses FNV-1a content hashing — only re-indexes files that actually changed. Old chunks, vectors, and graph data are atomically replaced in a single SQLite transaction.

## Plugin Capabilities

`@brainbank/code` implements the following capability interfaces, discovered by the core at runtime:

| Interface | What it does |
|-----------|-------------|
| `IndexablePlugin` | Participates in `brain.index()` — AST chunking + embedding |
| `VectorSearchPlugin` | Provides `CodeVectorSearch` for semantic code search |
| `BM25SearchPlugin` | Provides FTS5 keyword search against `fts_code` |
| `ContextFormatterPlugin` | Formats code results + import graph for `brain.getContext()` |
| `MigratablePlugin` | Owns its schema — `code_chunks`, `code_vectors`, `indexed_files`, `code_imports`, `code_symbols`, `code_refs`, `fts_code` |
| `ReembeddablePlugin` | Participates in `brain.reembed()` |
| `WatchablePlugin` | Plugin-driven watching via `watch(onEvent)` for code files |

## Supported Languages

The `CodeChunker` produces AST-aware chunks for any language with a tree-sitter grammar installed. 5 grammars (JS/TS/Python/HTML) are bundled as dependencies. The remaining 16 can be installed individually as `tree-sitter-*` packages. Without grammars, the chunker falls back to a sliding window (still functional, just less precise).

## License

MIT

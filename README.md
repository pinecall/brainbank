<p align="center">
  <img src="assets/architecture.png" alt="BrainBank" width="600">
</p>

<h1 align="center">🧠 BrainBank</h1>

<p align="center">
  <strong>Persistent, searchable memory for AI agents.</strong><br>
  Index code, git history, documents, and custom data into a single SQLite file —<br>
  then search it all with hybrid vector + keyword retrieval.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/brainbank"><img src="https://img.shields.io/npm/v/brainbank.svg" alt="npm"></a>
  <a href="https://github.com/pinecall/brainbank/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/brainbank.svg" alt="license"></a>
  <a href="https://github.com/pinecall/brainbank"><img src="https://img.shields.io/github/stars/pinecall/brainbank.svg?style=social" alt="stars"></a>
</p>

<p align="center">
  <a href="docs/getting-started.md">Getting Started</a> ·
  <a href="docs/cli.md">CLI Reference</a> ·
  <a href="docs/search.md">Search</a> ·
  <a href="docs/plugins.md">Plugins</a> ·
  <a href="docs/custom-plugins.md">Build a Plugin</a> ·
  <a href="docs/mcp.md">MCP Server</a>
</p>

---

## Why BrainBank?

BrainBank is a **code-aware knowledge engine** — not just a memory layer. It parses your codebase with tree-sitter ASTs, builds a **code graph** (imports, symbols, call references), indexes git history and co-edit patterns, and makes everything searchable with hybrid vector + keyword retrieval.

| | **BrainBank** | **QMD** | **mem0 / Zep** | **LangChain** |
|---|:---:|:---:|:---:|:---:|
| Code-aware (AST) | **20 languages** | ✗ | ✗ | ✗ |
| Code graph | **imports + symbols + calls** | ✗ | ✗ | ✗ |
| Git + co-edits | ✓ | ✗ | ✗ | ✗ |
| Search | **Vector + BM25 + RRF** | Vector + reranker | Vector + graph | Vector only |
| Infra | **Single SQLite file** | Local GGUF | Vector DB + cloud | Vector DB |
| Plugins | **`.use()` builder** | ✗ | ✗ | ✗ |
| Memory | **`@brainbank/memory`** | ✗ | **Core feature** | ✗ |

### Features

- **Modular** — lightweight core + optional `@brainbank/*` plugins
- **Pluggable** — `.use()` only what you need (code, git, docs, or custom)
- **Hybrid search** — vector + BM25 fused with [Reciprocal Rank Fusion](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf)
- **Dynamic collections** — `brain.collection('errors')` for any structured data
- **Pluggable embeddings** — local WASM (free), OpenAI, or Perplexity
- **Multi-repo** — index multiple repositories into one shared database
- **Portable** — single `.brainbank/brainbank.db` file
- **Optional reranker** — Qwen3-0.6B local cross-encoder

---

## Quick Start

```bash
npm i -g brainbank @brainbank/code @brainbank/git @brainbank/docs
```

### CLI — zero code

```bash
brainbank index .                          # scans repo → interactive select → index
brainbank index . --yes                    # skip prompts, auto-select all
brainbank hsearch "rate limiting"           # hybrid search
brainbank kv add decisions "Use Redis..."   # store a memory
brainbank kv search decisions "caching"     # recall it
```

### Programmatic API

```typescript
import { BrainBank } from 'brainbank';
import { code } from '@brainbank/code';
import { git } from '@brainbank/git';

const brain = new BrainBank({ repoPath: '.' })
  .use(code())
  .use(git());

await brain.index();

const results = await brain.hybridSearch('authentication middleware');

const log = brain.collection('decisions');
await log.add('Switched to argon2id for password hashing', { tags: ['security'] });

brain.close();
```

---

## Packages

`brainbank` is the core framework. Plugins are separate `@brainbank/*` packages — install only what you need:

### Indexer Plugins

Data sources that feed into BrainBank's hybrid search engine.

| Package | Description | Install |
|---------|-------------|----------|
| [`@brainbank/code`](packages/code/) | AST chunking, import graph, symbol index (20 languages) | `npm i @brainbank/code` |
| [`@brainbank/git`](packages/git/) | Git history indexing + co-edit analysis | `npm i @brainbank/git` |
| [`@brainbank/docs`](packages/docs/) | Document collection search with smart chunking | `npm i @brainbank/docs` |

### Integrations

Extensions that connect BrainBank to external tools and workflows.

| Package | Description | Install |
|---------|-------------|----------|
| [`@brainbank/memory`](packages/memory/) | Fact extraction + entity graph for conversations | `npm i @brainbank/memory` |
| [`@brainbank/mcp`](packages/mcp/) | MCP server for Antigravity, Claude, Cursor | `npm i @brainbank/mcp` |

---

## Documentation

| Guide | Description |
|-------|-------------|
| **[Getting Started](docs/getting-started.md)** | Installation, quick start, first search |
| **[CLI Reference](docs/cli.md)** | Complete command reference |
| **[Plugins](docs/plugins.md)** | Built-in plugins overview + configuration |
| **[Collections](docs/collections.md)** | Dynamic KV store with semantic search |
| **[Search](docs/search.md)** | Hybrid search, scoped queries, context generation |
| **[Custom Plugins](docs/custom-plugins.md)** | Build plugins + publish as npm packages |
| **[Configuration](docs/config.md)** | `.brainbank/config.json`, env vars |
| **[Embeddings & Reranker](docs/embeddings.md)** | Providers, benchmarks, per-plugin overrides |
| **[Multi-Repo](docs/multi-repo.md)** | Index multiple repositories into one DB |
| **[MCP Server](docs/mcp.md)** | AI tool integration (stdio) |
| **[Memory](docs/memory.md)** | Agent patterns + `@brainbank/memory` |
| **[Indexing](docs/indexing.md)** | Code graph, incremental indexing, re-embedding |
| **[Architecture](docs/architecture.md)** | System internals, data flows, design patterns |

---

## Examples

| Example | Description |
|---------|-------------|
| [notes-plugin](examples/notes-plugin/) | Programmatic plugin — reads `.txt` files |
| [custom-plugin](examples/custom-plugin/) | CLI auto-discovery plugin |
| [custom-package](examples/custom-package/) | Standalone npm package scaffold |
| [collection](examples/collection/) | Collections, search, tags, metadata |
| [rag](examples/rag/) | RAG chatbot — docs retrieval + generation ¹ |
| [memory](examples/memory/) | Memory chatbot — fact extraction + entity graph ¹ |

> ¹ Requires `OPENAI_API_KEY`. RAG also requires `PERPLEXITY_API_KEY`.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## License

[MIT](LICENSE)

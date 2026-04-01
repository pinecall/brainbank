# 🧠 BrainBank

**Persistent, searchable memory for AI agents.** Index your codebase, git history, documents, and any custom data into a single SQLite file — then search it all with hybrid vector + keyword retrieval.

BrainBank gives LLMs a long-term memory that persists between sessions.

- **Pluggable** — `.use()` only what you need: [code](#packages), [git](#packages), [docs](#packages), or [custom](docs/custom-plugins.md)
- **Hybrid search** — vector + BM25 fused with Reciprocal Rank Fusion
- **Dynamic collections** — `brain.collection('errors')` for any structured data
- **Pluggable embeddings** — local WASM (free), OpenAI, or Perplexity
- **Portable** — single `.brainbank/brainbank.db` SQLite file
- **Modular** — lightweight core + optional [`@brainbank/*`](#packages) packages

---

<img src="assets/architecture.png" alt="BrainBank Architecture" width="600">

---

## Quick Start

```bash
npm i -g brainbank @brainbank/code @brainbank/git @brainbank/docs
```

> If you get `ERESOLVE` errors, use `npm i --legacy-peer-deps` — tree-sitter grammars have overlapping peer dep ranges.

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

`brainbank` is the core framework — strictly plugin-agnostic. Plugins are separate `@brainbank/*` packages that own their database schema, search strategies, and context formatting. Install only what you need:

### Indexer Plugins

Data sources that feed into BrainBank's hybrid search engine. Each plugin manages its own tables via the built-in migration system.

| Package | Description | Install |
|---------|-------------|----------|
| [`@brainbank/code`](packages/code/) | AST chunking, import graph, symbol index (20 languages) | `npm i @brainbank/code` |
| [`@brainbank/git`](packages/git/) | Git history indexing + co-edit analysis | `npm i @brainbank/git` |
| [`@brainbank/docs`](packages/docs/) | Document collection search with smart chunking | `npm i @brainbank/docs` |

### Integrations

Extensions that connect BrainBank to external tools and workflows.

| Package | Description | Install |
|---------|-------------|----------|
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

> ¹ Requires `OPENAI_API_KEY`. RAG also requires `PERPLEXITY_API_KEY`.

---

## Benchmarks

Early benchmarks on Apple Silicon — single SQLite file, no external vector DB.

| Benchmark | Corpus | Metric | Score |
|-----------|--------|--------|:-----:|
| [BEIR SciFact](https://github.com/beir-cellar/beir) | 5,183 scientific abstracts, 300 queries | NDCG@10 | **0.761** |
| Custom RAG eval | 127 Pinecall.io docs, 20 queries — 1 miss | R@5 | **83%** |

**Pipeline progression** — each stage's impact on the custom eval:

| Stage | R@5 | Δ |
|-------|:---:|---|
| Vector-only (HNSW) | 57% | — |
| + BM25 → RRF | 78% | +21pp |
| + Qwen3 reranker | 83% | +5pp |

> More benchmarks (code+graph retrieval, large-scale stress tests, multi-provider comparisons) are in progress.
> Full methodology and reproduction commands → [docs/benchmarks.md](docs/benchmarks.md)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## License

[MIT](LICENSE)

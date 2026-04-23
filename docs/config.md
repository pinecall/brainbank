# Configuration

## Project Config File

Drop a `.brainbank/config.json` in your repo root. Every `brainbank index` reads it automatically — no CLI flags needed.

```jsonc
// .brainbank/config.json
{
  // Which built-in plugins to load (default: all three)
  "plugins": ["code", "git", "docs"],

  // Per-plugin options
  "code": {
    "embedding": "openai",
    "maxFileSize": 512000,
    "include": [
      "src/**",
      "lib/**"
    ],
    "ignore": [
      "sdk/**",
      "vendor/**",
      "**/*.generated.ts",
      "**/*.min.js",
      "test/fixtures/**"
    ]
  },
  "git": {
    "depth": 200,
    "maxDiffBytes": 8192
  },
  "docs": {
    "embedding": "perplexity-context",
    "collections": [
      { "name": "docs", "path": "./docs", "pattern": "**/*.md" },
      { "name": "wiki", "path": "~/team-wiki", "pattern": "**/*.md", "ignore": ["drafts/**"] }
    ]
  },

  // Global defaults
  "embedding": "local",
  "reranker": "qwen3",
  "pruner": "haiku",

  // Context field defaults (applied to all getContext() calls)
  "context": {
    "lines": false,
    "callTree": { "depth": 2 },
    "symbols": false,
    "imports": true,
    "compact": false
  },

  // Multi-repo: only these subdirectories are indexed (optional whitelist)
  "repos": ["webapp-backend", "webapp-frontend"],

  // BrainBank constructor overrides
  "brainbank": {
    "maxFileSize": 512000,
    "hnswM": 16,
    "hnswEfConstruction": 200,
    "hnswEfSearch": 50
  },

  // Optional API keys (override env vars — useful for CI/CD, MCP, GUI apps)
  "keys": {
    "anthropic": "sk-ant-...",    // pruner & expander
    "perplexity": "pplx-...",     // Perplexity embeddings
    "openai": "sk-..."            // OpenAI embeddings
  }
}
```

---

## Directory Structure

```
.brainbank/
├── config.json         # Project config (optional)
├── plugins/            # Custom plugin files (optional, auto-discovered)
│   ├── notes.ts
│   └── csv.ts
└── data/               # All generated files (auto-created, gitignored)
    ├── brainbank.db    # SQLite database (core + KV tables)
    ├── hnsw-kv.index   # HNSW graph for KV collections
    ├── hnsw-code.index # HNSW graph for code (or hnsw-code:backend.index in multi-repo)
    ├── hnsw-git.index  # HNSW graph for git
    └── hnsw-docs.index # HNSW graph for docs
```

In multi-repo setups, per-repo plugin databases live alongside the main DB:

```
.brainbank/data/
├── brainbank.db        # Root DB: KV, embedding_meta, index_state
├── backend.db          # code:backend + git:backend domain tables
└── frontend.db         # code:frontend + git:frontend domain tables
```

---

## Embedding Keys

| Key | Provider | Dims | Cost |
|-----|----------|------|------|
| `"local"` (default) | WASM (all-MiniLM-L6-v2) | 384 | Free |
| `"openai"` | OpenAI (text-embedding-3-small) | 1536 | $0.02/1M tokens |
| `"perplexity"` | Perplexity (pplx-embed-v1-4b) | 2560 | $0.02/1M tokens |
| `"perplexity-context"` | Perplexity contextualized | 2560 | $0.06/1M tokens |

---

## Per-Plugin Embeddings

Each plugin creates its own HNSW index with the correct dimensions. A plugin without an `embedding` key uses the global default:

```jsonc
{
  "embedding": "local",              // global default (384d)
  "code": { "embedding": "openai" }, // code uses OpenAI (1536d)
  "git": {},                         // git uses local (384d)
  "docs": { "embedding": "perplexity-context" }  // docs uses Perplexity (2560d)
}
```

---

## Reranker & Pruner

| Key | Options | Description |
|-----|---------|-------------|
| `reranker` | `"qwen3"` | Re-ranks search results using a cross-encoder model for better ordering |
| `pruner` | `"haiku"` | LLM noise filter — drops irrelevant results before context formatting. Requires `ANTHROPIC_API_KEY` |
| `expander` | `"haiku"` | LLM context expansion — discovers additional relevant chunks after pruning. **Explicit opt-in only** — never auto-enabled. Requires `ANTHROPIC_API_KEY` |

All three are optional. Set in config or via CLI flags (`--reranker qwen3`, `--pruner haiku`).

The pruner runs **after** search + path scoping, **before** formatting. Fails open — if the API call fails, all results pass through.

> See [Embeddings, Reranker & Pruner](embeddings.md) for detailed pipeline diagrams and benchmarks.

---

## Context Field Defaults

The `context` section sets defaults for all `getContext()` and `brainbank context` calls. These are overridden by per-query `fields` options:

```jsonc
{
  "context": {
    "lines": false,           // line number prefixes off by default
    "callTree": true,         // call tree enabled (or { "depth": 2 })
    "imports": true,          // dependency summary enabled
    "symbols": false,         // symbol index disabled
    "compact": false          // full bodies, not just signatures
  }
}
```

Field resolution order: **plugin defaults ← config.json `context` ← per-query `fields`**.

---

## Include Whitelist (Code Plugin)

The `code` plugin supports an `include` option — the inverse of `ignore`. When set, **only** files matching the include patterns are indexed. `ignore` still applies on top (exclude always wins).

```jsonc
{
  "code": {
    "include": ["src/**", "lib/**"],     // only index these folders
    "ignore": ["src/generated/**"]        // still excluded from indexing
  }
}
```

### How Include + Ignore Work Together

| Scenario | What gets indexed |
|----------|------------------|
| No `include`, no `ignore` | Everything (respecting built-in exclusions like `node_modules`) |
| `include` only | Only files matching include patterns |
| `ignore` only | Everything except files matching ignore patterns |
| Both `include` and `ignore` | Files matching include, minus those matching ignore |

### Directory Pruning

BrainBank extracts static base prefixes from include patterns (e.g. `src` from `src/**`) and skips entire directory trees that cannot match — so whitelisting `src/**` on a large monorepo won't waste time walking `node_modules/`, `vendor/`, etc.

### CLI Override

```bash
brainbank index . --include "src/**,lib/**"
```

CLI `--include` patterns are merged with `config.json` patterns. See [CLI Reference](cli.md#index) for details.

---

## Custom Plugin Config

Custom plugins auto-discovered from `.brainbank/plugins/` can have their own config section, matched by plugin name:

```jsonc
{
  "plugins": ["code", "git"],
  "notes": { "embedding": "local" },
  "csv": { "embedding": "openai" }
}
```

---

## Config Priority

```
CLI flags          (highest)
config.json        fields
auto-resolve       from DB (for embedding provider)
defaults           (lowest)
```

> `.brainbank/config.ts` (or `.js`, `.mjs`) is also supported for programmatic config with custom plugin instances. JSON is preferred for declarative setups.

No config file? The CLI uses all built-in plugins with local embeddings — **zero config required**.

---

## API Keys

API keys can be provided in **config.json** or via **environment variables**. Config keys take priority.

```jsonc
{
  "keys": {
    "anthropic": "sk-ant-...",   // for pruner & expander
    "perplexity": "pplx-...",    // for Perplexity embeddings
    "openai": "sk-..."           // for OpenAI embeddings
  }
}
```

> **Resolution order:** `config.json keys` → `environment variables` → error.
>
> Keys in config.json are useful for CI/CD, MCP servers, and environments where shell env vars aren't available (GUI apps like Cursor, Antigravity).
> For local dev, env vars via shell profile (`~/.zshrc`) work fine too.

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `BRAINBANK_DEBUG` | Show full stack traces in CLI errors |
| `OPENAI_API_KEY` | Required when using `--embedding openai` (or set `keys.openai` in config) |
| `PERPLEXITY_API_KEY` | Required when using `--embedding perplexity` or `perplexity-context` (or set `keys.perplexity` in config) |
| `ANTHROPIC_API_KEY` | Required when using `--pruner haiku` or `expander: haiku` (or set `keys.anthropic` in config) |
| `BRAINBANK_EMBEDDING` | Fallback embedding key (`local`, `openai`, `perplexity`, `perplexity-context`) |

> **Recommended:** Set keys in `.brainbank/config.json` `keys` section instead of relying on env vars — keeps your environment clean and works across all contexts (CLI, MCP, CI).

---

## See Also

- [Embeddings, Reranker & Pruner](embeddings.md) — provider details, benchmarks, reranker & pruner config
- [Plugins](plugins.md) — per-plugin embedding override
- [Multi-Repo](multi-repo.md) — `repos` whitelist and per-repo databases

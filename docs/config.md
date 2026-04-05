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

  // BrainBank constructor overrides
  "brainbank": {
    "maxFileSize": 512000,
    "hnswM": 16,
    "hnswEfConstruction": 200,
    "hnswEfSearch": 50
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
    ├── brainbank.db    # SQLite database
    ├── hnsw-kv.index   # HNSW graph for KV collections
    ├── hnsw-code.index # HNSW graph for code (shared across code:* plugins)
    ├── hnsw-git.index  # HNSW graph for git
    └── hnsw-docs.index # HNSW graph for docs
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

Both are optional. Set in config or via CLI flags (`--reranker qwen3`, `--pruner haiku`).

The pruner runs **after** search + path scoping, **before** formatting. Fails open — if the API call fails, all results pass through.

> See [Embeddings, Reranker & Pruner](embeddings.md) for detailed pipeline diagrams and benchmarks.

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

## Environment Variables

| Variable | Description |
|----------|-------------|
| `BRAINBANK_DEBUG` | Show full stack traces in CLI errors |
| `OPENAI_API_KEY` | Required when using `--embedding openai` |
| `PERPLEXITY_API_KEY` | Required when using `--embedding perplexity` or `perplexity-context` |
| `ANTHROPIC_API_KEY` | Required when using `--pruner haiku` |
| `BRAINBANK_EMBEDDING` | Fallback embedding key (`local`, `openai`, `perplexity`, `perplexity-context`) |

> **Recommended:** Set `"embedding"` in `.brainbank/config.json` instead of relying on env vars — the interactive `brainbank index` prompt saves it for you automatically.

---

## See Also

- [Embeddings, Reranker & Pruner](embeddings.md) — provider details, benchmarks, reranker & pruner config
- [Plugins](plugins.md) — per-plugin embedding override

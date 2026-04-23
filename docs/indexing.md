# Indexing

How BrainBank processes and stores your codebase for search.

## Code Chunking (tree-sitter)

BrainBank uses **native tree-sitter** to parse source code into ASTs and extract semantic blocks — functions, classes, methods, interfaces — as individual chunks. This produces dramatically better embeddings than naive line-based splitting.

### Supported Languages

| Category | Languages |
|----------|-----------|
| **Web** | TypeScript, JavaScript, HTML, CSS |
| **Systems** | Go, Rust, C, C++, Swift |
| **JVM** | Java, Kotlin, Scala |
| **Scripting** | Python, Ruby, PHP, Lua, Bash, Elixir |
| **.NET** | C# |

For large classes (>80 lines), the chunker descends into the class body and extracts each method as a separate chunk. For unsupported languages or missing grammars, it falls back to a sliding window with 5-line overlap.

> 5 grammars (JS/TS/Python/HTML) are bundled. Install additional languages with `npm i -g tree-sitter-<lang>`.

---

## Dual-Level Vectors

`@brainbank/code` indexes each file at **two levels** simultaneously, stored as different chunk types in `code_chunks`:

| Chunk type | What it is | Used for |
|------------|-----------|----------|
| `function` / `class` / `method` | AST-extracted semantic block | Precise function-level matching |
| `synopsis` | Full-file embedding with imports header | Broad file-level matching |

During search, HNSW hits are split by type and cross-level scored:
- **Both levels match** → `max(scores) × 1.4` boost
- **Chunk only** → `score × 0.7` penalty (likely noise)
- **Synopsis only** → score unchanged

This catches both "find files about X" and "find the specific function that does X".

---

## Code Graph

Beyond chunking, BrainBank builds a **relationship-aware code graph** during indexing. This gives the context builder (and your LLM) a deeper understanding of how code connects.

### What Gets Indexed

| Layer | Table | What it captures | Example |
|-------|-------|------------------|---------|
| **Imports** | `code_imports` | File-level dependencies | `agent.ts` → `call`, `config`, `emitter` |
| **Symbols** | `code_symbols` | Function/class/method defs with line + chunk link | `TurnManager.on_vad_start` (method, L420) |
| **Call Refs** | `code_refs` | Function calls within each chunk | `on_vad_start` calls `_clear_all_bot_audio`, `emit` |
| **Call Edges** | `code_call_edges` | Chunk-to-chunk call graph | `handleRequest` (chunk #42) → `validateToken` (chunk #17) |

### Import Extraction

Regex-based (fast, no AST needed) across all 20 languages. After indexing, a **linking pass** builds `code_call_edges` from `code_refs → code_symbols`:

```
Pass 1: exact name match  (validateToken → validateToken chunk)
Pass 2: method suffix     (on_turn_end   → TurnController.on_turn_end chunk)
```

### Enriched Embeddings

The code graph improves **embedding quality**. Each chunk's embedding text includes import context and parent class:

```diff
- File: src/session/turn_manager.py
- function: on_vad_start
- <code>

+ File: src/session/turn_manager.py
+ Imports: asyncio, logging, domain.turn, processors.audio.vad
+ Class: TurnManager
+ method: TurnManager.on_vad_start
+ <code>
```

Searching for "VAD processing in turn manager" finds the right chunk even if the code doesn't mention "turn manager" — because the embedding captures the file context.

### Context Output

The `getContext()` output gains two enrichments from `@brainbank/code`'s `ContextFormatterPlugin`:

**1. V4 Workflow Trace** — flat `## Code Context` section:
- Seed chunks first, then call tree DFS with `called by` annotations
- Part-adjacency: if "foo (part 5)" matched → siblings ±2 included
- Trivial wrappers (≤2 meaningful lines) → compact one-liner
- Test files and infra files excluded from call tree

**2. Dependency summary** — split into downstream (what matched code imports) and upstream (what imports matched code).

---

## Docs Chunking (heading-aware)

The `@brainbank/docs` plugin uses a heading-aware smart chunker inspired by [qmd](https://github.com/qmd-ai/qmd):

- **Target:** ~3000 chars per chunk (~900 tokens)
- **Break point scoring:** H1=100, H2=90, H3=80, code-fence-close=80, HR=60, blank=20, list-item=5
- **Distance decay:** Score × (1 - (distance/window)² × 0.7) — prefers breaks near the target length
- **Minimum chunk:** 200 chars (tiny chunks merged into previous)

The docs plugin also implements `IndexablePlugin`, so it participates in `brain.index()` alongside code and git.

---

## Incremental Indexing

All indexing is **incremental by default** — only new or changed content is processed.

### IncrementalTracker (recommended)

The core `IncrementalTracker` provides a shared `plugin_tracking` table that any plugin can use for change detection without creating custom tables:

```typescript
const tracker = ctx.createTracker();  // scoped to plugin name

for (const file of files) {
    const hash = sha256(content);
    if (tracker.isUnchanged(file, hash)) { skipped++; continue; }
    await indexFile(file, content);
    tracker.markIndexed(file, hash);
}

// Detect deleted files
for (const orphan of tracker.findOrphans(new Set(files))) {
    removeData(orphan);
    tracker.remove(orphan);
}
```

See [Custom Plugins — Incremental Tracking](custom-plugins.md#incremental-tracking) for the full API.

### Per-plugin strategies

| Plugin | Tracker | Hash algorithm | What gets skipped |
|--------|---------|---------------|-------------------|
| **Code** | Custom `indexed_files` table | FNV-1a (fast, 32-bit) | Unchanged files |
| **Git** | Unique commit hash + vector existence | SHA | Already-indexed commits |
| **Docs** | `IncrementalTracker` | SHA-256 (16 chars) | Unchanged documents |

### HNSW Consistency

Code and git plugins apply HNSW mutations **after** the DB transaction commits. If the transaction rolls back, the in-memory HNSW stays consistent with the database. Old chunk IDs are collected before the transaction, then `hnsw.remove()` + `hnsw.add()` run only on successful commit.

---

## Include Whitelist

`@brainbank/code` supports an `include` option to restrict indexing to specific folders or glob patterns — the inverse of `ignore`.

### Usage

```typescript
brain.use(code({ include: ['src/**', 'lib/**'] }));
```

```bash
brainbank index . --include "src/**,lib/**"
```

```jsonc
// .brainbank/config.json
{ "code": { "include": ["src/**", "lib/**"] } }
```

### How It Works

1. **File filtering** — files are matched against include patterns using `picomatch`. Only matching files proceed to chunking and embedding.
2. **Directory pruning** — BrainBank extracts static base prefixes from include patterns (e.g. `src` from `src/**`) using `picomatch.scan()`. Entire directory subtrees that don't match any prefix are skipped during the walk — so whitelisting `src/**` won't waste time traversing `node_modules/`, `vendor/`, etc.
3. **Precedence** — `ignore` always wins over `include`. A file matching both `include: ['src/**']` and `ignore: ['src/generated/**']` is excluded.

### Combined Example

```jsonc
{
  "code": {
    "include": ["src/**", "lib/**"],
    "ignore": ["src/generated/**", "**/*.test.ts"]
  }
}
```

This indexes only `src/` and `lib/`, but skips generated code and test files within those folders.

---

## Concurrent File Indexing

`@brainbank/code` processes files in **parallel batches of 5** (CONCURRENCY = 5). Within each file, chunk embeddings and the file synopsis are merged into a **single `embedBatch` call**, halving API round-trips. Net effect: ~10× faster indexing on API-based embedding providers.

---

## Re-embedding

When switching embedding providers, `reembed()` regenerates only the vectors — no file I/O, no re-chunking:

```typescript
const brain = new BrainBank({ embeddingProvider: new OpenAIEmbedding() });
await brain.initialize({ force: true });

const result = await brain.reembed({
  onProgress: (table, current, total) => console.log(`${table}: ${current}/${total}`),
});
```

```bash
brainbank reembed
```

| Full re-index | `reembed()` |
|---|---|
| Walks all files | **Skipped** |
| Parses git history | **Skipped** |
| Re-chunks documents | **Skipped** |
| Embeds text | ✓ |
| Replaces vectors | ✓ (atomic swap via temp table) |
| Rebuilds HNSW | ✓ (reinit + reload from new BLOBs) |

The reembed engine collects tables from two sources:
1. **Plugins** implementing `ReembeddablePlugin` (code, git, docs provide `reembedConfig()`)
2. **Core tables** always included: `kv_data`→`kv_vectors`

Tables are deduplicated by `vectorTable` name (important for multi-repo where `code:frontend` and `code:backend` share the same `code_vectors` table).

> BrainBank tracks provider metadata in the `embedding_meta` table. It auto-detects dimension mismatches and refuses to initialize — use `initialize({ force: true })` then `reembed()` to migrate.

---

## Multi-Project Isolation

Each project has its own `.brainbank/` database. In multi-repo setups (same DB, different `code:frontend` / `code:backend` plugins), file paths are relative to each repo root — no collisions. Same-type plugins share a single HNSW index (e.g. all `code:*` share `hnsw-code.index`).

> **Current schema version: v9.** Domain tables (`code_chunks`, `git_commits`, `doc_chunks`, etc.) are now created by their respective plugins via the per-plugin migration system (`runPluginMigrations()`). The core schema contains only framework tables (`schema_version`, `plugin_versions`, `kv_data`, `kv_vectors`, `embedding_meta`, `index_state`, `plugin_tracking`). Plugin schema versions are tracked in the `plugin_versions` table.

---

## See Also

- [Getting Started](getting-started.md) — first indexing walkthrough
- [Embeddings](embeddings.md) — provider details and re-embedding
- [Multi-Repo](multi-repo.md) — indexing multiple repositories

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

For large classes (>80 lines), the chunker descends into the class body and extracts each method as a separate chunk. For unsupported languages, it falls back to a sliding window with overlap.

> 5 grammars (JS/TS/Python/HTML) are bundled. Install additional languages with `npm i -g tree-sitter-<lang>`.

---

## Code Graph

Beyond chunking, BrainBank builds a **relationship-aware code graph** during indexing. This gives the context builder (and your LLM) a deeper understanding of how code connects.

### What Gets Indexed

| Layer | Table | What it captures | Example |
|-------|-------|------------------|---------|
| **Imports** | `code_imports` | File-level dependencies | `agent.ts` → `call`, `config`, `emitter` |
| **Symbols** | `code_symbols` | Function/class/method defs | `TurnManager.on_vad_start` (method, L420) |
| **Call Refs** | `code_refs` | Function calls within chunks | `on_vad_start` calls `_clear_all_bot_audio`, `emit` |

### Import Extraction

Regex-based (fast, no AST needed) across all 20 languages:

| Language Family | Patterns Matched |
|----------------|------------------|
| JS/TS | `import ... from '...'`, `require('...')` |
| Python | `import X`, `from X import Y` |
| Go | `import "pkg"`, `import (...)` |
| Ruby | `require 'X'`, `require_relative 'X'` |
| Rust | `use X::Y`, `mod X` |
| Java/Kotlin/Scala | `import X.Y.Z` |
| C/C++ | `#include <X>`, `#include "X"` |
| Others | PHP, Elixir, Lua, Swift, Bash, CSS, HTML |

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

The `getContext()` / `brainbank context` output gains two enrichments:

**1. Call graph annotations** on each code block:
```
**method `on_vad_start` (L420-480)** — 95% match
  *(calls: _clear_all_bot_audio, emit | called by: on_speech_ended)*
```

**2. Related Files** showing the import graph:
```markdown
## Related Files (Import Graph)

- → domain.turn                      # this file imports
- → processors.audio.vad             # this file imports
- ← tests/test_turn_manager.py       # imported by
- ← session/call_handler.py          # imported by
```

---

## Incremental Indexing

All indexing is **incremental by default** — only new or changed content is processed:

| Plugin | Change detection | What gets skipped |
|--------|-----------------|-------------------|
| **Code** | FNV-1a file hash | Unchanged files |
| **Git** | Unique commit hash | Already-indexed commits |
| **Docs** | SHA-256 content hash | Unchanged documents |

```typescript
await brain.index();  // → { indexed: 500, skipped: 0 }   first run
await brain.index();  // → { indexed: 0, skipped: 500 }   second run
await brain.index();  // → { indexed: 1, skipped: 499 }   changed 1 file
```

Use `--force` to re-index everything:

```bash
brainbank index --force
```

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
| Replaces vectors | ✓ |
| Rebuilds HNSW | ✓ |

> BrainBank tracks provider metadata in the `embedding_meta` table. It auto-detects dimension mismatches and refuses to initialize — use `initialize({ force: true })` then `reembed()` to migrate.

---

## Multi-Project Isolation

Each project has its own `.brainbank/` database. In multi-repo setups (same DB, different `code:frontend` / `code:backend` plugins), file paths are relative to each repo root — no collisions.

> **Current schema version: v6.** The code graph tables (`code_imports`, `code_symbols`, `code_refs`) were introduced in v5. Existing databases are auto-migrated via `CREATE TABLE IF NOT EXISTS` on first run.

---

## See Also

- [Getting Started](getting-started.md) — first indexing walkthrough
- [Embeddings](embeddings.md) — provider details and re-embedding
- [Multi-Repo](multi-repo.md) — indexing multiple repositories

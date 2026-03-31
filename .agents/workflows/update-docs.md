---
description: Analyze docs/architecture.md against actual codebase and fix stale references
---

# /update-docs workflow

Run this when the user says `/update-docs` or after a significant refactor to sync documentation with the codebase.

## Target

The full `docs/` directory. Process in priority order:

| Priority | File | Size | What to check |
|----------|------|------|---------------|
| 1 | `docs/architecture.md` | ~3400 lines | Interfaces, method signatures, pseudocode flows, ASCII diagrams, CLI mappings |
| 2 | `docs/search.md` | ~120 lines | Search API examples, options, mode descriptions |
| 3 | `docs/cli.md` | ~180 lines | Command flags, usage examples, output samples |
| 4 | `docs/collections.md` | ~150 lines | Collection API, search modes |
| 5 | `docs/mcp.md` | ~130 lines | MCP tool schemas, parameter names |
| 6 | `docs/getting-started.md` | ~120 lines | Quick-start code examples |
| 7 | `docs/plugins.md` | ~100 lines | Plugin API, `.use()` examples |
| 8 | `docs/custom-plugins.md` | ~180 lines | Plugin interface, capability examples |
| 9 | `docs/embeddings.md` | ~200 lines | Provider API, config examples |
| 10 | `docs/indexing.md` | ~140 lines | Index API, options |
| 11 | `docs/config.md` | ~90 lines | Config shape, defaults |
| 12 | `docs/memory.md` | ~100 lines | Memory API examples |
| 13 | `docs/multi-repo.md` | ~75 lines | Multi-repo setup |
| 14 | `docs/benchmarks.md` | ~180 lines | Benchmark scripts, results format |

Also check:
- `README.md` (root) — public-facing examples and API overview
- `AGENTS.md` — Key Files, Code Conventions, Gotchas sections

---

## Steps

### 1. Read `docs/architecture.md` in chunks of 800 lines

// turbo-all

Read the entire file systematically:

```
view_file docs/architecture.md lines 1-800
view_file docs/architecture.md lines 801-1600
view_file docs/architecture.md lines 1601-2400
view_file docs/architecture.md lines 2401-3200
view_file docs/architecture.md lines 3201-end
```

While reading, build a mental inventory of every:
- **Interface/type definition** mentioned (e.g. `SearchOptions`, `ContextOptions`, `Plugin`)
- **Method signatures** listed (e.g. `.search()`, `.hybridSearch()`, params and defaults)
- **Pseudocode flows** (e.g. `hybridSearch` flow, `ContextBuilder.build()` flow)
- **Data flow diagrams** (§17.x ASCII diagrams with example API calls)
- **CLI flag mappings** (e.g. `--code 10 → sources.code = 10`)
- **Class/function names** referenced in any section

### 2. Read all other docs files

Read each remaining file in `docs/` (they're small, ~100-200 lines each):

```
view_file docs/search.md
view_file docs/cli.md
view_file docs/collections.md
view_file docs/mcp.md
view_file docs/getting-started.md
view_file docs/plugins.md
view_file docs/custom-plugins.md
view_file docs/embeddings.md
view_file docs/indexing.md
view_file docs/config.md
view_file docs/memory.md
view_file docs/multi-repo.md
view_file docs/benchmarks.md
```

Also read:
```
view_file README.md
view_file AGENTS.md
```

For each file, note any API examples, interface references, or CLI usage that could be stale.

### 3. Cross-reference against actual source files

For each documented item found in steps 1-2, verify against the real source:

```
# Core interfaces
view_file src/types.ts
view_file src/search/types.ts
view_file src/plugin.ts

# Facade API
view_file src/brainbank.ts

# Engine
view_file src/engine/search-api.ts
view_file src/engine/index-api.ts

# Search layer
view_file src/search/vector/composite-vector-search.ts
view_file src/search/keyword/keyword-search.ts
view_file src/search/context-builder.ts

# CLI
view_file src/cli/commands/search.ts

# MCP
view_file packages/mcp/src/mcp-server.ts
```

Only read files that are referenced in the docs. Skip files that look correct.

### 4. Build a diff checklist

Create a checklist of every stale reference found. **Group by file, then by section:**

```markdown
### Stale references found

**docs/architecture.md**
- [ ] §3 Facade API: `.searchCode()` listed but deleted from `brainbank.ts`
- [ ] §11.2 SearchOptions: `codeK`/`gitK` but source uses `sources`
- [ ] §17.3 Data flow diagram: example uses `{ codeK: 10 }`

**docs/search.md**
- [ ] Line 45: example uses `brain.search(q, { codeK: 10 })`
- [ ] Line 80: `searchCode()` referenced but deleted

**docs/cli.md**
- [ ] Line 32: `--codeK` flag no longer exists

**README.md**
- [ ] Quick-start example uses old API

(no issues found in: config.md, memory.md, multi-repo.md, benchmarks.md)
```

**Show the checklist to the user before making changes.** Ask: "Found N stale references across M files. Proceed with fixes?"

### 5. Apply all fixes

For each stale item:
1. Use `multi_replace_file_content` to batch non-contiguous edits in the same file
2. Prefer surgical replacements (target the exact stale line) over rewriting entire sections
3. Preserve the existing formatting, indentation, and ASCII art style
4. Process files in priority order (architecture.md first)

**Common stale patterns to watch for:**
- Deleted methods still listed in API tables
- Renamed/refactored parameters (e.g. `codeK` → `sources.code`)
- Old interface shapes in pseudocode blocks
- Example API calls with outdated syntax
- CLI flag mappings referencing old param names
- Class names that were renamed or split
- Auto-init method lists mentioning deleted methods
- Import paths that changed

### 6. Verify no stale references remain

Run grep for every stale term that was fixed, across ALL docs:

```
grep -rn '<term1>\|<term2>\|<term3>' docs/ README.md AGENTS.md
```

Replace `<termX>` with the specific terms that were updated (e.g. `searchCode`, `codeResults`, `patternK`).

If any remain, fix them. Repeat until grep returns only legitimate references (e.g. internal variable names in pseudocode).

### 7. Confirm

Tell the user: "✅ Documentation updated. N stale references fixed across M files."

List which files were changed and which were clean.

---

## What NOT to change

- **Internal variable names in pseudocode** — If the doc shows `codeK = sources.code ?? 20` as a local variable assignment, that's correct even if `codeK` was removed from the public API. The local var name matches the actual source code.
- **Architectural descriptions** — Don't rewrite prose descriptions unless they reference something factually wrong.
- **Section numbering** — Don't renumber sections, only fix content within them.
- **ASCII diagram structure** — Keep the box-drawing characters and layout; only fix the text inside.
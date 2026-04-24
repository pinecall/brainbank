# Technical Debt

Known limitations, workarounds, and planned improvements. Ordered by impact.

---

## 1. Workspace Package Import Resolution

**Impact:** High — affects call tree, expander, and dependency graph quality  
**Location:** `packages/code/src/graph/import-resolver.ts`, `packages/code/src/indexing/walker.ts`

### Problem

The `ImportResolver` resolves relative imports (`./foo`, `../bar`) and local paths accurately, but **cannot resolve monorepo workspace packages**. When a file imports `@pinecall/sdk` or `@brainbank/code`, the resolver doesn't know that `@pinecall/sdk` maps to `packages/sdk-js/src/index.ts`. These imports are stored in `code_imports` with `resolved = 0`.

```
code_imports:
  file_path       | imports_path    | resolved
  src/engine.ts   | @pinecall/sdk   | 0          ← unresolved
  src/engine.ts   | ./types.ts      | 1          ← resolved
```

### What This Breaks

- **Call tree:** `buildCallTree()` in `traversal.ts` requires `code_imports.resolved = 1` to validate call edges (the `EXISTS` subquery on L531). Unresolved imports mean cross-package function calls are invisible.
- **Dependency graph:** `_forwardBFS` and `_reverseBFS` only follow `resolved = 1` edges, so workspace packages are missing from the graph.
- **Expander:** The `HaikuExpander` uses `code_imports` to find 1-hop import neighbors. Unresolved workspace imports create gaps in the dependency-based chunk discovery.

### Current Workaround

`_symbolBFS()` in `traversal.ts` (L560-600) provides a symbol-based fallback: it finds all `code_refs` (function calls) in seed files, then looks up where those symbols are defined in `code_symbols`. This bypasses `code_imports` entirely and works ~90% of the time, but:

- It's name-based, not path-based — generic names like `create`, `search` produce false edges.
- It doesn't distinguish between same-name symbols in different packages.
- It doesn't help the call tree's `EXISTS` filter.

### Proposed Solution

Teach `ImportResolver` to read workspace mappings at index time:

```typescript
// During CodeWalker construction, read workspace packages
const workspaceMap = loadWorkspaceMap(repoPath);
// { '@pinecall/sdk': 'packages/sdk-js/src/index.ts', ... }

// In resolve(), add a workspace resolution step before tail-fallback:
if (workspaceMap.has(specifier)) {
    return workspaceMap.get(specifier);
}
// Also handle sub-path imports: @pinecall/sdk/utils → packages/sdk-js/src/utils.ts
```

**Implementation steps:**

1. Add `loadWorkspaceMap(repoPath)` that reads `package.json` `workspaces` field, then each workspace's `package.json` `name` + `exports`/`main` to build a `Map<string, string>`
2. Pass the map into `ImportResolver` constructor
3. In `resolve()`, check workspace map before tail-fallback
4. Handle scoped packages (`@scope/name`) and sub-path exports (`@scope/name/sub`)

**Effort:** Medium (~2-3 hours). No schema changes needed — existing `code_imports` rows with `resolved = 0` would become `resolved = 1` on next reindex.

---

## 2. Residual Reranker Interface in types.ts

**Impact:** Medium — dead code in public API surface  
**Location:** `src/types.ts`, `packages/docs/src/document-search.ts`, `packages/docs/src/docs-plugin.ts`

### Problem

The `Reranker` interface, the `reranker` field in `BrainBankConfig` and `ResolvedConfig`, and the `rerank()` export were intentionally kept during the reranker removal to avoid a breaking change for external consumers. However, internal code still references them:

- `DocumentSearch` accepts `reranker` in its deps and has a `_rerankResults()` method that imports `rerank` from `'brainbank'` — this is dead code since no reranker is ever instantiated.
- `DocsPlugin.initialize()` passes `ctx.config.reranker` to `DocumentSearch`.

### Proposed Solution

**Phase 1 (safe):** Remove the internal dead code paths:
- Delete `_rerankResults()` from `document-search.ts`
- Remove `reranker` from `DocumentSearchDeps`
- Remove `ctx.config.reranker` pass-through in `docs-plugin.ts`

**Phase 2 (breaking):** In the next major version, remove `Reranker` interface and `reranker` field from `types.ts`. Document in CHANGELOG as a breaking change.

**Effort:** Low (~30 min for Phase 1).

---

## 3. `any` in Production Code

**Impact:** Medium — violates code of conduct, disables type checking at boundaries  
**Location:** Multiple files

### Instances

| File | Line | Usage | Fix |
|------|------|-------|-----|
| `packages/code/src/indexing/walker.ts` | L25 | `db: any` in `CodeWalkerDeps` | Define `DbLike` interface (already exists in `traversal.ts`) |
| `packages/docs/src/docs-indexer.ts` | L72 | `private _db: any` | Same `DbLike` interface |
| `packages/docs/src/docs-plugin.ts` | L185, L240 | `as any[]` casts on query results | Type the query result rows |
| `packages/code/src/parsing/symbols.ts` | L58, L72 | `rootNode: any` for tree-sitter | Define `TreeSitterNode` interface |

### Proposed Solution

1. Extract a shared `DbLike` interface (already defined in `traversal.ts` and `provider.ts`) to a common location
2. Create a `TreeSitterNode` interface with the minimal shape used (`.type`, `.text`, `.namedChildCount`, `.namedChild()`, `.childForFieldName()`, `.startPosition`)
3. Replace all `any` casts with typed alternatives

**Effort:** Low (~1 hour). Mechanical changes, no logic changes.

---

## 4. `_linkCallEdges` Rebuilds Entire Table on Every Index

**Impact:** Medium — O(n²) for large repos, slows incremental reindexing  
**Location:** `packages/code/src/indexing/walker.ts`, `_linkCallEdges()` method

### Problem

Every time `index()` is called (even for a single changed file), `_linkCallEdges()` runs:

```sql
DELETE FROM code_call_edges;
INSERT ... FROM code_refs JOIN code_symbols ...;  -- full cross-join
```

This rebuilds **all** call edges from scratch, even if only one file changed. For repos with 10K+ chunks, this becomes the bottleneck of incremental reindex.

### Proposed Solution

**Incremental edge linking:** Only rebuild edges for chunks that were just indexed.

```typescript
private _linkCallEdges(changedChunkIds: number[]): void {
    // 1. Delete edges originating FROM changed chunks
    const ph = changedChunkIds.map(() => '?').join(',');
    this._deps.db.prepare(
        `DELETE FROM code_call_edges WHERE caller_chunk_id IN (${ph})`
    ).run(...changedChunkIds);

    // 2. Rebuild edges only for changed callers
    this._deps.db.prepare(`
        INSERT OR IGNORE INTO code_call_edges (caller_chunk_id, callee_chunk_id, symbol_name)
        SELECT cr.chunk_id, cs.chunk_id, cr.symbol_name
        FROM code_refs cr
        JOIN code_symbols cs ON cs.name = cr.symbol_name
        WHERE cr.chunk_id IN (${ph})
          AND cs.chunk_id IS NOT NULL
          AND cr.chunk_id != cs.chunk_id
    `).run(...changedChunkIds);

    // Pass 2: Method suffix match (same pattern, scoped to changed chunks)
    // ...
}
```

**Effort:** Medium (~1-2 hours). Requires passing `newChunkIds` from the indexing loop into `_linkCallEdges`.

---

## 5. FNV-1a 32-bit Hash for File Change Detection

**Impact:** Low — theoretical collision risk  
**Location:** `packages/code/src/indexing/walker.ts`, `_hash()` method

### Problem

The `_hash()` method uses FNV-1a (32-bit) to detect file changes:

```typescript
private _hash(content: string): string {
    let h = 2166136261;
    for (let i = 0; i < content.length; i++) {
        h ^= content.charCodeAt(i);
        h = (h * 16777619) >>> 0;
    }
    return h.toString(16);
}
```

With only 2³² possible values, the birthday problem gives ~50% collision probability at ~77K files. A collision means a changed file would be silently skipped during incremental reindex.

The docs plugin uses SHA-256 (16-char hex = 64 bits) via `crypto.createHash`, which is safer.

### Proposed Solution

Replace with a 64-bit hash or use the same SHA-256 approach as docs:

```typescript
import { createHash } from 'node:crypto';

private _hash(content: string): string {
    return createHash('sha256').update(content).digest('hex').slice(0, 16);
}
```

**Trade-off:** SHA-256 is ~3x slower than FNV-1a but still negligible compared to embedding API calls. The consistency with the docs plugin's approach is a bonus.

**Effort:** Trivial (~10 min). Requires a `--force-reindex` after deploying since all hashes change.

---

## 6. Global Regex Pattern Reuse in Import Extractor

**Impact:** Low — fragile but currently working  
**Location:** `packages/code/src/graph/import-extractor.ts`

### Problem

`extractImportPaths()` uses regex patterns from `PATH_PATTERNS` with the `g` flag. These patterns are module-level constants, meaning their `lastIndex` persists between calls. The code manually resets `lastIndex = 0` before each use:

```typescript
for (const { re, kind } of patterns) {
    re.lastIndex = 0;  // Manual reset
    let match: RegExpExecArray | null;
    while ((match = re.exec(content)) !== null) { ... }
}
```

This works but is brittle — if anyone forgets the reset (e.g. adding a new extraction function that reuses the patterns), results will silently be incomplete.

### Proposed Solution

Create pattern instances per call instead of reusing:

```typescript
// Instead of module-level compiled patterns, store pattern sources
const PATH_PATTERN_DEFS: Record<string, Array<{ source: string; flags: string; kind: ImportKind }>> = { ... };

// In extractImportPaths, create fresh instances:
for (const { source, flags, kind } of defs) {
    const re = new RegExp(source, flags);
    // ...
}
```

Or use `String.matchAll()` which creates fresh iterator state:

```typescript
for (const match of content.matchAll(pattern)) { ... }
```

**Effort:** Trivial (~15 min).


---

## See Also

- [Architecture](architecture.md) — system design and layer contracts
- [Configuration](config.md) — plugin and embedding setup
- [Search](search.md) — search pipeline documentation

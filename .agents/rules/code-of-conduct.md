---
trigger: always_on
---

# BrainBank — Architecture Rules & Code of Conduct

## 1. Class vs Function — The Golden Rule

```
Has state between calls → CLASS
No state between calls  → FREE FUNCTION
```

**Class** = has instance fields that persist (db, hnsw, maps, timers)  
**Function** = receives everything it needs via parameters, returns result, done

### ❌ Anti-patterns
```typescript
// BAD — class instantiated, used once, discarded (Initializer was this)
const x = new Foo(config);
const result = await x.doWork();
// x never used again

// BAD — class with one method wrapping 3 lines (FTSMaintenance was this)
class FTSMaintenance {
    rebuild() { /* 3 SQL lines */ }
}

// BAD — class that only passes deps through (ResultCollector was this)
class ResultCollector {
    constructor(private _d: Deps) {}
    collect() { return this._d.registry.get(...) }
}
```

### ✅ Correct
```typescript
// GOOD — stateful service
class KVService {
    private _collections = new Map() // ← real state
    collection(name: string) { ... }
}

// GOOD — stateless orchestration
export async function reembedAll(db, embedding, hnswMap, opts) { ... }
```

---

## 2. Folder Contracts

Each folder has ONE pattern. No mixing.

### `lib/` — Pure functions only
- Zero state, zero side effects
- No imports from other src/ folders (except `types.ts`)
- Input → Output, deterministic
- Examples: `rrf.ts`, `math.ts`, `fts.ts`, `languages.ts`

### `db/` — Database layer
- One class with state: `Database`
- Everything else: free functions (`schema.ts`, `embedding-meta.ts`)
- Row type definitions only in `rows.ts`
- **MUST NOT** import from `providers/` or `services/` or `engine/`

### `providers/` — External integrations
- Classes for stateful providers (embedding models, vector index)
- Free functions for utilities (`resolve.ts`, `hnsw-loader.ts`)
- May import from `lib/` and `db/` only

### `services/` — Stateful services only
- **ALL files must be classes with real instance state**
- `Collection`, `KVService`, `Watcher` — all have fields that persist
- If it has no state → it does not belong here → move to `engine/`

### `engine/` — Orchestration layer
- Classes that hold injected deps: `SearchAPI`, `IndexAPI`
- Free functions for stateless orchestration: `reembed.ts`
- No business logic — delegates to `search/`, `providers/`, `services/`

### `bootstrap/` — Startup sequence
- Free functions for init steps: `earlyInit()`, `lateInit()`
- One class with real state: `PluginRegistry`
- One builder function: `buildSearchLayer()`
- **No classes that are instantiated and immediately discarded**

### `search/` — Search strategies
- Classes that implement `SearchStrategy` interface
- Pure functions for formatting in `search/context/`
- `ContextBuilder` class owns ALL context assembly

### `cli/` — Command line interface
- `commands/` — one free function per command
- `factory/` — free functions for brain construction
- `utils.ts` — pure helper functions

---

## 3. Import Direction — Strict Layering

```
brainbank.ts
    ↓
bootstrap/  engine/  services/  cli/
    ↓
search/  providers/  db/
    ↓
lib/  types.ts  constants.ts  plugin.ts
```

### Rules
- **Lower layers NEVER import from higher layers**
- `db/` cannot import from `providers/`, `services/`, `engine/`
- `lib/` cannot import from anywhere in `src/` except `types.ts`
- `plugin.ts` cannot import concrete classes from `services/`

### Import path rules
```typescript
// SAME directory → relative path ALWAYS
import { foo } from './foo'          // ✅
import { foo } from '@/services/foo' // ❌ same dir = use ./

// Going UP or ACROSS → @/ alias OK
import { Database } from '@/db/database'  // ✅ from search/ going up
```

---

## 4. Indirection Rules — Zero Tolerance

A layer/class/method is an indirection if it:
1. Has no logic of its own
2. Only passes arguments through to something else
3. Could be removed with a direct call

### Patterns to eliminate
```typescript
// BAD — wrapper method calling same-signature function
private _buildSearchLayer(...args) {
    return buildSearchLayer(...args) // ← DELETE the wrapper
}

// BAD — callback that just does a registry lookup
getDocsPlugin: () => registry.get(PLUGIN.DOCS) // ← registry already available

// BAD — pass-through class
class ResultCollector {
    constructor(private _d: SearchAPIDeps) {} // same deps as parent
    collectDocs() { return this._d.docsPlugin.search(...) } // no added value
}
```

---

## 5. Interface vs Concrete Type in Contracts

Core interfaces (`plugin.ts`, `types.ts`) must NEVER depend on concrete implementations.

```typescript
// BAD — plugin.ts imports concrete class
import { Collection } from './services/collection' // ❌

// GOOD — plugin.ts depends on interface
import type { ICollection } from './types'          // ✅

// services/collection.ts implements the interface
class Collection implements ICollection { ... }     // ✅
```

---

## 6. Single Responsibility per File

Each file owns ONE concern:

| File | Owns | Does NOT own |
|---|---|---|
| `ContextBuilder` | context assembly | search execution |
| `SearchAPI` | search orchestration | context formatting |
| `Collection` | item storage + retrieval | reranking logic strategy |
| `IndexAPI` | indexing orchestration | plugin lifecycle |
| `KVService` | collection registry | search logic |

---

## 7. Naming Conventions

```
SomethingService  → class, stateful, lives in services/
SomethingAPI      → class, orchestrator with deps, lives in engine/
SomethingSearch   → class, implements SearchStrategy, lives in search/vector/ or search/keyword/
SomethingProvider → class, external integration, lives in providers/
SomethingIndex    → class, vector index, lives in providers/vector/
SomethingBuilder  → class, assembles output, lives in search/
SomethingRegistry → class, manages a collection of things, lives in bootstrap/

buildSomething()  → free function, creates and returns, no side effects
loadSomething()   → free function, reads from storage
saveSomething()   → free function, writes to storage
resolveSomething()→ free function, resolves/looks up a value
formatSomething() → pure function, string transformation
```

---

## 8. Verification Checklist (run after every change)

```bash
npx tsc --noEmit                              # zero type errors
npm test                                       # all unit tests pass
node scripts/lint-imports.mjs                 # zero same-dir @/ violations
grep -r "new.*Initializer\|new.*FTSMaintenance\|new.*ResultCollector" src/  # must be empty
```

---

## 9. Decision Log

| Decision | Rationale |
|---|---|
| `reembed.ts` stays as free functions | No state between calls — class would be Initializer anti-pattern |
| `Collection` imports `rrf.ts` + `rerank.ts` | `lib/` is Layer 0 — direction is correct. Collection is storage+retrieval by design |
| `VectorSearch` deleted | 100% replaced by `CompositeVectorSearch` — dead code |
| `getContext` lives only in `ContextBuilder` | SearchAPI is search-only; context assembly is ContextBuilder's contract |
| `Watcher` is a class | Has real instance state: timers, pending set, watchers array |
| `ICollection` interface in `types.ts` | Core contracts cannot depend on service implementations |

---

## 10. The One-Line Test

Before adding any file, ask:

> *"Does this file have state that needs to persist between calls?"*

- **Yes** → Class in the appropriate stateful folder (`services/`, `engine/`, `providers/`)
- **No** → Free function(s) in the appropriate stateless folder (`lib/`, `engine/`, `bootstrap/`)
- **No AND it just passes things through** → Delete it, inline the logic
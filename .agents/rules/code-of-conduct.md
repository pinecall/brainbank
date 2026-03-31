---
trigger: always_on
---

# BrainBank — Code of Conduct

## 1. Class vs Free Function

**Has persistent instance state → CLASS. No state → FREE FUNCTION. No state + just passes things through → DELETE IT.**

```typescript
// ✅ Class — real state persists
class KVService { private _collections = new Map() }

// ✅ Free function — receives everything, returns result, done
export async function reembedAll(db, embedding, hnswMap, opts): Promise<ReembedResult> {}

// ❌ Class instantiated once and discarded
const x = new Foo(config); const result = await x.run(); // x never used again
```

---

## 2. Folder Contracts

| Folder | Pattern | Imports from |
|---|---|---|
| `lib/` | Pure functions only, zero state | `types.ts` only |
| `db/` | `Database` class + free functions | `lib/`, `types.ts` |
| `providers/` | Stateful provider classes + util functions | `lib/`, `db/` |
| `services/` | **Classes with real instance state only** | `lib/`, `db/`, `providers/` |
| `engine/` | Orchestrator classes + stateless free functions | all lower layers |
| `bootstrap/` | Init free functions, no disposable classes | all lower layers |
| `search/` | `SearchStrategy` classes + pure formatters | `lib/`, `db/`, `providers/` |
| `cli/` | One free function per command | all layers |

**If a file in `services/` has no private instance fields, it doesn't belong there.**

---

## 3. Import Direction

```
brainbank.ts
    ↓
bootstrap/  engine/  services/  cli/
    ↓
search/  providers/  db/
    ↓
lib/  types.ts  constants.ts  plugin.ts
```

Lower layers never import from higher layers.

```typescript
// Same directory → relative path always
import { foo } from './foo'           // ✅
import { foo } from '@/services/foo'  // ❌ (when already in services/)

// Different directory → @/ alias always
import { Database } from '@/db/database'  // ✅
```

---

## 4. Zero `any` in Production Code

```typescript
// ❌ Never
private _index: any = null
export function printResults(results: any[]): void {}

// ✅ Create a minimal interface instead
interface HnswLibIndex {
    addPoint(vector: number[], id: number): void
    searchKnn(query: number[], k: number): { neighbors: number[]; distances: number[] }
}

// ✅ Use the existing type
export function printResults(results: SearchResult[]): void {}
```

---

## 5. Error Handling — No Silent Swallows

```typescript
// ❌ Silent swallow — the problem disappears without a trace
} catch { return false }

// ✅ Expected errors: document why swallow is correct + re-throw everything else
} catch (e) {
    if (!isFTSError(e)) throw e  // re-throw unexpected
    // FTS5 parse error — invalid query, empty result is correct
}

// ✅ Infrastructure level: propagate to caller
} catch (err) {
    return { ok: false, error: err instanceof Error ? err : new Error(String(err)) }
}

// ✅ CLI level: always log for the user
} catch (err) {
    console.error(c.red(`Error: ${err instanceof Error ? err.message : String(err)}`))
    process.exit(1)
}
```

---

## 6. Public Contracts — Interfaces, Not Concrete Classes

```typescript
// ❌ plugin.ts importing concrete class
import { Collection } from './services/collection'

// ✅ plugin.ts depends on interface
import type { ICollection } from './types'

// ✅ KVService returns interface, not implementation
collection(name: string): ICollection  // not Collection
```

---

## 7. Naming

**Files:** `kebab-case` for free functions, reflects content (`hnsw-loader.ts`, `result-formatters.ts`).

**Classes:**
```
SomethingService  → stateful, lives in services/
SomethingAPI      → orchestrator with injected deps, lives in engine/
SomethingSearch   → implements SearchStrategy, lives in search/
SomethingProvider → external integration, lives in providers/
SomethingIndex    → vector index, lives in providers/vector/
SomethingBuilder  → assembles output
SomethingRegistry → manages a collection of things
```

**Functions:**
```
buildSomething()   → creates and returns, no side effects
loadSomething()    → reads from storage
saveSomething()    → writes to storage
createSomething()  → factory, may have side effects
formatSomething()  → pure string transformation
resolveSomething() → looks up / resolves a value
```

**Private fields:** always `_` prefix (`_db`, `_collections`, `_initialized`).

---

## 8. Parameters — Max 4, then Object

```typescript
// ❌ 7 parameters
function buildPluginContext(config, db, embedding, sharedHnsw, skipVectorLoad, kvService, privateHnsw)

// ✅ Typed object
interface PluginContextDeps { config; db; embedding; sharedHnsw; skipVectorLoad; kvService; privateHnsw }
function buildPluginContext(deps: PluginContextDeps): PluginContext
```

---

## 9. Plugin Capabilities — Composition over Inheritance

```typescript
// ✅ Each capability is a separate interface with a type guard
interface IndexablePlugin extends Plugin {
    index(options?: IndexOptions): Promise<IndexResult>
}
export function isIndexable(p: Plugin): p is IndexablePlugin {
    return typeof (p as IndexablePlugin).index === 'function'
}

// ✅ Always narrow before calling
for (const mod of registry.all) {
    if (!isIndexable(mod)) continue
    await mod.index(options)
}
```

---

## 10. Pre-commit Checks

```bash
npx tsc --noEmit                        # zero type errors

# zero same-dir @/ imports
grep -rn "from '@/services/" src/services/
grep -rn "from '@/providers/" src/providers/

# zero any in production code
grep -rn ": any\|as any\|any\[\]" src/ --include="*.ts"

# zero empty catches — review each result manually
grep -rn "} catch {$" src/
```

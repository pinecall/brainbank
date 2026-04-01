---
trigger: always_on
---

# BrainBank — Code of Conduct

## 1. Zero `any` in Production Code

**Every `any` disables the type checker for everything it touches. No exceptions.**

```typescript
// ❌ Properties
private _lib: any = null;

// ✅ Local interface for external shapes
interface HnswlibModule {
    default?: { HierarchicalNSW: new (space: string, dims: number) => HnswlibIndex };
}
private _lib: HnswlibModule | null = null;
```

```typescript
// ❌ Dynamic imports — mod is any, everything destructured is any
const mod = await import('some-lib');

// ✅ Cast at the boundary, once
const mod = await import('some-lib') as SomeLibModule;
```

```typescript
// ❌ catch (err: any)
} catch (err: any) { if (err.name === 'AbortError') ... }

// ✅ catch (err: unknown) + instanceof narrowing
} catch (err: unknown) { if (err instanceof Error && err.name === 'AbortError') ... }
```

```typescript
// ❌ Record<string, any>
metadata?: Record<string, any>;

// ✅ Record<string, unknown> — forces narrowing at point of use
metadata?: Record<string, unknown>;
```

```typescript
// ❌ JSON.parse returns any — infects the expression
const files = JSON.parse(row.files_json);

// ✅ Cast to the type the schema guarantees
const files = JSON.parse(row.files_json) as string[];
const meta  = JSON.parse(row.meta_json) as Record<string, unknown>;
```

```typescript
// ❌ Function params
function printResults(results: any[]): void {}

// ✅ Use existing types
function printResults(results: SearchResult[]): void {}
```

**Rule of containment:** `as` casts belong at data boundaries (dynamic import, JSON.parse, fetch response). Never inside business logic.

---

## 2. Class vs Free Function

**Has persistent instance state → CLASS. No state → FREE FUNCTION. No state + just passes things through → DELETE IT.**

```typescript
// ✅ Class — real state persists
class KVService { private _collections = new Map() }

// ✅ Free function — receives everything, returns result, done
export async function reembedAll(db, embedding, hnswMap): Promise<ReembedResult> {}

// ❌ Class instantiated once and discarded — should be a free function
const x = new Orchestrator(config); await x.run(); // x never used again
```

---

## 3. Import Rules

**Layer direction — imports only flow downward:**

```
brainbank.ts
    ↓
engine/  services/  cli/
    ↓
search/  providers/  db/
    ↓
lib/  types.ts  constants.ts  plugin.ts
```

**Path rules:**
- Same directory → `./` always
- Different directory → `@/` always
- `../` → **NEVER**

**Import ordering — always this order:**

```typescript
// 1. Type-only imports (grouped: @/ first, then ./)
import type { Database } from '@/db/database.ts';
import type { SearchOptions } from './types.ts';

// 2. Node built-ins
import { EventEmitter } from 'node:events';

// 3. Value imports (grouped: @/ first, then ./)
import { PLUGIN } from '@/constants.ts';
import { SearchAPI } from './search-api.ts';
```

**Never mix `import type` with value imports in the same block.**

---

## 4. Folder Contracts

| Folder | Pattern | Imports from |
|---|---|---|
| `lib/` | Pure functions, zero state | `types.ts` only |
| `db/` | `Database` class + free functions | `lib/`, `types.ts` |
| `providers/` | Stateful provider classes + utils | `lib/`, `db/` |
| `services/` | **Classes with real instance state only** | `lib/`, `db/`, `providers/` |
| `engine/` | Orchestrators + stateless free functions | all lower layers |
| `search/` | `SearchStrategy` classes + pure formatters | `lib/`, `db/`, `providers/` |
| `cli/` | One free function per command | all layers |

**If a file in `services/` has no private instance fields, it doesn't belong there.**

---

## 5. Error Handling — No Silent Swallows

```typescript
// ❌ Silent swallow
} catch { return false }

// ✅ Expected errors: document why + re-throw unexpected
} catch (e) {
    if (!isFTSError(e)) throw e;
    // FTS5 parse error — invalid query, empty result is correct
}
```

---

## 6. Public Contracts — Interfaces, Not Concrete Classes

Lower layers (`plugin.ts`, `types.ts`) depend on interfaces. Concrete classes are upper-layer details.

```typescript
// ✅ KVService returns interface, not implementation
collection(name: string): ICollection  // not Collection
```

---

## 7. Naming

**Files:** `kebab-case` — `hnsw-loader.ts`, `keyword-search.ts`

**Classes:** `Service` (stateful), `API` (orchestrator), `Search` (strategy), `Provider` (external), `Builder`, `Registry`

**Functions:** `build` (pure), `load` (read), `save` (write), `create` (factory), `format` (string transform), `resolve` (lookup)

**Private fields:** always `_` prefix — `_db`, `_collections`, `_initialized`

---

## 8. Parameters — Max 4, Then Object

```typescript
// ❌ 7 parameters
function buildCtx(config, db, embedding, sharedHnsw, skip, kv, private)

// ✅ Typed object
interface CtxDeps { config; db; embedding; sharedHnsw; skip; kv; private }
function buildCtx(deps: CtxDeps): PluginContext
```

---

## 9. Plugin Capabilities — Composition over Inheritance

```typescript
// ✅ Separate interface + type guard per capability
interface IndexablePlugin extends Plugin {
    index(options?: IndexOptions): Promise<IndexResult>;
}
export function isIndexable(p: Plugin): p is IndexablePlugin {
    return typeof (p as IndexablePlugin).index === 'function';
}

// ✅ Always narrow before calling
for (const mod of registry.all) {
    if (!isIndexable(mod)) continue;
    await mod.index(options);
}
```

---

## 10. Pre-commit Checks

```bash
# 1. Zero type errors
npx tsc --noEmit

# 2. Zero any in production
grep -rn ": any\b\|as any\b\| any\[\]" src/ --include="*.ts"

# 3. Zero same-dir @/ imports
grep -rn "from '@/services/" src/services/
grep -rn "from '@/providers/" src/providers/

# 4. Zero empty catches — review manually
grep -rn "} catch {$" src/

# 5. Zero JSON.parse without cast
grep -rn "JSON\.parse(" src/ --include="*.ts" | grep -v " as "

# 6. Zero dynamic imports without module cast
grep -rn "await import(" src/ --include="*.ts" | grep -v ") as "
```

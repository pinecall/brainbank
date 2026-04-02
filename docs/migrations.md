# Plugin Migrations

How plugins create and evolve their database schema without touching the core.

> [!TIP]
> **Most plugins don't need migrations at all.** If your plugin stores and searches content, use `ctx.collection('name')` — it gives you hybrid search (vector + BM25), metadata, tags, and TTL out of the box, with zero SQL. See [Collections](collections.md).

## Do You Need Migrations?

| Approach | When to use | SQL required? |
|----------|------------|:---:|
| **`ctx.collection(name)`** | Store and search any structured data | **No** |
| **Custom tables + migrations** | Custom FTS5 indices, table relationships, domain-specific queries | Yes |

**Use collections** when your plugin stores items and retrieves them by similarity or keyword. This covers most use cases — notes, errors, decisions, logs, documents.

**Use migrations** when you need things collections can't provide:
- Custom table relationships (e.g. `code_imports` → `code_chunks` FK)
- Domain-specific FTS5 with weighted columns (e.g. `title` boosted 10×)
- Specialized indices for non-search queries (e.g. `co_edits` for file co-occurrence)
- Multiple related tables with CASCADE deletes

The built-in `@brainbank/code`, `@brainbank/git`, and `@brainbank/docs` all use custom tables because they have complex relational schemas. A simpler plugin — like a notes tracker or error log — would use collections.

---

## How It Works

BrainBank core owns only infrastructure tables (`kv_data`, `kv_vectors`, `embedding_meta`, `plugin_versions`, `index_state`). **Domain tables** — `code_chunks`, `git_commits`, `doc_chunks`, etc. — are created by their plugins via the **versioned migration system**.

```
┌──────────────────────┐          ┌────────────────────┐
│  plugin_versions     │          │  Plugin Schema      │
│  ┌─────────┬───────┐ │   check  │  ┌───────────────┐ │
│  │ plugin  │ ver   │ │◄─────────│  │ schemaVersion │ │
│  ├─────────┼───────┤ │          │  │ migrations[]  │ │
│  │ code    │   1   │ │  apply   │  └───────────────┘ │
│  │ git     │   1   │ │◄─────────│                    │
│  │ docs    │   1   │ │          │                    │
│  └─────────┴───────┘ │          └────────────────────┘
└──────────────────────┘
```

1. Plugin declares `schemaVersion` (e.g. `1`) and a `migrations` array
2. On `initialize()`, plugin calls `runPluginMigrations(db, name, version, migrations)`
3. Core reads the stored version from `plugin_versions`
4. Runs only migrations whose `version > stored version`, each in its own transaction
5. Updates `plugin_versions` after each successful migration

---

## Core API

```typescript
import type { Migration } from 'brainbank';
import { runPluginMigrations } from 'brainbank';

// A single migration step
interface Migration {
    version: number;
    up(adapter: DatabaseAdapter): void;  // must be idempotent (IF NOT EXISTS)
}

// Run inside your plugin's initialize()
runPluginMigrations(ctx.db, 'my-plugin', SCHEMA_VERSION, MIGRATIONS);
```

---

## Plugin Interface

Plugins that own database tables implement `MigratablePlugin`:

```typescript
import type { Plugin, MigratablePlugin, Migration } from 'brainbank';

interface MigratablePlugin extends Plugin {
    readonly schemaVersion: number;    // current version (e.g. 3)
    readonly migrations: Migration[];  // ordered list [v1, v2, v3, ...]
}
```

The `isMigratable(plugin)` type guard checks for this capability at runtime.

---

## Built-in Plugin Schemas

### @brainbank/code (v1)

| Table | Purpose |
|-------|---------|
| `code_chunks` | AST-extracted code blocks (function, class, method) |
| `code_vectors` | Embedding vectors for each chunk |
| `indexed_files` | File hash tracking for incremental indexing |
| `code_imports` | File-level import/require dependencies |
| `code_symbols` | Function/class/method definitions with line numbers |
| `code_refs` | Function call references within each chunk |
| `fts_code` | FTS5 full-text index on file_path, name, content |

### @brainbank/git (v1)

| Table | Purpose |
|-------|---------|
| `git_commits` | Commit metadata (hash, message, author, diff, stats) |
| `commit_files` | Files changed per commit |
| `co_edits` | File co-occurrence counts for co-edit suggestions |
| `git_vectors` | Embedding vectors for each commit |
| `fts_commits` | FTS5 full-text index on message, author, diff |

### @brainbank/docs (v1)

| Table | Purpose |
|-------|---------|
| `collections` | Registered document collections (name, path, pattern) |
| `doc_chunks` | Smart-chunked document sections |
| `doc_vectors` | Embedding vectors for each chunk |
| `path_contexts` | Per-path context strings for enriched search |
| `fts_docs` | FTS5 full-text index on title, content, file_path |

---

## Writing Migrations

### Creating a Schema (Version 1)

```typescript
// my-plugin-schema.ts
import type { PluginContext } from 'brainbank';

type DbAdapter = PluginContext['db'];

export const MY_SCHEMA_VERSION = 1;

export const MY_MIGRATIONS = [
    {
        version: 1,
        up(adapter: DbAdapter): void {
            adapter.exec(`
                CREATE TABLE IF NOT EXISTS my_items (
                    id       INTEGER PRIMARY KEY AUTOINCREMENT,
                    content  TEXT    NOT NULL,
                    meta     TEXT    NOT NULL DEFAULT '{}'
                );

                CREATE TABLE IF NOT EXISTS my_vectors (
                    item_id   INTEGER PRIMARY KEY REFERENCES my_items(id) ON DELETE CASCADE,
                    embedding BLOB    NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_my_items ON my_items(content);

                -- FTS5 for keyword search
                CREATE VIRTUAL TABLE IF NOT EXISTS fts_my USING fts5(
                    content,
                    content='my_items',
                    content_rowid='id',
                    tokenize='porter unicode61'
                );

                -- Auto-sync triggers
                CREATE TRIGGER IF NOT EXISTS trg_fts_my_insert AFTER INSERT ON my_items BEGIN
                    INSERT INTO fts_my(rowid, content) VALUES (new.id, new.content);
                END;
                CREATE TRIGGER IF NOT EXISTS trg_fts_my_delete AFTER DELETE ON my_items BEGIN
                    INSERT INTO fts_my(fts_my, rowid, content)
                    VALUES ('delete', old.id, old.content);
                END;
            `);
        },
    },
];
```

### Evolving the Schema (Version 2+)

Add a new migration — **never modify existing ones**:

```typescript
export const MY_SCHEMA_VERSION = 2;  // bump

export const MY_MIGRATIONS = [
    {
        version: 1,
        up(adapter: DbAdapter): void {
            adapter.exec(`CREATE TABLE IF NOT EXISTS my_items (...)`);
        },
    },
    {
        version: 2,
        up(adapter: DbAdapter): void {
            adapter.exec(`
                ALTER TABLE my_items ADD COLUMN priority INTEGER DEFAULT 0;
                CREATE INDEX IF NOT EXISTS idx_my_priority ON my_items(priority DESC);
            `);
        },
    },
];
```

### Calling from initialize()

```typescript
import { runPluginMigrations } from 'brainbank';
import { MY_SCHEMA_VERSION, MY_MIGRATIONS } from './my-plugin-schema.js';

class MyPlugin implements MigratablePlugin {
    readonly name = 'my-plugin';
    readonly schemaVersion = MY_SCHEMA_VERSION;
    readonly migrations = MY_MIGRATIONS;

    async initialize(ctx: PluginContext): Promise<void> {
        // Always first — creates/updates tables before any queries
        runPluginMigrations(ctx.db, this.name, this.schemaVersion, this.migrations);

        // ... rest of initialization (load HNSW, etc.)
    }
}
```

---

## Best Practices

| Rule | Why |
|------|-----|
| **Always use `IF NOT EXISTS`** | Migrations must be idempotent — safe on first run and on re-run |
| **Never modify old migrations** | Add new ones with a higher `version` — old DBs skip applied versions |
| **Use `CASCADE` on foreign keys** | Prevents orphaned vectors when content rows are deleted |
| **FTS5 triggers for auto-sync** | Keeps the full-text index in sync without manual rebuilds |
| **One migration per logical change** | Makes rollback reasoning easier |
| **Bump `schemaVersion` when adding** | The runner skips entirely if `current >= schemaVersion` |

---

## How the Runner Works

```typescript
function runPluginMigrations(adapter, pluginName, schemaVersion, migrations) {
    const current = getPluginVersion(adapter, pluginName);  // from plugin_versions
    if (current >= schemaVersion) return;                    // already up-to-date

    const sorted = [...migrations].sort((a, b) => a.version - b.version);

    for (const m of sorted) {
        if (m.version <= current) continue;                  // already applied

        adapter.transaction(() => {
            m.up(adapter);                                   // run DDL
            setPluginVersion(adapter, pluginName, m.version); // stamp version
        });
    }
}
```

Each migration runs in its **own transaction**. If a migration fails, the database rolls back to the previous version — partial migrations never persist.

---

## Inspecting Plugin Versions

```sql
-- In .brainbank/brainbank.db
SELECT * FROM plugin_versions;

-- plugin_name │ version │ applied_at
-- ────────────┼─────────┼───────────
-- code        │       1 │ 1711929600
-- git         │       1 │ 1711929600
-- docs        │       1 │ 1711929600
```

---

## See Also

- [Custom Plugins](custom-plugins.md) — full plugin development guide
- [Plugins](plugins.md) — built-in plugin overview
- [Architecture](architecture.md) — system internals

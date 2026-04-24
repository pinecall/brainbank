# MCP Server

BrainBank ships with an MCP server (stdio) for AI tool integration — Google Antigravity, Claude Desktop, Cursor, and any MCP-compatible client.

## Setup

### Automated (recommended)

The fastest way to configure your AI IDE:

```bash
brainbank mcp:export antigravity   # Google Antigravity
brainbank mcp:export cursor        # Cursor
brainbank mcp:export claude        # Claude Desktop
```

`mcp:export` does two things:
1. **MCP config** — resolves node binary, `cli.js` path, and API keys from `.brainbank/config.json` or env vars
2. **`~/.gemini/GEMINI.md`** (Antigravity only) — appends a concise BrainBank section with agent rules

Use `--force` to skip all confirmation prompts (useful for scripted setup).

### Manual

Add to your IDE's MCP config:

```json
{
  "mcpServers": {
    "brainbank": {
      "command": "npx",
      "args": ["-y", "brainbank-mcp"]
    }
  }
}
```

> **Config locations:** Antigravity → `~/.gemini/antigravity/mcp_config.json`, Claude → `~/Library/Application Support/Claude/claude_desktop_config.json`, Cursor → `.cursor/mcp.json`

### CLI (standalone)

```bash
brainbank mcp
# or alias:
brainbank serve
```

---

## Zero-Config

The MCP server auto-detects everything:

- **Repo path** — from `repo` tool param (required) > `BRAINBANK_REPO` env > `findRepoRoot(cwd)` (walks up looking for `.git/`)
- **Embedding provider** — from `.brainbank/config.json` > `BRAINBANK_EMBEDDING` env > `provider_key` stored in DB > falls back to local
- **Plugins** — reads `plugins` array from `config.json` (default: `['code', 'git', 'docs']`). Loaded dynamically by the core factory — no hardcoded imports
- **Include/Ignore patterns** — reads `code.include` and `code.ignore` from `config.json`

> **Indexing is CLI-only.** The MCP server is a read-only interface — it cannot trigger re-indexing. Index your repo with the CLI first:
> ```bash
> brainbank index . --yes
> ```
> The selection is saved to `.brainbank/config.json`. After that, the MCP server auto-resolves the correct provider — no env vars needed.

---

## Tool

### `brainbank_context`

**Primary tool.** Returns a Workflow Trace: search hits + full call tree with `called by` annotations, topologically ordered. All source code included — no trimming, no truncation.

```typescript
brainbank_context({
  task: string,              // what you're trying to understand or implement
  repo: string,              // repository path (REQUIRED — project root where brainbank index was run)
  affectedFiles?: string[],  // files you plan to modify (improves co-edit suggestions)
  codeResults?: number,      // max code results (default: 20)
  gitResults?: number,       // max git commit results (default: 5)
  docsResults?: number,      // max document results (omit to skip docs)
  sources?: Record<string, number>, // per-source overrides (e.g. { code: 10, git: 0, docs: 5 })
  path?: string,             // scope results to files under this path prefix (within repo)
  ignore?: string[],         // exclude results whose filePath starts with any prefix
  // BrainBankQL context fields:
  lines?: boolean,           // prefix each code line with source line number
  symbols?: boolean,         // append symbol index for matched files
  compact?: boolean,         // show only function/class signatures, skip bodies
  callTree?: boolean | { depth: number }, // call tree expansion (default: true)
  imports?: boolean,         // dependency/import summary (default: true)
  expander?: boolean,        // LLM-powered context expansion via HaikuExpander
})
```

Returns a **Workflow Trace** — a single flat `## Code Context` section with:
- Search hits with `% match` scores
- Full call tree (configurable depth) with `called by` annotations
- Part adjacency boost — multi-part functions shown complete (no gaps)
- Trivial wrapper collapse — delegation functions shown as one-liners
- Test file and infra file filtering from call tree
- All source code included — **no trimming, no truncation**

If the project is **not indexed**, the tool returns an error with the exact CLI command to run, plus a template `config.json`.

---

## Multi-Workspace

The MCP server manages a **`WorkspacePool`** of BrainBank instances — one per unique `repo` path. The pool uses:

- **Memory-pressure eviction** — oldest idle workspace evicted when total exceeds `BRAINBANK_MAX_MEMORY_MB` (default 2048 MB). Memory is estimated via `brain.memoryHint()` (HNSW vector count × dims × 4 bytes).
- **TTL eviction** — workspaces idle longer than `BRAINBANK_TTL_MINUTES` (default 30 min) are evicted every 60 seconds.
- **Active-op tracking** — `entry.activeOps` increments during in-flight queries; eviction skips entries with `activeOps > 0`.

```typescript
brainbank_context({ task: "login flow", repo: "/project-a" })
brainbank_context({ task: "API routes", repo: "/project-b" })
```

Instances are cached in memory after first initialization (~480ms). On each pool hit, `brain.ensureFresh()` is called — if another process (e.g. CLI `brainbank index`) has updated the HNSW indices, stale in-memory copies are hot-reloaded automatically.

---

## Environment Variables

All optional — the server works without any env vars.

| Variable | Description | Default |
|----------|-------------|--------|
| `BRAINBANK_REPO` | Fallback repo path | auto-detect from cwd |
| `BRAINBANK_EMBEDDING` | Embedding provider key: `local`, `openai`, `perplexity`, `perplexity-context` | from `config.json` or DB |
| `BRAINBANK_MAX_MEMORY_MB` | Maximum total pool memory in MB | `2048` |
| `BRAINBANK_TTL_MINUTES` | Idle workspace eviction timeout in minutes | `30` |
| `OPENAI_API_KEY` | Required when embedding provider is `openai` | — |
| `PERPLEXITY_API_KEY` | Required when embedding provider is `perplexity` / `perplexity-context` | — |
| `ANTHROPIC_API_KEY` | Required when using `expander: true` (HaikuExpander) | — |

---

## AI Agent Integration

Recommended agent rules for using BrainBank tools effectively:

```
Workflow:
1. brainbank_context({ task: "<what you're working on>" })
   → Get semantic search results + call tree + git history

Tips:
- Pass affectedFiles to get co-edit suggestions
- Use path to scope results to a subsystem
- Use ignore to exclude paths (e.g. ["src/tests/", "vendor/"])
- Use callTree: { depth: 2 } for deeper call exploration
- Use expander: true for LLM-powered chunk discovery
```

| Agent | Configuration location |
|-------|----------------------|
| **Antigravity** | `AGENTS.md` in project root |
| **Claude Code** | `AGENTS.md` in project root |
| **Cursor** | `.cursor/rules` |
| **Any MCP client** | JSON config as shown above |

---

## How It Works

```
AI Agent  ←→  stdio  ←→  brainbank-mcp  ←→  BrainBank core  ←→  SQLite + HNSW
```

1. Agent sends `brainbank_context({ task: "..." })`
2. `WorkspacePool.get(repoPath)` → gets/creates a BrainBank instance
3. `brain.ensureFresh()` → compares `_loadedVersions` vs `index_state` table (~5μs); hot-reloads stale HNSW if needed
4. `brain.getContext(task, options)` → `ContextBuilder.build()`:
   - `CompositeVectorSearch`: embed query once, query all domain HNSW indices
   - Optional path scoping → optional `HaikuPruner` → optional `HaikuExpander`
   - `ContextFormatterPlugin` per plugin: `CodePlugin` → Workflow Trace, `GitPlugin` → commit history + co-edits
5. Markdown Workflow Trace returned to agent

### Architecture

```
src/mcp/
├── mcp-server.ts          ← MCP stdio server (1 tool: context)
├── workspace-pool.ts      ← Memory-pressure + TTL eviction, active-op tracking
└── workspace-factory.ts   ← Delegates to core createBrain() — no plugin hardcoding
```

> The MCP server is built into the core package (no separate `@brainbank/mcp` package). The `brainbank-mcp` binary is registered in the root `package.json` `bin` field.

`WorkspaceFactory.createWorkspaceBrain()` imports `createBrain()` from core, passes a `BrainContext` with `repoPath` and `env`. Console output is redirected to stderr during initialization to prevent ANSI escape codes from corrupting the MCP JSON-RPC stdio transport.

---

## See Also

- [Configuration](config.md) — embedding config, plugin config
- [Search](search.md) — BrainBankQL context fields
- [Architecture](architecture.md) — MCP server internals

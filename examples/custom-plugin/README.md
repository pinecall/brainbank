# Custom Plugin Examples

Two different BrainBank plugins showing the two ways to extend BrainBank. Both are local-only — no external APIs, testable immediately with the included sample data.

## The Two Plugins

| | **Notes Plugin** (programmatic) | **Quotes Plugin** (CLI) |
|---|---|---|
| **File** | `notes-plugin.ts` | `.brainbank/plugins/quotes.ts` |
| **How to use** | Import and register with `brain.use()` | Auto-discovered by CLI |
| **Data model** | One item per `.txt` file in a directory | One item per line in `quotes.txt` |
| **What it indexes** | Technical notes (multi-line content) | Programming quotes with author |
| **Capabilities** | `index` + `search` + `@expose` + `watch` | `index` + `search` + `@expose` + `watch` |

## File Structure

```
custom-plugin/
├── notes-plugin.ts              # Programmatic plugin (library-style)
├── usage.ts                     # Script to test the notes plugin
├── sample-data/
│   ├── notes/
│   │   ├── architecture.txt     # Sample notes about BrainBank internals
│   │   └── plugins.txt          # Sample notes about the plugin system
│   └── quotes.txt               # 12 programming quotes (one per line)
├── .brainbank/
│   ├── config.json              # Project config
│   └── plugins/
│       └── quotes.ts            # CLI plugin (auto-discovered)
└── README.md
```

---

## 1. Programmatic: Notes Plugin

The notes plugin reads `.txt` files from a directory and indexes each file as one searchable item.

### Try It

```bash
cd examples/custom-plugin
npx tsx usage.ts
```

This runs the `usage.ts` script which:
1. Creates a `BrainBank` instance with `.use(notes({ dir: './sample-data/notes' }))`
2. Calls `brain.index()` — reads `architecture.txt` and `plugins.txt`
3. Calls `brain.search('how does search work')` — returns relevant note chunks
4. Uses `brain.searchNotes()` (via `@expose`) for direct notes search
5. Uses `brain.listNotes()` to show all indexed files

### Plugin Code Highlights

```typescript
import { notes } from './notes-plugin';

const brain = new BrainBank({ repoPath: '.' })
    .use(notes({ dir: './sample-data/notes' }));

await brain.initialize();
await brain.index();

// Hybrid search — notes results fused via RRF
const results = await brain.search('vector search');

// @expose methods
const noteHits = await brain.searchNotes('plugin system');
const allNotes = brain.listNotes();
```

---

## 2. CLI: Quotes Plugin

The quotes plugin reads a `quotes.txt` file and indexes each line as a separate quote with author metadata.

### Try It

```bash
cd examples/custom-plugin

# Copy sample data to working directory
cp sample-data/quotes.txt .

# Index — CLI auto-discovers .brainbank/plugins/quotes.ts
brainbank index

# Search quotes
brainbank search "simplicity"
brainbank search "code quality"

# Direct collection search
brainbank kv search quotes "future"

# Stats
brainbank stats
```

### How It Works

The file `.brainbank/plugins/quotes.ts` is auto-discovered by the CLI:

```typescript
// .brainbank/plugins/quotes.ts
export default new QuotesPlugin('./quotes.txt');
```

- Reads `quotes.txt`, splits by newline
- Parses `"Quote text — Author"` format
- Indexes each quote with tags: `['quote', 'author-name']`
- Search returns formatted: `"Quote" — Author`

### Config

`.brainbank/config.json` can set per-plugin options:

```jsonc
{
  "plugins": ["code", "git", "docs"],
  "quotes": { "embedding": "local" }
}
```

---

## Key Differences

| Aspect | Programmatic (`notes-plugin.ts`) | CLI (`.brainbank/plugins/quotes.ts`) |
|--------|----------------------------------|--------------------------------------|
| Export | `export function notes(opts)` (factory) | `export default new QuotesPlugin()` (instance) |
| Config | Passed at construction: `notes({ dir })` | From `config.json` or hardcoded |
| Registration | `brain.use(notes({ dir: '...' }))` | Auto-discovered by CLI |
| Data shape | One item per file (whole content) | One item per line (split content) |
| Dedup strategy | By filename metadata | Clear and re-index all |

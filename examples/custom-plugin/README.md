# CLI Plugin Example (Quotes)

A BrainBank plugin that's **auto-discovered** by the CLI from `.brainbank/plugins/`. Reads a `quotes.txt` file and indexes each line as a searchable quote with author metadata.

> **Looking for the programmatic API example?** See [../notes-plugin/](../notes-plugin/).

## File Structure

```
custom-plugin/
├── .brainbank/
│   ├── config.json              # Project config
│   └── plugins/
│       └── quotes.ts            # CLI plugin (auto-discovered)
├── sample-data/
│   └── quotes.txt               # 12 programming quotes (one per line)
└── README.md
```

## Try It

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

## How It Works

The file `.brainbank/plugins/quotes.ts` is auto-discovered by the CLI:

```typescript
// .brainbank/plugins/quotes.ts
export default new QuotesPlugin('./quotes.txt');
```

- Reads `quotes.txt`, splits by newline
- Parses `"Quote text — Author"` format
- Indexes each quote with tags: `['quote', 'author-name']`
- Search returns formatted: `"Quote" — Author`

## Config

`.brainbank/config.json` can set per-plugin options:

```jsonc
{
  "plugins": ["code", "git", "docs"],
  "quotes": { "embedding": "local" }
}
```

## Programmatic vs CLI

| Aspect | Programmatic ([notes-plugin](../notes-plugin/)) | CLI (this example) |
|--------|--------------------------------------------------|---------------------|
| Export | `export function notes(opts)` (factory) | `export default new QuotesPlugin()` (instance) |
| Config | Passed at construction: `notes({ dir })` | From `config.json` or hardcoded |
| Registration | `brain.use(notes({ dir: '...' }))` | Auto-discovered by CLI |

# Custom Package Example

How to build a BrainBank plugin as a standalone **npm package** — the same structure used by `@brainbank/git`, `@brainbank/docs`, and `@brainbank/code`.

This example builds a CSV indexer that reads local `.csv` files and indexes each row for semantic search. No external APIs needed.

> **Note:** The `@brainbank` npm scope is reserved for official plugins. Use your own scope (e.g. `brainbank-csv`, `@myorg/brainbank-csv`).

## Package Structure

```
custom-package/
├── src/
│   ├── index.ts              # Public re-exports (.js extensions!)
│   └── csv-plugin.ts         # Plugin class + factory function
├── package.json              # brainbank as peerDependency
├── tsconfig.json             # ES2022, bundler resolution
├── tsup.config.ts            # ESM + types, external: ['brainbank']
└── README.md
```

## Key Files

### `package.json`

```json
{
    "name": "brainbank-csv",
    "peerDependencies": {
        "brainbank": ">=0.7.0"
    }
}
```

`brainbank` is a **peer dependency** — never a regular dependency. This avoids bundling core into your package. Users install `brainbank` once and your plugin references it.

### `tsup.config.ts`

```typescript
export default defineConfig({
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    dts: true,
    external: ['brainbank'],  // Never bundle the peer dep
});
```

### `src/index.ts`

```typescript
export { csv } from './csv-plugin.js';       // .js extension!
export type { CsvPluginOptions } from './csv-plugin.js';
```

> **Important:** Use `.js` extensions for local imports in packages. `tsup` resolves them during build.

### `src/csv-plugin.ts`

The plugin implements `IndexablePlugin`, `SearchablePlugin`, and `WatchablePlugin`:

```typescript
import type { Plugin, PluginContext, SearchResult } from 'brainbank';
import { expose } from 'brainbank';

class CsvPlugin implements Plugin {
    readonly name = 'csv';
    private ctx!: PluginContext;

    async initialize(ctx: PluginContext) { this.ctx = ctx; }

    async index() { /* read .csv files, store rows in ctx.collection('csv_data') */ }
    async search(query: string) { /* search the collection */ }

    @expose async searchCsv(query: string, k = 5) { return this.search(query, { k }); }
    @expose csvStats() { return { rows: this.ctx.collection('csv_data').count() }; }

    watchPatterns() { return ['**/*.csv']; }
    async onFileChange() { await this.index(); return true; }
}

export function csv(opts?: CsvPluginOptions): Plugin {
    return new CsvPlugin(opts);
}
```

See [src/csv-plugin.ts](src/csv-plugin.ts) for the full implementation.

## Build & Publish

```bash
npm install
npm run build          # → dist/index.js + dist/index.d.ts

# Test locally
npm link
cd /your/project && npm link brainbank-csv

# Publish
npm publish --access public
```

## Usage by Consumers

```bash
npm i brainbank brainbank-csv
```

```typescript
import { BrainBank } from 'brainbank';
import { csv } from 'brainbank-csv';

const brain = new BrainBank({ repoPath: '.' })
    .use(csv({ dir: './data' }));

await brain.initialize();
await brain.index();                         // indexes .csv files
const results = await brain.search('query'); // CSV rows in results via RRF
const csvHits = await brain.searchCsv('q');  // direct CSV search
```

## Checklist

| Item | Why |
|------|-----|
| `brainbank` as `peerDependency` | Avoids bundling core; users install once |
| `.js` extensions on local imports | Required for ESM packages built with tsup |
| Factory function export (`csv()`) | Hides class, takes config, returns `Plugin` |
| `@expose` on public methods | Auto-injects onto `brain` after init |
| `index()` method | Joins `brain.index()` pipeline |
| `search()` method | Results merge into `brain.search()` via RRF |
| `stats()` method | Shows in `brainbank stats` CLI command |
| `external: ['brainbank']` in tsup | Never bundle the peer dep |

import { defineConfig } from 'tsup';

export default defineConfig({
    entry: {
        'index': 'src/index.ts',
        'code': 'src/indexers/code-indexer.ts',
        'git': 'src/indexers/git-indexer.ts',
        'docs': 'src/indexers/docs-indexer.ts',
        'notes': 'src/indexers/notes-indexer.ts',
        'memory': 'src/indexers/learning-indexer.ts',
        'cli': 'src/cli.ts',
    },
    tsconfig: 'tsconfig.build.json',
    format: ['esm'],
    target: 'node18',
    dts: true,
    splitting: true,
    sourcemap: true,
    clean: true,
    external: [
        // dependencies — let consumers resolve
        'better-sqlite3',
        'hnswlib-node',
        // optional deps
        '@xenova/transformers',
        'simple-git',
        // separate packages (dynamic imports in CLI)
        '@brainbank/reranker',
        '@brainbank/mcp',
    ],
    banner: {
        js: '',
    },
    esbuildOptions(options) {
        options.keepNames = true;
    },
});

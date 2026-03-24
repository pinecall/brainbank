import { defineConfig } from 'tsup';

export default defineConfig({
    entry: {
        'index': 'src/index.ts',
        'code': 'src/indexers/code/plugin.ts',
        'git': 'src/indexers/git/plugin.ts',
        'docs': 'src/indexers/docs/plugin.ts',
        'notes': 'src/indexers/notes/plugin.ts',
        'memory': 'src/memory/plugin.ts',
        'cli': 'src/cli/index.ts',
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

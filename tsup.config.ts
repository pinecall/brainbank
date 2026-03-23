import { defineConfig } from 'tsup';

export default defineConfig({
    entry: {
        'index': 'src/index.ts',
        'code': 'src/plugins/code.ts',
        'git': 'src/plugins/git.ts',
        'docs': 'src/plugins/docs.ts',
        'notes': 'src/plugins/notes.ts',
        'memory': 'src/plugins/memory.ts',
        'cli': 'src/integrations/cli.ts',
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

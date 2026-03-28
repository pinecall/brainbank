import { defineConfig } from 'tsup';

export default defineConfig({
    entry: {
        'index': 'src/index.ts',
        'code': 'src/indexers/code/code-plugin.ts',
        'git': 'src/indexers/git/git-plugin.ts',
        'docs': 'src/indexers/docs/docs-plugin.ts',
        'memory': 'src/domain/memory/memory-plugin.ts',
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
        'node-llama-cpp',
        // separate packages
        '@brainbank/mcp',
    ],
    banner: {
        js: '',
    },
    esbuildOptions(options) {
        options.keepNames = true;
        options.alias = { '@': './src' };
    },
});

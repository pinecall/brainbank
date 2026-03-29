import { defineConfig } from 'tsup';

export default defineConfig({
    entry: {
        'index': 'src/index.ts',
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
        'node-llama-cpp',
        // separate @brainbank/* packages (resolved at runtime)
        '@brainbank/code',
        '@brainbank/git',
        '@brainbank/docs',
        '@brainbank/memory',
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

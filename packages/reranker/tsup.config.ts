import { defineConfig } from 'tsup';

export default defineConfig({
    entry: { 'index': 'src/index.ts' },
    format: ['esm'],
    target: 'node18',
    dts: false,
    sourcemap: true,
    clean: true,
    external: ['brainbank', 'node-llama-cpp'],
    esbuildOptions(options) { options.keepNames = true; },
});

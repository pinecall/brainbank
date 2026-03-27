import { defineConfig } from 'tsup';

export default defineConfig({
    entry: { 'mcp-server': 'src/mcp-server.ts' },
    format: ['esm'],
    target: 'node18',
    dts: false,
    sourcemap: true,
    clean: true,
    external: [
        'brainbank', 'brainbank/code', 'brainbank/git', 'brainbank/docs', 'brainbank/reranker',
        '@modelcontextprotocol/sdk', 'zod',
    ],
    esbuildOptions(options) { options.keepNames = true; },
});

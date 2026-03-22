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
        'mcp-server': 'src/integrations/mcp-server.ts',
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
        'zod',
        '@modelcontextprotocol/sdk',
        // optional deps
        '@xenova/transformers',
        'node-llama-cpp',
        'simple-git',
    ],
    banner: {
        // CLI + MCP server need shebang
        js: '',
    },
    esbuildOptions(options) {
        // Preserve dynamic imports for optional deps
        options.keepNames = true;
    },
});

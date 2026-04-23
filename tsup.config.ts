import { defineConfig } from 'tsup';

export default defineConfig({
    entry: {
        'index': 'src/index.ts',
        'cli': 'src/cli/index.ts',
        'mcp': 'src/mcp/mcp-server.ts',
    },
    tsconfig: 'tsconfig.build.json',
    format: ['esm'],
    target: 'node22',
    dts: true,
    splitting: true,
    sourcemap: true,
    clean: true,
    external: [
        // dependencies — let consumers resolve
        'hnswlib-node',
        // optional deps
        '@xenova/transformers',
        'node-llama-cpp',
        // separate @brainbank/* packages (resolved at runtime)
        '@brainbank/code',
        '@brainbank/git',
        '@brainbank/docs',
        // MCP deps (resolved at runtime)
        '@modelcontextprotocol/sdk',
        'zod',
    ],
    banner: {
        js: '',
    },
    esbuildOptions(options) {
        options.keepNames = true;
        options.alias = { '@': './src' };
    },
    // Restore `node:` prefix that esbuild strips — required for node:sqlite
    // which has no bare-name fallback (unlike fs, path, etc.).
    onSuccess: `node -e "
        const fs = require('fs');
        const glob = require('path');
        for (const f of fs.readdirSync('dist')) {
            if (!f.endsWith('.js')) continue;
            const p = 'dist/' + f;
            let c = fs.readFileSync(p, 'utf8');
            if (c.includes('from \\"sqlite\\"')) {
                c = c.replace(/from \\"sqlite\\"/g, 'from \\"node:sqlite\\"');
                fs.writeFileSync(p, c);
            }
        }
    "`,
});

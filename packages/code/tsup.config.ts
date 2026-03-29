import { defineConfig } from 'tsup';

export default defineConfig({
    entry: { 'index': 'src/index.ts' },
    format: ['esm'],
    target: 'node18',
    dts: true,
    splitting: false,
    sourcemap: true,
    clean: true,
    external: [
        'brainbank',
        'tree-sitter',
        'tree-sitter-typescript', 'tree-sitter-javascript', 'tree-sitter-python',
        'tree-sitter-go', 'tree-sitter-rust', 'tree-sitter-c', 'tree-sitter-cpp',
        'tree-sitter-java', 'tree-sitter-kotlin', 'tree-sitter-scala',
        'tree-sitter-ruby', 'tree-sitter-php', 'tree-sitter-swift',
        'tree-sitter-bash', 'tree-sitter-lua', 'tree-sitter-elixir',
        'tree-sitter-c-sharp', 'tree-sitter-html', 'tree-sitter-css',
    ],
    esbuildOptions(options) {
        options.keepNames = true;
    },
});

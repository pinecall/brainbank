/**
 * BrainBank — Language Registry
 * 
 * Supported file extensions, language mappings, and ignore lists.
 * Controls which files get indexed and how they're chunked.
 */

// ── Supported Extensions ────────────────────────────

export const SUPPORTED_EXTENSIONS: Record<string, string> = {
    // TypeScript / JavaScript
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.mjs': 'javascript',
    '.cjs': 'javascript',

    // Systems
    '.go': 'go',
    '.rs': 'rust',
    '.cpp': 'cpp',
    '.cc': 'cpp',
    '.c': 'c',
    '.h': 'c',
    '.hpp': 'cpp',

    // JVM
    '.java': 'java',
    '.kt': 'kotlin',
    '.scala': 'scala',

    // Scripting
    '.py': 'python',
    '.rb': 'ruby',
    '.php': 'php',
    '.lua': 'lua',
    '.sh': 'bash',
    '.bash': 'bash',
    '.zsh': 'bash',

    // Web
    '.html': 'html',
    '.css': 'css',
    '.scss': 'scss',
    '.less': 'less',
    '.svelte': 'svelte',
    '.vue': 'vue',

    // Data / Config
    '.json': 'json',
    '.yaml': 'yaml',
    '.yml': 'yaml',
    '.toml': 'toml',
    '.xml': 'xml',
    '.graphql': 'graphql',
    '.gql': 'graphql',

    // Docs
    '.md': 'markdown',
    '.mdx': 'markdown',

    // Database
    '.sql': 'sql',
    '.prisma': 'prisma',

    // Other
    '.swift': 'swift',
    '.dart': 'dart',
    '.r': 'r',
    '.ex': 'elixir',
    '.exs': 'elixir',
    '.erl': 'erlang',
    '.zig': 'zig',
};

// ── Ignore Directories ──────────────────────────────

export const IGNORE_DIRS = new Set([
    // Package managers
    'node_modules',
    'bower_components',
    '.pnpm',

    // Build output
    'dist',
    'build',
    'out',
    '.next',
    '.nuxt',
    '.output',
    '.svelte-kit',

    // Auto-generated code
    'generated',
    'sdk',
    'openapi',

    // Version control
    '.git',
    '.hg',
    '.svn',

    // IDE / Editor
    '.idea',
    '.vscode',

    // Runtime / Cache
    '__pycache__',
    '.pytest_cache',
    'venv',
    '.venv',
    '.env',
    '.tox',

    // Coverage / Test artifacts
    'coverage',
    '.nyc_output',
    'htmlcov',

    // Compiled
    'target',     // Rust, Java
    '.cargo',
    'vendor',     // Go, PHP

    // Database (auto-generated migrations, dumps, seeds)
    'migrations',
    'db_dumps',
    'seeds',

    // AI / Model cache
    '.model-cache',
    '.brainbank',

    // OS
    '.DS_Store',
]);

// ── Ignore Files ────────────────────────────────────

export const IGNORE_FILES = new Set([
    'package-lock.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    'bun.lockb',
    'Cargo.lock',
    'Gemfile.lock',
    'poetry.lock',
    'composer.lock',
    'go.sum',
]);

// ── Helpers ─────────────────────────────────────────

import path from 'node:path';

/** Check if a file extension is supported for indexing. */
export function isSupported(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return ext in SUPPORTED_EXTENSIONS;
}

/** Get the language name for a file. Returns undefined if not supported. */
export function getLanguage(filePath: string): string | undefined {
    const ext = path.extname(filePath).toLowerCase();
    return SUPPORTED_EXTENSIONS[ext];
}

/** Check if a directory name should be ignored. */
export function isIgnoredDir(dirName: string): boolean {
    return IGNORE_DIRS.has(dirName);
}

/** Check if a filename should be ignored. */
export function isIgnoredFile(fileName: string): boolean {
    return IGNORE_FILES.has(fileName);
}

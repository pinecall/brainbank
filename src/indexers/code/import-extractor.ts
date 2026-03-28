/**
 * BrainBank — Import Extractor
 *
 * Extracts import/require statements from source code using regex.
 * Language-aware: supports JS/TS, Python, Go, Ruby, Rust, Java/Kotlin,
 * C/C++, C#, PHP, Elixir, Lua, Swift, Scala, Bash.
 *
 * Returns module names (not full paths) for embedding context enrichment.
 */

// ── Language-specific patterns ──────────────────────

const PATTERNS: Record<string, RegExp[]> = {
    // JS/TS: import ... from '...', require('...'), import('...')
    typescript: [
        /from\s+['"]([^'"]+)['"]/g,
        /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    ],
    javascript: [
        /from\s+['"]([^'"]+)['"]/g,
        /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    ],

    // Python: import X, from X import Y
    python: [
        /^\s*import\s+([\w.]+)/gm,
        /^\s*from\s+([\w.]+)\s+import/gm,
    ],

    // Go: import "pkg" or import ( "pkg" )
    go: [
        /import\s+"([^"]+)"/g,
        /^\s*"([^"]+)"\s*$/gm,
    ],

    // Ruby: require 'X', require_relative 'X'
    ruby: [
        /require(?:_relative)?\s+['"]([^'"]+)['"]/g,
    ],

    // Rust: use X::Y, mod X
    rust: [
        /^\s*use\s+([\w:]+)/gm,
        /^\s*mod\s+(\w+)\s*;/gm,
    ],

    // Java/Kotlin: import X.Y.Z
    java: [
        /^\s*import\s+(?:static\s+)?([\w.]+)/gm,
    ],
    kotlin: [
        /^\s*import\s+([\w.]+)/gm,
    ],
    scala: [
        /^\s*import\s+([\w.]+)/gm,
    ],

    // C/C++: #include <X> or #include "X"
    c: [
        /#include\s*[<"]([^>"]+)[>"]/g,
    ],
    cpp: [
        /#include\s*[<"]([^>"]+)[>"]/g,
    ],

    // C#: using X.Y
    csharp: [
        /^\s*using\s+([\w.]+)\s*;/gm,
    ],

    // PHP: use X\Y, require/include 'X'
    php: [
        /^\s*use\s+([\w\\]+)/gm,
        /(?:require|include)(?:_once)?\s+['"]([^'"]+)['"]/g,
    ],

    // Elixir: import X, alias X, use X
    elixir: [
        /^\s*(?:import|alias|use|require)\s+([\w.]+)/gm,
    ],

    // Lua: require('X') or require "X"
    lua: [
        /require\s*\(?\s*['"]([^'"]+)['"]\s*\)?/g,
    ],

    // Swift: import X
    swift: [
        /^\s*import\s+(\w+)/gm,
    ],

    // Bash: source X, . X
    bash: [
        /^\s*(?:source|\.)\s+['"]?([^\s'"]+)['"]?/gm,
    ],

    // HTML: <script src="X">, <link href="X">
    html: [
        /src=["']([^"']+)["']/g,
        /href=["']([^"']+\.(?:css|js))["']/g,
    ],

    // CSS: @import url('X'), @import 'X'
    css: [
        /@import\s+(?:url\s*\(\s*)?['"]?([^'");\s]+)['"]?\s*\)?/g,
    ],
};

// ── Public API ──────────────────────────────────────

/** Extract import/require module names from source code. */
export function extractImports(content: string, language: string): string[] {
    const patterns = PATTERNS[language];
    if (!patterns) return [];

    const imports = new Set<string>();

    for (const pattern of patterns) {
        // Reset lastIndex for reuse
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(content)) !== null) {
            const mod = match[1].trim();
            if (mod) imports.add(simplifyModule(mod));
        }
    }

    return [...imports];
}

/** Simplify a module path to its meaningful name. */
function simplifyModule(mod: string): string {
    // Remove file extensions
    const cleaned = mod.replace(/\.\w+$/, '');
    // For node-style paths, take basename
    if (cleaned.startsWith('./') || cleaned.startsWith('../')) {
        const parts = cleaned.split('/');
        return parts[parts.length - 1];
    }
    // For Python/Java dotted paths, keep last 2 segments max
    if (cleaned.includes('.') && !cleaned.includes('/')) {
        const parts = cleaned.split('.');
        return parts.length > 2 ? parts.slice(-2).join('.') : cleaned;
    }
    // For Rust :: paths
    if (cleaned.includes('::')) {
        const parts = cleaned.split('::');
        return parts.length > 2 ? parts.slice(-2).join('::') : cleaned;
    }
    return cleaned;
}

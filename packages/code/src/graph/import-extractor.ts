/**
 * BrainBank — Import Extractor
 *
 * Extracts import/require statements from source code using regex.
 * Language-aware: supports JS/TS, Python, Go, Ruby, Rust, Java/Kotlin,
 * C/C++, C#, PHP, Elixir, Lua, Swift, Scala, Bash.
 *
 * Two modes:
 * - extractImports()     → simplified module names for embedding enrichment
 * - extractImportPaths() → raw specifiers with kind + local flag for the dependency graph
 */

// ── Types ──────────────────────────────────────────────

/** Import relationship kind. */
export type ImportKind = 'static' | 'dynamic' | 'type' | 'require' | 'side-effect' | 'export-from';

/** A raw import edge with the original specifier preserved. */
export interface ImportEdge {
    specifier: string;
    kind: ImportKind;
    isLocal: boolean;
}
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

// ── Import Path Extraction (for dependency graph) ────

/** Language-specific pattern sets that capture specifier + classify kind. */
const PATH_PATTERNS: Record<string, Array<{ re: RegExp; kind: ImportKind }>> = {
    typescript: [
        { re: /\bimport\s+type\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm, kind: 'type' },
        { re: /\bimport\s+(?:[^'"]*?\s+from\s+)['"]([^'"]+)['"]/gm, kind: 'static' },
        { re: /\bimport\s+['"]([^'"]+)['"]/gm, kind: 'side-effect' },
        { re: /\bexport\s+(?:type\s+)?(?:\{[^}]*\}|\*(?:\s+as\s+\w+)?)\s+from\s+['"]([^'"]+)['"]/gm, kind: 'export-from' },
        { re: /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/gm, kind: 'require' },
        { re: /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/gm, kind: 'dynamic' },
    ],
    javascript: [
        { re: /\bimport\s+(?:[^'"]*?\s+from\s+)['"]([^'"]+)['"]/gm, kind: 'static' },
        { re: /\bimport\s+['"]([^'"]+)['"]/gm, kind: 'side-effect' },
        { re: /\bexport\s+(?:\{[^}]*\}|\*(?:\s+as\s+\w+)?)\s+from\s+['"]([^'"]+)['"]/gm, kind: 'export-from' },
        { re: /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/gm, kind: 'require' },
        { re: /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/gm, kind: 'dynamic' },
    ],
    python: [
        { re: /\bfrom\s+(\.{0,3}[\w.]*)\s+import\s+/gm, kind: 'static' },
        { re: /\bimport\s+([\w.]+)/gm, kind: 'static' },
        { re: /\bimportlib\.import_module\s*\(\s*['"]([^'"]+)['"]\s*\)/gm, kind: 'dynamic' },
        { re: /__import__\s*\(\s*['"]([^'"]+)['"]\s*\)/gm, kind: 'dynamic' },
    ],
    go: [
        { re: /import\s+"([^"]+)"/g, kind: 'static' },
        { re: /^\s*"([^"]+)"\s*$/gm, kind: 'static' },
    ],
    ruby: [
        { re: /require_relative\s+['"]([^'"]+)['"]/g, kind: 'static' },
        { re: /require\s+['"]([^'"]+)['"]/g, kind: 'require' },
    ],
    rust: [
        { re: /\buse\s+([\w:]+)/gm, kind: 'static' },
        { re: /\bmod\s+(\w+)\s*;/gm, kind: 'static' },
    ],
    java: [
        { re: /\bimport\s+(?:static\s+)?([\w.]+)/gm, kind: 'static' },
    ],
    kotlin: [
        { re: /\bimport\s+([\w.]+)/gm, kind: 'static' },
    ],
    scala: [
        { re: /\bimport\s+([\w.]+)/gm, kind: 'static' },
    ],
    c: [
        { re: /#include\s*["<]([^">]+)[">]/g, kind: 'static' },
    ],
    cpp: [
        { re: /#include\s*["<]([^">]+)[">]/g, kind: 'static' },
    ],
    csharp: [
        { re: /\busing\s+([\w.]+)\s*;/gm, kind: 'static' },
    ],
    php: [
        { re: /^\s*use\s+([\w\\]+)/gm, kind: 'static' },
        { re: /\brequire_once\s+['"]([^'"]+)['"]/g, kind: 'require' },
        { re: /\brequire\s+['"]([^'"]+)['"]/g, kind: 'require' },
        { re: /\binclude_once\s+['"]([^'"]+)['"]/g, kind: 'static' },
        { re: /\binclude\s+['"]([^'"]+)['"]/g, kind: 'static' },
    ],
    elixir: [
        { re: /\b(?:import|alias|use|require)\s+([\w.]+)/gm, kind: 'static' },
    ],
    lua: [
        { re: /require\s*\(?\s*['"]([^'"]+)['"]\s*\)?/g, kind: 'require' },
    ],
    swift: [
        { re: /^\s*import\s+(\w+)/gm, kind: 'static' },
    ],
    bash: [
        { re: /^\s*(?:source|\.)\s+['"]?([^\s'"]+)['"]?/gm, kind: 'static' },
    ],
    html: [
        { re: /src=["']([^"']+)["']/g, kind: 'static' },
        { re: /href=["']([^"']+\.(?:css|js))["']/g, kind: 'static' },
    ],
    css: [
        { re: /@import\s+(?:url\s*\(\s*)?['"]?([^'");\s]+)['"]?\s*\)?/g, kind: 'static' },
    ],
};

/** Languages that use dotted paths for local modules. */
const DOTTED_LANGUAGES = new Set(['python', 'java', 'kotlin', 'scala', 'csharp', 'elixir']);

/** Check if a specifier is a local/relative import. */
function isLocalImport(specifier: string, language: string): boolean {
    // Standard relative: ./ or ../
    if (specifier.startsWith('./') || specifier.startsWith('../')) return true;
    // Python relative: starts with .
    if (language === 'python' && specifier.startsWith('.')) return true;
    // Bash source with relative path
    if (language === 'bash' && !specifier.startsWith('/')) return true;
    // PHP bare includes with extension
    if (/\.(php|phtml)$/i.test(specifier) && !/^[A-Z]:[/\\]/i.test(specifier)) return true;
    // Ruby require_relative is always local
    // (handled by kind — but the specifier itself is relative)
    if (language === 'ruby' && !specifier.includes('/') === false) return true;
    // Dotted package paths (Python: pinecall.pipeline.turn_controller, Java: com.example.Foo)
    // These are potentially local — let the resolver decide
    if (DOTTED_LANGUAGES.has(language) && specifier.includes('.') && !specifier.includes('/')) return true;
    // Rust crate-relative paths
    if (language === 'rust' && specifier.startsWith('crate::')) return true;
    return false;
}

/** Extract raw import specifiers with kind + local flag for the dependency graph. */
export function extractImportPaths(content: string, language: string): ImportEdge[] {
    const patterns = PATH_PATTERNS[language];
    if (!patterns) return [];

    const seen = new Set<string>();
    const edges: ImportEdge[] = [];

    for (const { re, kind } of patterns) {
        re.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = re.exec(content)) !== null) {
            const specifier = match[1].trim();
            if (!specifier) continue;

            // Deduplicate by specifier (keep the first kind seen)
            const dedup = `${specifier}::${kind}`;
            if (seen.has(dedup)) continue;
            seen.add(dedup);

            edges.push({
                specifier,
                kind,
                isLocal: isLocalImport(specifier, language),
            });
        }
    }

    return edges;
}


/**
 * @brainbank/code — Import Resolver
 *
 * Resolves raw import specifiers to actual file paths at index time.
 * Uses the set of known indexed files as the resolution universe.
 *
 * Strategies (tried in order):
 * 1. Exact match
 * 2. Extension probing (.ts, .py, .go, etc.)
 * 3. Index file fallback (index.ts, __init__.py)
 * 4. Dotted path resolution (pinecall.pipeline.vad → src/pinecall/pipeline/vad.py)
 * 5. Tail-index fuzzy matching
 */

// ── Extension resolution order per language family ──────────────

const RESOLVE_EXTS: Record<string, string[]> = {
    typescript:  ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'],
    javascript:  ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs'],
    python:      ['py', 'pyw'],
    go:          ['go'],
    ruby:        ['rb'],
    rust:        ['rs'],
    java:        ['java'],
    kotlin:      ['kt', 'kts'],
    scala:       ['scala'],
    c:           ['c', 'h'],
    cpp:         ['cpp', 'hpp', 'cc', 'hh', 'cxx', 'hxx'],
    csharp:      ['cs'],
    php:         ['php', 'phtml'],
    elixir:      ['ex', 'exs'],
    lua:         ['lua'],
    swift:       ['swift'],
    bash:        ['sh', 'bash'],
};

/** Default extensions when language is unknown. */
const DEFAULT_EXTS = ['ts', 'tsx', 'js', 'jsx', 'py', 'go', 'rs', 'java', 'rb'];

/** Languages that use '.' as path separator. */
const DOT_SEPARATOR_LANGS = new Set(['python', 'java', 'kotlin', 'scala', 'csharp', 'elixir']);

/** Languages that use '::' as path separator. */
const DOUBLE_COLON_LANGS = new Set(['rust']);

// ── Stdlib / Builtin module filters ────────────────────────────

/** Modules that should NOT enter the import graph (they are part of the language stdlib). */
const STDLIB: Record<string, Set<string>> = {
    python: new Set([
        'os', 'sys', 'json', 'asyncio', 'time', 'datetime', 're', 'math',
        'collections', 'itertools', 'functools', 'typing', 'pathlib', 'io',
        'subprocess', 'threading', 'multiprocessing', 'logging', 'unittest',
        'abc', 'dataclasses', 'enum', 'copy', 'hashlib', 'hmac', 'secrets',
        'uuid', 'base64', 'struct', 'socket', 'http', 'urllib', 'email',
        'html', 'xml', 'csv', 'sqlite3', 'contextlib', 'traceback',
        'inspect', 'dis', 'gc', 'weakref', 'pickle', 'shelve', 'marshal',
        'warnings', 'string', 'textwrap', 'shutil', 'tempfile', 'glob',
        'fnmatch', 'stat', 'fileinput', 'signal', 'mmap', 'ctypes',
        'select', 'selectors', 'ssl', 'pdb', 'profile', 'timeit',
        'operator', 'array', 'queue', 'heapq', 'bisect', 'sched',
        'calendar', 'locale', 'gettext', 'argparse', 'configparser',
        'platform', 'errno', 'codecs', 'unicodedata', 'pprint',
        'decimal', 'fractions', 'random', 'statistics', 'numbers',
        'ast', 'token', 'keyword', 'tokenize', 'importlib', 'pkgutil',
        'zipimport', 'compileall', 'py_compile', 'zipfile', 'tarfile',
        'gzip', 'bz2', 'lzma', 'zlib', 'builtins', '__future__',
        'concurrent', 'types', 'typing_extensions', 'distutils', 'site',
        'sysconfig', 'venv', 'ensurepip', 'runpy',
    ]),
    javascript: new Set([
        'fs', 'path', 'http', 'https', 'crypto', 'stream', 'events',
        'buffer', 'child_process', 'os', 'url', 'dns', 'net', 'tls',
        'cluster', 'worker_threads', 'perf_hooks', 'util', 'assert',
        'querystring', 'readline', 'zlib', 'vm', 'v8', 'tty',
        'string_decoder', 'punycode', 'process', 'module', 'inspector',
        'diagnostics_channel', 'async_hooks', 'console', 'timers',
    ]),
    go: new Set([
        'fmt', 'os', 'io', 'net', 'http', 'log', 'time', 'sync',
        'context', 'errors', 'strings', 'strconv', 'bytes', 'bufio',
        'math', 'sort', 'regexp', 'encoding', 'flag', 'runtime',
        'reflect', 'testing', 'crypto', 'hash', 'path', 'filepath',
        'database', 'archive', 'compress', 'image', 'text', 'html',
        'unicode', 'embed', 'debug', 'go', 'syscall', 'unsafe',
    ]),
};

/** Check if an import specifier is a stdlib/builtin module. */
export function isStdlib(specifier: string, language: string): boolean {
    // Normalize: strip 'node:' prefix for JS/TS
    let root = specifier;
    if ((language === 'javascript' || language === 'typescript') && root.startsWith('node:')) {
        root = root.slice(5);
    }

    // Extract root module from dotted/slashed paths
    const dotIdx = root.indexOf('.');
    const slashIdx = root.indexOf('/');
    if (dotIdx > 0 && (slashIdx < 0 || dotIdx < slashIdx)) {
        root = root.slice(0, dotIdx);
    } else if (slashIdx > 0) {
        root = root.slice(0, slashIdx);
    }

    // JS/TS share the same stdlib set (Node builtins)
    const lang = language === 'typescript' ? 'javascript' : language;
    const stdSet = STDLIB[lang];
    if (stdSet) return stdSet.has(root);

    // Rust: std, core, alloc are stdlib
    if (language === 'rust') {
        const rustRoot = specifier.split('::')[0];
        return rustRoot === 'std' || rustRoot === 'core' || rustRoot === 'alloc';
    }

    // Java/Kotlin/Scala: java.*, javax.* are stdlib
    if (language === 'java' || language === 'kotlin' || language === 'scala') {
        return root === 'java' || root === 'javax';
    }

    // C#: System.* is stdlib
    if (language === 'csharp') {
        return root === 'System';
    }

    return false;
}

// ── Tail index ──────────────────────────────────────────────────

/** Map of "parent/file.ext" → full relative path for fuzzy resolution. */
function buildTailIndex(paths: Iterable<string>): Map<string, string> {
    const index = new Map<string, string>();
    for (const p of paths) {
        const segs = p.split('/');
        // Map "filename.ext" → path
        if (segs.length >= 1) {
            index.set(segs[segs.length - 1], p);
        }
        // Map "parent/filename.ext" → path
        if (segs.length >= 2) {
            index.set(segs.slice(-2).join('/'), p);
        }
        // Map "grandparent/parent/filename.ext" → path (for dotted paths)
        if (segs.length >= 3) {
            index.set(segs.slice(-3).join('/'), p);
        }
    }
    return index;
}

/** Map of "dotted.module.name" → file path for dotted path languages. */
function buildDottedIndex(paths: Iterable<string>, exts: string[]): Map<string, string> {
    const index = new Map<string, string>();
    const extSet = new Set(exts);
    for (const p of paths) {
        const ext = p.split('.').pop() ?? '';
        if (!extSet.has(ext)) continue;
        // Strip extension, convert / to .
        const withoutExt = p.replace(/\.\w+$/, '');
        const dotted = withoutExt.replace(/\//g, '.');
        index.set(dotted, p);
        // Also index without __init__ suffix (Python packages)
        if (dotted.endsWith('.__init__')) {
            index.set(dotted.replace(/\.__init__$/, ''), p);
        }
    }
    return index;
}

// ── ImportResolver ──────────────────────────────────────────────

/** Resolves import specifiers to known file paths at index time. */
export class ImportResolver {
    private _known: Set<string>;
    private _tailIndex: Map<string, string>;
    private _dottedIndex: Map<string, string> | null;
    private _exts: string[];
    private _language: string;

    constructor(knownFiles: Set<string>, language?: string) {
        this._known = knownFiles;
        this._tailIndex = buildTailIndex(knownFiles);
        this._exts = (language ? RESOLVE_EXTS[language] : null) ?? DEFAULT_EXTS;
        this._language = language ?? '';

        // Build dotted index for languages that use dotted paths
        if (language && DOT_SEPARATOR_LANGS.has(language)) {
            this._dottedIndex = buildDottedIndex(knownFiles, this._exts);
        } else {
            this._dottedIndex = null;
        }
    }

    /** Resolve a local import specifier to a known file path. Returns null if unresolvable. */
    resolve(specifier: string, fromFile: string): string | null {
        // Try relative path resolution first (./foo, ../bar)
        if (specifier.startsWith('./') || specifier.startsWith('../')) {
            return this._resolveRelative(specifier, fromFile);
        }

        // Python relative import (starts with . but not ./  or ..)
        if (this._language === 'python' && specifier.startsWith('.')) {
            return this._resolvePythonRelative(specifier, fromFile);
        }

        // Dotted path resolution (pinecall.pipeline.vad)
        if (this._dottedIndex && specifier.includes('.') && !specifier.includes('/')) {
            return this._resolveDotted(specifier, fromFile);
        }

        // Rust crate:: paths
        if (DOUBLE_COLON_LANGS.has(this._language) && specifier.includes('::')) {
            return this._resolveRustPath(specifier);
        }

        // Ruby require_relative — treat as relative
        if (this._language === 'ruby') {
            return this._resolveRelative(specifier, fromFile);
        }

        // Bash source — treat as relative
        if (this._language === 'bash') {
            return this._resolveRelative(specifier, fromFile);
        }

        // Fallback: tail-index
        return this._tailFallback(specifier);
    }

    /** Resolve a standard relative path (./foo, ../bar). */
    private _resolveRelative(specifier: string, fromFile: string): string | null {
        const fromDir = fromFile.split('/').slice(0, -1).join('/');
        const resolved = this._navigatePath(specifier, fromDir);

        // 1. Exact match
        if (this._known.has(resolved)) return resolved;

        // 2. Try with extensions
        for (const ext of this._exts) {
            const candidate = `${resolved}.${ext}`;
            if (this._known.has(candidate)) return candidate;
        }

        // 3. Try index file (e.g. ./utils → ./utils/index.ts)
        for (const ext of this._exts) {
            const candidate = `${resolved}/index.${ext}`;
            if (this._known.has(candidate)) return candidate;
        }

        // 4. Try __init__.py for Python
        if (this._exts.includes('py')) {
            const initCandidate = `${resolved}/__init__.py`;
            if (this._known.has(initCandidate)) return initCandidate;
        }

        // 5. Tail-index fallback
        return this._tailFallback(resolved);
    }

    /** Resolve Python relative imports (.utils, ..core.config). */
    private _resolvePythonRelative(specifier: string, fromFile: string): string | null {
        // Count leading dots
        let dots = 0;
        while (dots < specifier.length && specifier[dots] === '.') dots++;
        const modulePart = specifier.slice(dots);

        // Navigate up directories
        const fromParts = fromFile.split('/').slice(0, -1); // dir of current file
        for (let i = 1; i < dots; i++) fromParts.pop(); // each extra dot = go up one

        // Convert dotted module to path segments
        const modSegments = modulePart ? modulePart.split('.') : [];
        const resolved = [...fromParts, ...modSegments].join('/');

        // Try direct, with .py, and __init__.py
        if (this._known.has(resolved)) return resolved;
        if (this._known.has(`${resolved}.py`)) return `${resolved}.py`;
        if (this._known.has(`${resolved}.pyw`)) return `${resolved}.pyw`;
        if (this._known.has(`${resolved}/__init__.py`)) return `${resolved}/__init__.py`;

        return this._tailFallback(resolved);
    }

    /** Resolve dotted module paths (pinecall.pipeline.turn_controller → file path). */
    private _resolveDotted(specifier: string, fromFile: string): string | null {
        // 1. Direct lookup in dotted index
        const direct = this._dottedIndex!.get(specifier);
        if (direct) return direct;

        // 2. Try all suffixes — "pinecall.pipeline.vad" might match ".../pinecall/pipeline/vad.py"
        //    even if the full prefix differs
        const segments = specifier.split('.');
        for (let i = 0; i < segments.length; i++) {
            const suffix = segments.slice(i).join('.');
            const match = this._dottedIndex!.get(suffix);
            if (match) return match;
        }

        // 3. Convert dots to path and try tail-index
        const asPath = segments.join('/');
        for (const ext of this._exts) {
            const candidate = this._tailIndex.get(`${segments[segments.length - 1]}.${ext}`);
            if (candidate && candidate.includes(asPath)) return candidate;
        }

        // 4. Pure tail fallback
        return this._tailFallback(asPath);
    }

    /** Resolve Rust crate:: paths. */
    private _resolveRustPath(specifier: string): string | null {
        // crate::module::submodule → src/module/submodule.rs
        const parts = specifier.split('::');
        if (parts[0] === 'crate') parts.shift();
        const asPath = parts.join('/');

        for (const ext of this._exts) {
            // Try src/module.rs
            const candidate = `src/${asPath}.${ext}`;
            if (this._known.has(candidate)) return candidate;
            // Try src/module/mod.rs
            const modCandidate = `src/${asPath}/mod.${ext}`;
            if (this._known.has(modCandidate)) return modCandidate;
        }

        return this._tailFallback(asPath);
    }

    /** Navigate '../' and './' segments to produce a resolved path. */
    private _navigatePath(specifier: string, fromDir: string): string {
        const segments = specifier.split('/');
        const baseParts = fromDir ? fromDir.split('/').filter(Boolean) : [];

        for (const seg of segments) {
            if (seg === '.' || seg === '') continue;
            if (seg === '..') { baseParts.pop(); continue; }
            baseParts.push(seg);
        }

        return baseParts.join('/');
    }

    /** Tail-index fallback: match by filename or parent/filename. */
    private _tailFallback(resolved: string): string | null {
        const parts = resolved.split('/');
        const basename = parts[parts.length - 1];

        // Try "grandparent/parent/basename" with extensions
        if (parts.length >= 3) {
            const tail3 = parts.slice(-3).join('/');
            for (const ext of this._exts) {
                const match = this._tailIndex.get(`${tail3}.${ext}`);
                if (match) return match;
            }
        }

        // Try "parent/basename" with extensions
        if (parts.length >= 2) {
            const tail2 = parts.slice(-2).join('/');
            for (const ext of this._exts) {
                const match = this._tailIndex.get(`${tail2}.${ext}`);
                if (match) return match;
            }
            // Direct tail match
            const directTail = this._tailIndex.get(tail2);
            if (directTail) return directTail;
        }

        // Try basename only with extensions
        for (const ext of this._exts) {
            const match = this._tailIndex.get(`${basename}.${ext}`);
            if (match) return match;
        }

        // Direct basename match
        const directBase = this._tailIndex.get(basename);
        if (directBase) return directBase;

        return null;
    }
}

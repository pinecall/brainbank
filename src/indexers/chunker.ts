/**
 * BrainBank — Tree-Sitter Code Chunker
 * 
 * AST-aware code splitting using native tree-sitter bindings.
 * Extracts semantic blocks (functions, classes, methods, interfaces)
 * from the AST. Falls back to sliding window for unsupported languages.
 */

import { createRequire } from 'node:module';
import type { CodeChunk } from '../types.ts';

const require = createRequire(import.meta.url);

// ── Configuration ───────────────────────────────────

export interface ChunkerConfig {
    /** Max lines per chunk. Default: 80 */
    maxLines?: number;
    /** Min lines for a detected block to be a chunk. Default: 3 */
    minLines?: number;
    /** Overlap between adjacent generic chunks. Default: 5 */
    overlap?: number;
}

// ── Language grammars ───────────────────────────────

interface LangGrammar {
    grammar: any;
    nodeTypes: {
        class?: string[];
        function?: string[];
        interface?: string[];
        variable?: string[];
        method?: string[];
        struct?: string[];
        impl?: string[];
    };
}

/** Helper: try to require a grammar, return null if not installed. */
function tryGrammar(pkg: string, nodeTypes: LangGrammar['nodeTypes'], accessor?: string): () => LangGrammar | null {
    return () => {
        try {
            const mod = require(pkg);
            return { grammar: accessor ? mod[accessor] : mod, nodeTypes };
        } catch { return null; }
    };
}

const GRAMMARS: Record<string, () => LangGrammar | null> = {
    // ── Web ──────────────────────────────────────────
    typescript: tryGrammar('tree-sitter-typescript', {
        class: ['class_declaration'],
        interface: ['interface_declaration', 'type_alias_declaration'],
        function: ['function_declaration', 'method_definition'],
        variable: ['lexical_declaration'],
    }, 'typescript'),
    javascript: tryGrammar('tree-sitter-javascript', {
        class: ['class_declaration'],
        function: ['function_declaration', 'method_definition'],
        variable: ['lexical_declaration'],
    }),
    html: tryGrammar('tree-sitter-html', {}),
    css: tryGrammar('tree-sitter-css', {}),

    // ── Systems ──────────────────────────────────────
    go: tryGrammar('tree-sitter-go', {
        function: ['function_declaration', 'method_declaration'],
        struct: ['type_declaration'],
    }),
    rust: tryGrammar('tree-sitter-rust', {
        function: ['function_item'],
        struct: ['struct_item'],
        impl: ['impl_item'],
    }),
    c: tryGrammar('tree-sitter-c', {
        function: ['function_definition'],
        struct: ['struct_specifier'],
    }),
    cpp: tryGrammar('tree-sitter-cpp', {
        class: ['class_specifier'],
        function: ['function_definition'],
    }),
    swift: tryGrammar('tree-sitter-swift', {
        class: ['class_declaration'],
        function: ['function_declaration'],
        struct: ['struct_declaration'],
    }),

    // ── JVM ──────────────────────────────────────────
    java: tryGrammar('tree-sitter-java', {
        class: ['class_declaration'],
        interface: ['interface_declaration'],
        method: ['method_declaration'],
    }),
    kotlin: tryGrammar('tree-sitter-kotlin', {
        class: ['class_declaration'],
        function: ['function_declaration'],
    }),
    scala: tryGrammar('tree-sitter-scala', {
        class: ['class_definition'],
        function: ['function_definition'],
    }),

    // ── Scripting ────────────────────────────────────
    python: tryGrammar('tree-sitter-python', {
        class: ['class_definition'],
        function: ['function_definition'],
    }),
    ruby: tryGrammar('tree-sitter-ruby', {
        class: ['class'],
        method: ['method', 'singleton_method'],
    }),
    php: tryGrammar('tree-sitter-php', {
        class: ['class_declaration'],
        function: ['function_definition', 'method_declaration'],
    }, 'php'),
    lua: tryGrammar('tree-sitter-lua', {
        function: ['function_declaration'],
    }),
    bash: tryGrammar('tree-sitter-bash', {
        function: ['function_definition'],
    }),
    elixir: tryGrammar('tree-sitter-elixir', {
        function: ['call'],  // defmodule, def, defp
    }),

    // ── .NET ─────────────────────────────────────────
    c_sharp: tryGrammar('tree-sitter-c-sharp', {
        class: ['class_declaration'],
        interface: ['interface_declaration'],
        method: ['method_declaration'],
    }),
};

// ── CodeChunker ─────────────────────────────────────

export class CodeChunker {
    private MAX: number;
    private MIN: number;
    private OVERLAP: number;
    private _parser: any = null;
    private _langCache = new Map<string, LangGrammar | null>();

    constructor(config: ChunkerConfig = {}) {
        this.MAX = config.maxLines ?? 80;
        this.MIN = config.minLines ?? 3;
        this.OVERLAP = config.overlap ?? 5;
    }

    /** Lazy-init tree-sitter parser. */
    private _ensureParser(): any {
        if (!this._parser) {
            try {
                const Parser = require('tree-sitter');
                this._parser = new Parser();
            } catch {
                this._parser = false;  // Mark as unavailable
            }
        }
        return this._parser || null;
    }

    /** Load a language grammar (cached). */
    private _loadGrammar(language: string): LangGrammar | null {
        if (this._langCache.has(language)) return this._langCache.get(language)!;

        const factory = GRAMMARS[language];
        const grammar = factory ? factory() : null;
        this._langCache.set(language, grammar);
        return grammar;
    }

    /**
     * Split file content into semantic chunks using tree-sitter AST.
     * Falls back to sliding window if grammar isn't available.
     */
    async chunk(filePath: string, content: string, language: string): Promise<CodeChunk[]> {
        const lines = content.split('\n');

        // Small file → single chunk
        if (lines.length <= this.MAX) {
            return [{
                filePath,
                chunkType: 'file',
                startLine: 1,
                endLine: lines.length,
                content: content.trim(),
                language,
            }];
        }

        // Try tree-sitter AST chunking
        const parser = this._ensureParser();
        const langConfig = this._loadGrammar(language);

        if (parser && langConfig) {
            try {
                parser.setLanguage(langConfig.grammar);
                const tree = parser.parse(content);
                const chunks = this._extractChunks(filePath, lines, tree.rootNode, langConfig, language);

                if (chunks.length > 0) {
                    return chunks.filter(c => c.content.length > 20);
                }
            } catch {
                // Tree-sitter failed — fall through to generic
            }
        }

        // Fallback to sliding window
        return this._chunkGeneric(filePath, lines, language);
    }

    /** Walk AST and extract top-level semantic blocks. */
    private _extractChunks(
        filePath: string, lines: string[],
        rootNode: any, langConfig: LangGrammar, language: string,
    ): CodeChunk[] {
        const chunks: CodeChunk[] = [];
        const seen = new Set<string>();

        for (let i = 0; i < rootNode.childCount; i++) {
            const child = rootNode.child(i);
            this._processNode(filePath, lines, child, langConfig, language, chunks, seen);
        }

        return chunks;
    }

    /** Classify and process a single AST node. */
    private _processNode(
        filePath: string, lines: string[], node: any,
        langConfig: LangGrammar, language: string,
        chunks: CodeChunk[], seen: Set<string>,
    ): void {
        const type = node.type;

        // Handle export_statement: process what it wraps
        if (type === 'export_statement') {
            for (let i = 0; i < node.childCount; i++) {
                const child = node.child(i);
                const category = this._categorize(child.type, langConfig);
                if (category) {
                    this._processDeclaration(filePath, lines, node, child, category, langConfig, language, chunks, seen);
                    return;
                }
            }
            // Export with no recognized declaration — chunk the whole thing if big enough
            const nodeLines = node.endPosition.row - node.startPosition.row + 1;
            if (nodeLines >= this.MIN) {
                this._addChunk(filePath, lines, node, 'function', this._extractName(node), language, chunks, seen);
            }
            return;
        }

        // Python decorated definitions (@decorator + class/def)
        if (type === 'decorated_definition') {
            for (let i = 0; i < node.childCount; i++) {
                const child = node.child(i);
                const category = this._categorize(child.type, langConfig);
                if (category) {
                    this._processDeclaration(filePath, lines, node, child, category, langConfig, language, chunks, seen);
                    return;
                }
            }
        }

        // Direct match
        const category = this._categorize(type, langConfig);
        if (category) {
            this._processDeclaration(filePath, lines, node, node, category, langConfig, language, chunks, seen);
        }
    }

    /** Check which category a node type belongs to. */
    private _categorize(nodeType: string, langConfig: LangGrammar): string | null {
        for (const [category, types] of Object.entries(langConfig.nodeTypes)) {
            if (types && types.includes(nodeType)) return category;
        }
        return null;
    }

    /** Process a matched declaration: class → split by methods, else → chunk directly. */
    private _processDeclaration(
        filePath: string, lines: string[],
        outerNode: any, innerNode: any, category: string,
        langConfig: LangGrammar, language: string,
        chunks: CodeChunk[], seen: Set<string>,
    ): void {
        const nodeLines = outerNode.endPosition.row - outerNode.startPosition.row + 1;
        const name = this._extractName(innerNode);
        const chunkType = this._toChunkType(category);

        // Large class → split into methods
        if ((category === 'class' || category === 'struct' || category === 'impl') && nodeLines > this.MAX) {
            this._splitClassIntoMethods(filePath, lines, outerNode, innerNode, name, langConfig, language, chunks, seen);
            return;
        }

        // Large non-class → split with overlap
        if (nodeLines > this.MAX) {
            chunks.push(...this._splitLargeBlock(filePath, lines,
                outerNode.startPosition.row, outerNode.endPosition.row,
                name, chunkType, language));
            return;
        }

        // Normal-sized node
        if (nodeLines >= this.MIN) {
            this._addChunk(filePath, lines, outerNode, chunkType, name, language, chunks, seen);
        }
    }

    /** Split a large class into individual method chunks. */
    private _splitClassIntoMethods(
        filePath: string, lines: string[],
        outerNode: any, classNode: any, className: string,
        langConfig: LangGrammar, language: string,
        chunks: CodeChunk[], seen: Set<string>,
    ): void {
        // Find class body
        const body = this._findClassBody(classNode);
        if (!body) {
            chunks.push(...this._splitLargeBlock(filePath, lines,
                outerNode.startPosition.row, outerNode.endPosition.row,
                className, 'class', language));
            return;
        }

        // Get method node types
        const methodTypes = new Set([
            ...(langConfig.nodeTypes.function || []),
            ...(langConfig.nodeTypes.method || []),
        ]);

        let methodsFound = false;
        for (let i = 0; i < body.childCount; i++) {
            const child = body.child(i);
            let methodNode = child;

            // Decorated methods
            if (child.type === 'decorated_definition') {
                for (let j = 0; j < child.childCount; j++) {
                    if (methodTypes.has(child.child(j).type)) {
                        methodNode = child.child(j);
                        break;
                    }
                }
            }

            if (methodTypes.has(methodNode.type) || methodTypes.has(child.type)) {
                const methodName = this._extractName(methodNode);
                const nodeToChunk = child.type === 'decorated_definition' ? child : methodNode;
                const methodLineCount = nodeToChunk.endPosition.row - nodeToChunk.startPosition.row + 1;

                if (methodLineCount >= this.MIN) {
                    methodsFound = true;
                    const fullName = `${className}.${methodName}`;

                    if (methodLineCount > this.MAX) {
                        chunks.push(...this._splitLargeBlock(filePath, lines,
                            nodeToChunk.startPosition.row, nodeToChunk.endPosition.row,
                            fullName, 'method', language));
                    } else {
                        this._addChunk(filePath, lines, nodeToChunk, 'method', fullName, language, chunks, seen);
                    }
                }
            }
        }

        // Fallback: no methods found → split the whole class
        if (!methodsFound) {
            chunks.push(...this._splitLargeBlock(filePath, lines,
                outerNode.startPosition.row, outerNode.endPosition.row,
                className, 'class', language));
        }
    }

    /** Find the class body node. */
    private _findClassBody(classNode: any): any | null {
        const bodyTypes = ['class_body', 'block', 'declaration_list', 'body'];
        for (let i = 0; i < classNode.childCount; i++) {
            const child = classNode.child(i);
            if (bodyTypes.includes(child.type)) return child;
        }
        return null;
    }

    /** Extract name from an AST node. */
    private _extractName(node: any): string {
        // Try childForFieldName('name')
        if (typeof node.childForFieldName === 'function') {
            const nameNode = node.childForFieldName('name');
            if (nameNode) return nameNode.text;
        }
        // Try identifier children
        for (let i = 0; i < node.namedChildCount; i++) {
            const child = node.namedChild(i);
            if (['identifier', 'type_identifier', 'property_identifier'].includes(child.type)) {
                return child.text;
            }
        }
        // For variable declarations, dig into declarators
        if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
            for (let i = 0; i < node.namedChildCount; i++) {
                const child = node.namedChild(i);
                if (child.type === 'variable_declarator') {
                    const nameNode = child.childForFieldName('name');
                    if (nameNode) return nameNode.text;
                }
            }
        }
        return 'anonymous';
    }

    /** Map category to chunk type. */
    private _toChunkType(category: string): string {
        if (category === 'class' || category === 'struct' || category === 'impl') return 'class';
        if (category === 'interface') return 'interface';
        if (category === 'variable') return 'function';
        return category;
    }

    /** Add a node as a chunk, avoiding duplicates. */
    private _addChunk(
        filePath: string, lines: string[], node: any,
        chunkType: string, name: string, language: string,
        chunks: CodeChunk[], seen: Set<string>,
    ): void {
        const start = node.startPosition.row;
        const end = node.endPosition.row;
        const key = `${start}-${end}`;
        if (seen.has(key)) return;
        seen.add(key);

        const content = lines.slice(start, end + 1).join('\n').trim();
        if (content.length <= 20) return;

        chunks.push({
            filePath,
            chunkType,
            name,
            startLine: start + 1,
            endLine: end + 1,
            content,
            language,
        });
    }

    // ── Fallback: Generic sliding window ────────────

    private _chunkGeneric(filePath: string, lines: string[], language: string): CodeChunk[] {
        const chunks: CodeChunk[] = [];
        const step = this.MAX - this.OVERLAP;

        for (let s = 0; s < lines.length; s += step) {
            const e = Math.min(s + this.MAX, lines.length);
            const content = lines.slice(s, e).join('\n').trim();
            if (content.length > 20) {
                chunks.push({
                    filePath,
                    chunkType: 'block',
                    startLine: s + 1,
                    endLine: e,
                    content,
                    language,
                });
            }
            if (e >= lines.length) break;
        }

        return chunks;
    }

    /** Split a large block into overlapping sub-chunks. */
    private _splitLargeBlock(
        filePath: string, lines: string[],
        start: number, end: number,
        name: string, type: string, language: string,
    ): CodeChunk[] {
        const chunks: CodeChunk[] = [];
        const step = this.MAX - this.OVERLAP;
        let part = 1;

        for (let s = start; s <= end; s += step) {
            const e = Math.min(s + this.MAX, end + 1);
            const content = lines.slice(s, e).join('\n').trim();
            if (content.length > 20) {
                chunks.push({
                    filePath,
                    chunkType: type,
                    name: `${name} (part ${part++})`,
                    startLine: s + 1,
                    endLine: e,
                    content,
                    language,
                });
            }
            if (e > end) break;
        }

        return chunks;
    }
}

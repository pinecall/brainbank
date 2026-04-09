/**
 * BrainBank — Tree-Sitter Code Chunker
 * 
 * AST-aware code splitting using native tree-sitter bindings.
 * Extracts semantic blocks (functions, classes, methods, interfaces)
 * from the AST. Falls back to sliding window for unsupported languages.
 */

import { createRequire } from 'node:module';
import type { CodeChunk } from 'brainbank';
import { GRAMMARS, type LangGrammar } from './grammars.js';

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

    /** Lazy-init tree-sitter parser. Exposed for symbol extraction. */
    _ensureParser(): any {
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

    /** Get a cached grammar (already loaded). Returns null if not loaded. */
    getCachedGrammar(language: string): LangGrammar | null {
        return this._langCache.get(language) ?? null;
    }

    /** Load a language grammar (cached). Throws if grammar package is not installed. */
    private async _loadGrammar(language: string): Promise<LangGrammar | null> {
        if (this._langCache.has(language)) return this._langCache.get(language)!;

        const factory = GRAMMARS[language];
        if (!factory) return null; // Unknown language — no grammar registered

        const grammar = await factory(); // Throws if package not installed
        if (grammar) this._langCache.set(language, grammar);
        return grammar;
    }

    /**
     * Split file content into semantic chunks using tree-sitter AST.
     * Falls back to sliding window if grammar package is not installed
     * or language is unsupported.
     */
    async chunk(filePath: string, content: string, language: string): Promise<CodeChunk[]> {
        const lines = content.split('\n');

        // Always try tree-sitter AST chunking first — even for small files.
        // Function-level chunks are critical for call graph resolution.
        const parser = this._ensureParser();
        let langConfig: LangGrammar | null = null;

        try {
            langConfig = await this._loadGrammar(language);
        } catch {
            // Grammar package not installed — fall through
        }

        if (parser && langConfig) {
            try {
                parser.setLanguage(langConfig.grammar);
                const tree = parser.parse(content);
                const chunks = this._extractChunks(filePath, lines, tree.rootNode, langConfig, language);
                const valid = chunks.filter(c => c.content.length > 20);

                if (valid.length > 0) {
                    return valid;
                }
            } catch {
                // Tree-sitter parse failed — fall through
            }
        }

        // No AST blocks found or no parser available.
        // Small file → single file chunk (preserves old behavior for files with no top-level defs)
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

        // Large file without AST → sliding window
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

        // Large non-class → split with overlap (includes large data objects)
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
        const step = Math.max(this.MAX - this.OVERLAP, 1);

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
        const step = Math.max(this.MAX - this.OVERLAP, 1);
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

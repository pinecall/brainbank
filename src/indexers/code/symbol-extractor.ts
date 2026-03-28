/**
 * BrainBank — Symbol & Reference Extractor
 *
 * Extracts symbol definitions (functions, classes, methods) and
 * call references from a tree-sitter AST node.
 *
 * Used during indexing to populate code_symbols and code_refs tables,
 * enabling call-graph queries in the context builder.
 */

// ── Types ───────────────────────────────────────────

export interface SymbolDef {
    name: string;
    kind: 'function' | 'class' | 'method' | 'variable' | 'interface';
    line: number;
    filePath: string;
}

export interface CallRef {
    callerName: string;
    calleeName: string;
}

// ── Call expression node types per language ──────────

const CALL_NODES: Record<string, string[]> = {
    typescript:  ['call_expression', 'new_expression'],
    javascript:  ['call_expression', 'new_expression'],
    python:      ['call', 'decorator'],
    go:          ['call_expression'],
    ruby:        ['call', 'method_call'],
    rust:        ['call_expression', 'macro_invocation'],
    java:        ['method_invocation', 'object_creation_expression'],
    kotlin:      ['call_expression'],
    scala:       ['call_expression'],
    c:           ['call_expression'],
    cpp:         ['call_expression'],
    csharp:      ['invocation_expression', 'object_creation_expression'],
    php:         ['function_call_expression', 'method_call_expression'],
    elixir:      ['call'],
    lua:         ['function_call'],
    swift:       ['call_expression'],
    bash:        ['command'],
};

// ── Symbol extraction ───────────────────────────────

/** Extract all symbol definitions from a file's AST root. */
export function extractSymbols(rootNode: any, filePath: string, language: string): SymbolDef[] {
    const symbols: SymbolDef[] = [];
    _walkForSymbols(rootNode, filePath, language, symbols, null);
    return symbols;
}

function _walkForSymbols(
    node: any, filePath: string, language: string,
    symbols: SymbolDef[], parentClass: string | null,
): void {
    const type = node.type;

    // Classes
    if (_isClassNode(type, language)) {
        const name = _getNodeName(node);
        if (name && name !== 'anonymous') {
            symbols.push({ name, kind: 'class', line: node.startPosition.row + 1, filePath });
        }
        // Walk children for methods
        for (let i = 0; i < node.namedChildCount; i++) {
            _walkForSymbols(node.namedChild(i), filePath, language, symbols, name);
        }
        return;
    }

    // Functions / Methods
    if (_isFunctionNode(type, language)) {
        const name = _getNodeName(node);
        if (name && name !== 'anonymous') {
            const kind = parentClass ? 'method' : 'function';
            const fullName = parentClass ? `${parentClass}.${name}` : name;
            symbols.push({ name: fullName, kind, line: node.startPosition.row + 1, filePath });
        }
        return; // Don't recurse into function bodies for definitions
    }

    // Interfaces (TS/Go)
    if (_isInterfaceNode(type, language)) {
        const name = _getNodeName(node);
        if (name && name !== 'anonymous') {
            symbols.push({ name, kind: 'interface', line: node.startPosition.row + 1, filePath });
        }
    }

    // Decorated definitions (Python)
    if (type === 'decorated_definition') {
        for (let i = 0; i < node.namedChildCount; i++) {
            _walkForSymbols(node.namedChild(i), filePath, language, symbols, parentClass);
        }
        return;
    }

    // Export wrappers (JS/TS)
    if (type === 'export_statement') {
        for (let i = 0; i < node.namedChildCount; i++) {
            _walkForSymbols(node.namedChild(i), filePath, language, symbols, parentClass);
        }
        return;
    }

    // Generic: walk children
    for (let i = 0; i < node.namedChildCount; i++) {
        _walkForSymbols(node.namedChild(i), filePath, language, symbols, parentClass);
    }
}

// ── Call reference extraction ───────────────────────

/** Extract function/method call names from a chunk's AST subtree. */
export function extractCallRefs(node: any, language: string): string[] {
    const callNodeTypes = CALL_NODES[language] ?? [];
    if (callNodeTypes.length === 0) return [];

    const refs = new Set<string>();
    _walkForCalls(node, callNodeTypes, language, refs);
    return [...refs];
}

function _walkForCalls(
    node: any, callNodeTypes: string[], language: string, refs: Set<string>,
): void {
    if (callNodeTypes.includes(node.type)) {
        const name = _extractCallName(node, language);
        if (name && !_isBuiltin(name, language)) {
            refs.add(name);
        }
    }

    for (let i = 0; i < node.namedChildCount; i++) {
        _walkForCalls(node.namedChild(i), callNodeTypes, language, refs);
    }
}

/** Extract the function name from a call expression node. */
function _extractCallName(node: any, language: string): string | null {
    // Python: call node has a function child
    if (language === 'python') {
        const fn = node.childForFieldName('function');
        if (!fn) return null;
        if (fn.type === 'attribute') {
            const attr = fn.childForFieldName('attribute');
            return attr?.text ?? null;
        }
        return fn.text;
    }

    // JS/TS: call_expression.function
    if (language === 'typescript' || language === 'javascript') {
        const fn = node.childForFieldName('function');
        if (!fn) return null;
        // member_expression: obj.method() → "method"
        if (fn.type === 'member_expression') {
            const prop = fn.childForFieldName('property');
            return prop?.text ?? null;
        }
        return fn.text;
    }

    // Java: method_invocation.name
    if (language === 'java' || language === 'kotlin' || language === 'csharp') {
        const name = node.childForFieldName('name');
        return name?.text ?? null;
    }

    // Go: call_expression.function
    if (language === 'go') {
        const fn = node.childForFieldName('function');
        if (!fn) return null;
        if (fn.type === 'selector_expression') {
            const field = fn.childForFieldName('field');
            return field?.text ?? null;
        }
        return fn.text;
    }

    // Rust: call_expression.function
    if (language === 'rust') {
        const fn = node.childForFieldName('function');
        if (!fn) return null;
        if (fn.type === 'scoped_identifier') {
            const name = fn.childForFieldName('name');
            return name?.text ?? null;
        }
        return fn.text;
    }

    // Fallback: try the first named child's text
    if (node.namedChildCount > 0) {
        const first = node.namedChild(0);
        if (first.text.length < 50) return first.text;
    }
    return null;
}

// ── Helpers ─────────────────────────────────────────

function _isClassNode(type: string, _language: string): boolean {
    return [
        'class_declaration', 'class_definition', 'class_specifier',
        'struct_item', 'impl_item', 'struct_declaration',
        'trait_item', 'enum_declaration', 'enum_item',
    ].includes(type);
}

function _isFunctionNode(type: string, _language: string): boolean {
    return [
        'function_declaration', 'function_definition', 'method_definition',
        'method_declaration', 'function_item', 'arrow_function',
        'generator_function_declaration',
    ].includes(type);
}

function _isInterfaceNode(type: string, _language: string): boolean {
    return [
        'interface_declaration', 'type_alias_declaration',
    ].includes(type);
}

function _getNodeName(node: any): string {
    // Try 'name' field first
    const nameNode = node.childForFieldName('name');
    if (nameNode) return nameNode.text;

    // Variable declarators
    if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
        for (let i = 0; i < node.namedChildCount; i++) {
            const child = node.namedChild(i);
            if (child.type === 'variable_declarator') {
                const n = child.childForFieldName('name');
                if (n) return n.text;
            }
        }
    }
    return 'anonymous';
}

/** Filter out common builtins that aren't useful as call references. */
function _isBuiltin(name: string, language: string): boolean {
    const GLOBAL_BUILTINS = new Set([
        'print', 'println', 'printf', 'console', 'log',
        'len', 'str', 'int', 'float', 'bool', 'list', 'dict', 'set', 'tuple',
        'map', 'filter', 'range', 'enumerate', 'zip', 'sorted', 'reversed',
        'type', 'isinstance', 'issubclass', 'hasattr', 'getattr', 'setattr',
        'super', 'self', 'this', 'new', 'delete',
        'require', 'import', 'export', 'module',
        'toString', 'valueOf', 'constructor',
        'push', 'pop', 'shift', 'unshift', 'splice', 'slice',
        'join', 'split', 'replace', 'trim', 'match', 'test',
        'keys', 'values', 'entries', 'forEach', 'find', 'some', 'every',
        'then', 'catch', 'finally', 'resolve', 'reject',
        'append', 'extend', 'insert', 'remove', 'get', 'update',
    ]);

    return GLOBAL_BUILTINS.has(name) || name.length <= 1;
}

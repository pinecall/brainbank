/**
 * Unit Tests — Symbol & Reference Extractor
 *
 * Tests AST-based symbol definition and call reference extraction.
 * Uses tree-sitter for parsing, matching the code-chunker pattern.
 */

import { createRequire } from 'node:module';
import { extractSymbols, extractCallRefs } from '../../../src/indexers/code/symbol-extractor.ts';

const require = createRequire(import.meta.url);

export const name = 'Symbol & Reference Extractor';

function parse(code: string, grammar: any): any {
    const Parser = require('tree-sitter');
    const parser = new Parser();
    parser.setLanguage(grammar);
    return parser.parse(code);
}

export const tests = {
    'extracts TypeScript function symbols'(assert: any) {
        const ts = require('tree-sitter-typescript').typescript;
        const code = `
export function greet(name: string): string {
    return "hello " + name;
}

function helper() {
    return 42;
}
`;
        const tree = parse(code, ts);
        const symbols = extractSymbols(tree.rootNode, 'test.ts', 'typescript');

        assert.gte(symbols.length, 2, 'should find at least 2 functions');
        const names = symbols.map(s => s.name);
        assert.ok(names.includes('greet'), 'should find greet');
        assert.ok(names.includes('helper'), 'should find helper');

        const greet = symbols.find(s => s.name === 'greet')!;
        assert.equal(greet.kind, 'function');
        assert.equal(greet.filePath, 'test.ts');
    },

    'extracts TypeScript class and methods'(assert: any) {
        const ts = require('tree-sitter-typescript').typescript;
        const code = `
export class UserService {
    async findAll() {
        return this.db.query('SELECT *');
    }

    async findById(id: string) {
        return this.db.query('SELECT * WHERE id = ?', [id]);
    }
}
`;
        const tree = parse(code, ts);
        const symbols = extractSymbols(tree.rootNode, 'service.ts', 'typescript');

        const classSymbol = symbols.find(s => s.kind === 'class');
        assert.ok(classSymbol, 'should find class');
        assert.equal(classSymbol!.name, 'UserService');

        const methods = symbols.filter(s => s.kind === 'method');
        assert.gte(methods.length, 2, 'should find at least 2 methods');

        const methodNames = methods.map(s => s.name);
        assert.ok(methodNames.some(n => n.includes('findAll')), 'should have findAll');
        assert.ok(methodNames.some(n => n.includes('findById')), 'should have findById');
    },

    'extracts TypeScript interface'(assert: any) {
        const ts = require('tree-sitter-typescript').typescript;
        const code = `
export interface Config {
    port: number;
    host: string;
    debug: boolean;
}
`;
        const tree = parse(code, ts);
        const symbols = extractSymbols(tree.rootNode, 'types.ts', 'typescript');

        const iface = symbols.find(s => s.kind === 'interface');
        assert.ok(iface, 'should find interface');
        assert.equal(iface!.name, 'Config');
    },

    'extracts Python functions and classes'(assert: any) {
        const py = require('tree-sitter-python');
        const code = `
class Calculator:
    def __init__(self):
        self.result = 0

    def add(self, x, y):
        self.result = x + y
        return self.result

def standalone():
    return 42
`;
        const tree = parse(code, py);
        const symbols = extractSymbols(tree.rootNode, 'calc.py', 'python');

        const classSymbol = symbols.find(s => s.kind === 'class');
        assert.ok(classSymbol, 'should find class');
        assert.equal(classSymbol!.name, 'Calculator');

        const methods = symbols.filter(s => s.kind === 'method');
        assert.gte(methods.length, 2, 'should find at least 2 methods');

        const funcs = symbols.filter(s => s.kind === 'function');
        assert.ok(funcs.some(f => f.name === 'standalone'), 'should find standalone');
    },

    'extracts TypeScript call references'(assert: any) {
        const ts = require('tree-sitter-typescript').typescript;
        const code = `
function processData() {
    const result = fetchData();
    const parsed = parseResult(result);
    notifyUser(parsed);
    return parsed;
}
`;
        const tree = parse(code, ts);
        const refs = extractCallRefs(tree.rootNode, 'typescript');

        assert.includes(refs, 'fetchData');
        assert.includes(refs, 'parseResult');
        assert.includes(refs, 'notifyUser');
    },

    'extracts Python call references'(assert: any) {
        const py = require('tree-sitter-python');
        const code = `
def handle_request(session):
    config = load_config()
    result = process_data(session)
    session.emit("done", result)
    return result
`;
        const tree = parse(code, py);
        const refs = extractCallRefs(tree.rootNode, 'python');

        assert.includes(refs, 'load_config');
        assert.includes(refs, 'process_data');
        assert.includes(refs, 'emit');
    },

    'filters out builtin calls'(assert: any) {
        const ts = require('tree-sitter-typescript').typescript;
        const code = `
function example() {
    const items = [1, 2, 3];
    items.push(4);
    items.forEach(x => x);
    const mapped = items.map(x => x * 2);
    customFunction();
}
`;
        const tree = parse(code, ts);
        const refs = extractCallRefs(tree.rootNode, 'typescript');

        // Builtins should be filtered out
        assert.ok(!refs.includes('push'), 'should filter push');
        assert.ok(!refs.includes('forEach'), 'should filter forEach');
        assert.ok(!refs.includes('map'), 'should filter map');
        // Custom function should remain
        assert.includes(refs, 'customFunction');
    },

    'returns empty for no calls'(assert: any) {
        const ts = require('tree-sitter-typescript').typescript;
        const code = `
const x = 42;
const y = "hello";
`;
        const tree = parse(code, ts);
        const refs = extractCallRefs(tree.rootNode, 'typescript');
        assert.equal(refs.length, 0);
    },

    'returns empty for unsupported language'(assert: any) {
        const ts = require('tree-sitter-typescript').typescript;
        const code = `console.log("hello")`;
        const tree = parse(code, ts);
        // Pass a language we don't have call patterns for
        const refs = extractCallRefs(tree.rootNode, 'haskell');
        assert.equal(refs.length, 0);
    },
};

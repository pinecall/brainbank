/**
 * Unit Tests — BrainBankQL Context Fields (Code Formatter)
 *
 * Tests the context field implementations in code-context-formatter:
 * - `lines`: line number annotations
 * - `callTree`: toggle + depth
 * - `imports`: toggle
 * - `symbols`: symbol index
 * - `compact`: signatures only
 */

import { formatCodeContext } from '../../src/code-context-formatter.ts';
import type { SearchResult } from 'brainbank';
import type { CodeGraphProvider, CallTreeNode, SymbolInfo } from '../../src/sql-code-graph.ts';

export const name = 'BrainBankQL Context Fields';

/** Build a minimal code search result. */
function codeResult(opts: {
    filePath: string;
    content: string;
    name?: string;
    startLine?: number;
    endLine?: number;
    score?: number;
    language?: string;
}): SearchResult {
    return {
        type: 'code',
        score: opts.score ?? 0.9,
        filePath: opts.filePath,
        content: opts.content,
        metadata: {
            id: 1,
            chunkType: 'function',
            name: opts.name ?? 'testFunc',
            startLine: opts.startLine ?? 1,
            endLine: opts.endLine ?? 10,
            language: opts.language ?? 'typescript',
            filePath: opts.filePath,
        },
    };
}

/** Stub graph provider — no call tree, no imports. */
function stubGraph(opts?: {
    callTree?: CallTreeNode[];
    symbols?: SymbolInfo[];
}): CodeGraphProvider {
    return {
        getCallInfo: () => null,
        expandImportGraph: () => new Set<string>(),
        buildDependencyGraph: () => ({ nodes: [], edges: [] }),
        fetchBestChunks: () => [],
        fetchCalledChunks: () => [],
        buildCallTree: () => opts?.callTree ?? [],
        fetchAdjacentParts: () => [],
        fetchSymbolsForFiles: (fps: string[]) => opts?.symbols ?? [],
    } as unknown as CodeGraphProvider;
}

export const tests = {
    'lines=false: no line numbers in output'(assert: any) {
        const hits = [codeResult({
            filePath: 'src/auth.ts',
            content: 'export function login() {\n  return true;\n}',
            startLine: 10,
            endLine: 12,
        })];
        const parts: string[] = [];
        formatCodeContext(hits, parts, stubGraph(), undefined, { lines: false });

        const output = parts.join('\n');
        assert.ok(!output.includes('10|'), 'should NOT contain line numbers');
        assert.ok(output.includes('export function login()'), 'should contain raw code');
    },

    'lines=true: prefixes each line with source line number'(assert: any) {
        const hits = [codeResult({
            filePath: 'src/auth.ts',
            content: 'export function login() {\n  return true;\n}',
            startLine: 10,
            endLine: 12,
        })];
        const parts: string[] = [];
        formatCodeContext(hits, parts, stubGraph(), undefined, { lines: true });

        const output = parts.join('\n');
        assert.ok(output.includes('10| export function login()'), 'line 10 should have number prefix');
        assert.ok(output.includes('11|   return true;'), 'line 11 should have number prefix');
        assert.ok(output.includes('12| }'), 'line 12 should have number prefix');
    },

    'lines=true: pads line numbers for alignment'(assert: any) {
        const lines = Array.from({ length: 5 }, (_, i) => `  line${i}`);
        const hits = [codeResult({
            filePath: 'src/big.ts',
            content: lines.join('\n'),
            startLine: 98,
            endLine: 102,
        })];
        const parts: string[] = [];
        formatCodeContext(hits, parts, stubGraph(), undefined, { lines: true });

        const output = parts.join('\n');
        // 3-digit numbers should be padded
        assert.ok(output.includes(' 98|'), 'should pad 98 to align with 3-digit numbers');
        assert.ok(output.includes('100|'), 'should show 100 without extra padding');
    },

    'callTree=false: no call tree nodes in output'(assert: any) {
        const callTreeNodes: CallTreeNode[] = [{
            chunkId: 99,
            filePath: 'src/helper.ts',
            name: 'helperFunc',
            chunkType: 'function',
            startLine: 1,
            endLine: 5,
            language: 'typescript',
            content: 'function helperFunc() { return 42; }',
            symbolName: 'helperFunc',
            callerName: 'testFunc',
            depth: 1,
            children: [],
        }];

        const hits = [codeResult({ filePath: 'src/main.ts', content: 'main code' })];
        const parts: string[] = [];
        formatCodeContext(hits, parts, stubGraph({ callTree: callTreeNodes }), undefined, { callTree: false });

        const output = parts.join('\n');
        assert.ok(!output.includes('helperFunc'), 'should NOT include call tree callee');
    },

    'callTree=true (default): includes call tree nodes'(assert: any) {
        const callTreeNodes: CallTreeNode[] = [{
            chunkId: 99,
            filePath: 'src/helper.ts',
            name: 'helperFunc',
            chunkType: 'function',
            startLine: 1,
            endLine: 5,
            language: 'typescript',
            content: 'function helperFunc() {\n  return 42;\n  // extra\n  // extra\n}',
            symbolName: 'helperFunc',
            callerName: 'testFunc',
            depth: 1,
            children: [],
        }];

        const hits = [codeResult({ filePath: 'src/main.ts', content: 'main code' })];
        const parts: string[] = [];
        formatCodeContext(hits, parts, stubGraph({ callTree: callTreeNodes }), undefined, { callTree: true });

        const output = parts.join('\n');
        assert.ok(output.includes('helperFunc'), 'should include call tree callee');
        assert.ok(output.includes('called by'), 'should show "called by" annotation');
    },

    'imports=false: skips dependency summary'(assert: any) {
        const hits = [codeResult({ filePath: 'src/main.ts', content: 'code' })];
        const parts: string[] = [];
        formatCodeContext(hits, parts, stubGraph(), undefined, { imports: false });

        const output = parts.join('\n');
        assert.ok(!output.includes('Dependencies'), 'should NOT include dependency summary');
        assert.ok(!output.includes('Dependents'), 'should NOT include dependents');
    },

    'symbols=true: renders symbol index section'(assert: any) {
        const symbols: SymbolInfo[] = [
            { filePath: 'src/auth.ts', name: 'AuthService', kind: 'class', line: 15 },
            { filePath: 'src/auth.ts', name: 'AuthService.login', kind: 'method', line: 20 },
            { filePath: 'src/auth.ts', name: 'AuthService.logout', kind: 'method', line: 45 },
            { filePath: 'src/auth.ts', name: 'AuthOptions', kind: 'interface', line: 5 },
        ];

        const hits = [codeResult({ filePath: 'src/auth.ts', content: 'code' })];
        const parts: string[] = [];
        formatCodeContext(hits, parts, stubGraph({ symbols }), undefined, { symbols: true });

        const output = parts.join('\n');
        assert.ok(output.includes('## Symbol Index'), 'should include Symbol Index header');
        assert.ok(output.includes('class AuthService (L15)'), 'should list class with line');
        assert.ok(output.includes('method AuthService.login (L20)'), 'should list method');
        assert.ok(output.includes('interface AuthOptions (L5)'), 'should list interface');
    },

    'symbols=false (default): no symbol index'(assert: any) {
        const symbols: SymbolInfo[] = [
            { filePath: 'src/auth.ts', name: 'AuthService', kind: 'class', line: 15 },
        ];

        const hits = [codeResult({ filePath: 'src/auth.ts', content: 'code' })];
        const parts: string[] = [];
        formatCodeContext(hits, parts, stubGraph({ symbols }), undefined, { symbols: false });

        const output = parts.join('\n');
        assert.ok(!output.includes('Symbol Index'), 'should NOT include Symbol Index');
    },

    'compact=true: shows signatures for non-search-hit chunks'(assert: any) {
        const callTreeNodes: CallTreeNode[] = [{
            chunkId: 99,
            filePath: 'src/service.ts',
            name: 'processData',
            chunkType: 'function',
            startLine: 10,
            endLine: 50,
            language: 'typescript',
            content: 'export async function processData(input: string): Promise<Result> {\n  const step1 = parse(input);\n  const step2 = validate(step1);\n  return transform(step2);\n}',
            symbolName: 'processData',
            callerName: 'testFunc',
            depth: 1,
            children: [],
        }];

        const hits = [codeResult({ filePath: 'src/main.ts', content: 'main code' })];
        const parts: string[] = [];
        formatCodeContext(hits, parts, stubGraph({ callTree: callTreeNodes }), undefined, { compact: true });

        const output = parts.join('\n');
        // Compact mode should show signature as one-liner, not the full body
        assert.ok(output.includes('processData'), 'should mention the function');
        // The full body should NOT be in a code block for non-hit chunks
        assert.ok(!output.includes('const step1 = parse(input)'), 'should NOT show full body for call tree chunk');
    },

    'default fields: callTree and imports enabled, lines/symbols/compact disabled'(assert: any) {
        const hits = [codeResult({ filePath: 'src/main.ts', content: 'code' })];
        const parts: string[] = [];
        // Empty fields = all defaults
        formatCodeContext(hits, parts, stubGraph(), undefined, {});

        const output = parts.join('\n');
        assert.ok(output.includes('## Code Context'), 'should include code section');
        assert.ok(!output.includes('Symbol Index'), 'symbols should be off by default');
    },

    'fields combine: lines + symbols together'(assert: any) {
        const symbols: SymbolInfo[] = [
            { filePath: 'src/auth.ts', name: 'login', kind: 'function', line: 10 },
        ];

        const hits = [codeResult({
            filePath: 'src/auth.ts',
            content: 'export function login() {\n  return true;\n}',
            startLine: 10,
            endLine: 12,
        })];
        const parts: string[] = [];
        formatCodeContext(hits, parts, stubGraph({ symbols }), undefined, { lines: true, symbols: true });

        const output = parts.join('\n');
        assert.ok(output.includes('10| export function login()'), 'should have line numbers');
        assert.ok(output.includes('## Symbol Index'), 'should have symbol index');
        assert.ok(output.includes('function login (L10)'), 'should list symbol');
    },
};

/**
 * Unit Tests — Code Chunker
 */

import { CodeChunker } from '../../src/indexers/chunker.ts';

export const name = 'Code Chunker';

const chunker = new CodeChunker({ maxLines: 20, minLines: 2 });

export const tests = {
    'small file becomes single chunk'(assert: any) {
        const content = 'const x = 1;\nconst y = 2;\nexport { x, y };';
        const chunks = chunker.chunk('src/small.ts', content, 'typescript');
        assert.equal(chunks.length, 1);
        assert.equal(chunks[0].chunkType, 'file');
        assert.equal(chunks[0].startLine, 1);
        assert.includes(chunks[0].content, 'const x = 1');
    },

    'detects TypeScript functions'(assert: any) {
        const lines: string[] = [];
        // Must exceed maxLines (20) to trigger multi-chunk detection
        lines.push('import path from "path";');
        lines.push('');
        lines.push('export function greet(name: string): string {');
        for (let i = 0; i < 8; i++) lines.push(`  console.log("line ${i}");`);
        lines.push('  return "hello";');
        lines.push('}');
        lines.push('');
        lines.push('function helper() {');
        for (let i = 0; i < 8; i++) lines.push(`  console.log("helper ${i}");`);
        lines.push('  return true;');
        lines.push('}');
        lines.push('');
        // Padding to push total well beyond maxLines
        for (let i = 0; i < 5; i++) lines.push(`const padding${i} = ${i};`);

        const content = lines.join('\n');
        const chunks = chunker.chunk('src/funcs.ts', content, 'typescript');

        assert.gt(chunks.length, 0, 'should detect at least one function');
        const names = chunks.map(c => c.name).filter(Boolean);
        assert.includes(names, 'greet', 'should detect greet');
        assert.includes(names, 'helper', 'should detect helper');
    },

    'detects TypeScript class'(assert: any) {
        const lines = [
            'export class MyAgent {',
            '  private name: string;',
            '',
            '  constructor(name: string) {',
            '    this.name = name;',
            '  }',
            '',
            '  run(): void {',
            '    console.log("running");',
            '    console.log("more");',
            '  }',
            '}',
            '',
            '// more padding lines...',
            'const unused = true;',
            'const unused2 = false;',
            'const unused3 = null;',
            'const unused4 = 0;',
            'const unused5 = "";',
            'const unused6 = [];',
            'const unused7 = {};',
        ];
        const chunks = chunker.chunk('src/agent.ts', lines.join('\n'), 'typescript');
        const classChunk = chunks.find(c => c.name === 'MyAgent');
        assert.ok(classChunk, 'should detect MyAgent class');
        assert.equal(classChunk!.chunkType, 'class');
    },

    'detects Python functions'(assert: any) {
        const lines = Array(25).fill(null).map((_, i) => {
            if (i === 0) return 'def greet(name):';
            if (i < 6) return '    print(f"Hello {name}")';
            if (i === 7) return '';
            if (i === 8) return 'def farewell(name):';
            if (i < 14) return '    print(f"Bye {name}")';
            return `# comment line ${i}`;
        });
        const chunks = chunker.chunk('src/greet.py', lines.join('\n'), 'python');
        const names = chunks.map(c => c.name).filter(Boolean);
        assert.includes(names, 'greet');
        assert.includes(names, 'farewell');
    },

    'generic fallback for unknown language uses sliding window'(assert: any) {
        const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
        const chunks = chunker.chunk('data.toml', lines.join('\n'), 'toml');
        assert.gt(chunks.length, 0, 'should produce at least one chunk');
        assert.equal(chunks[0].chunkType, 'block');
    },

    'chunk preserves file path and language'(assert: any) {
        const chunks = chunker.chunk('lib/utils.js', 'const x = 1;', 'javascript');
        assert.equal(chunks[0].filePath, 'lib/utils.js');
        assert.equal(chunks[0].language, 'javascript');
    },

    'empty content still produces a chunk with short content'(assert: any) {
        const chunks = chunker.chunk('empty.ts', '', 'typescript');
        // Empty or minimal content → single file chunk
        assert.equal(chunks.length, 1);
    },
};

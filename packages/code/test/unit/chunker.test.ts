/**
 * Unit Tests — Tree-Sitter Code Chunker
 * 
 * Tests AST-aware chunking: function detection, class method extraction,
 * decorator handling, large file splitting, and fallback behavior.
 */

import { CodeChunker } from '../../src/code-chunker.ts';

export const name = 'Tree-Sitter Code Chunker';

function makeChunker(maxLines = 80) {
    return new CodeChunker({ maxLines, minLines: 3, overlap: 5 });
}

export const tests = {
    async 'small file returns single chunk'(assert: any) {
        const chunker = makeChunker();
        const code = `export function hello() {\n  return 'world';\n}\n`;
        const chunks = await chunker.chunk('test.ts', code, 'typescript');
        assert.equal(chunks.length, 1);
        assert.equal(chunks[0].chunkType, 'file');
        assert.equal(chunks[0].startLine, 1);
    },

    async 'detects exported function'(assert: any) {
        const chunker = makeChunker(10);
        const lines = [];
        lines.push('import { Foo } from "./foo";');
        lines.push('');
        lines.push('export function hello(name: string): string {');
        for (let i = 0; i < 8; i++) lines.push(`  const x${i} = ${i};`);
        lines.push('  return name;');
        lines.push('}');
        lines.push('');
        lines.push('export function goodbye() {');
        for (let i = 0; i < 5; i++) lines.push(`  const y${i} = ${i};`);
        lines.push('  return "bye";');
        lines.push('}');

        const code = lines.join('\n');
        const chunks = await chunker.chunk('test.ts', code, 'typescript');
        
        const funcChunks = chunks.filter(c => c.chunkType === 'function' || c.chunkType === 'method');
        assert.gte(funcChunks.length, 2, 'should detect at least 2 functions');
        
        const names = funcChunks.map(c => c.name);
        assert.ok(names.some(n => n!.includes('hello')), 'should have hello');
        assert.ok(names.some(n => n!.includes('goodbye')), 'should have goodbye');
    },

    async 'detects class with methods'(assert: any) {
        const chunker = makeChunker(8);
        const code = `import { Injectable } from '@nestjs/common';

export class UserService {
    constructor(private readonly db: any) {
        this.db = db;
        console.log('init');
    }

    async findAll() {
        const users = await this.db.query('SELECT * FROM users');
        return users.map(u => u.name);
        // extra line
    }

    async findById(id: string) {
        const user = await this.db.query('SELECT * FROM users WHERE id = ?', [id]);
        if (!user) throw new Error('Not found');
        return user;
    }

    async create(data: any) {
        return this.db.query('INSERT INTO users SET ?', data);
    }
}`;

        const chunks = await chunker.chunk('user.service.ts', code, 'typescript');
        
        const methods = chunks.filter(c => c.chunkType === 'method');
        assert.gte(methods.length, 3, 'should detect at least 3 methods');
        
        const methodNames = methods.map(c => c.name);
        assert.ok(methodNames.some(n => n!.includes('findAll')), 'should have findAll');
        assert.ok(methodNames.some(n => n!.includes('findById')), 'should have findById');
        assert.ok(methodNames.some(n => n!.includes('create')), 'should have create');
    },

    async 'detects decorated class (NestJS @Module)'(assert: any) {
        const chunker = makeChunker(5);
        const code = `import { Module } from '@nestjs/common';

@Module({
    imports: [ConfigModule],
    providers: [AuthService, JwtStrategy],
    controllers: [AuthController],
    exports: [AuthService],
})
export class AuthModule {}

export function standalone() {
    return 'hello';
    // line 2
    // line 3
}`;

        const chunks = await chunker.chunk('auth.module.ts', code, 'typescript');
        
        const classChunks = chunks.filter(c => c.chunkType === 'class');
        assert.gte(classChunks.length, 1, 'should detect AuthModule class');
        const firstClass = classChunks[0];
        assert.ok(firstClass && firstClass.name?.includes('AuthModule'), 'name should be AuthModule');
    },

    async 'detects TypeScript interface and type'(assert: any) {
        const chunker = makeChunker(5);
        const code = `import { Entity } from 'typeorm';

export interface UserProfile {
    id: string;
    name: string;
    email: string;
    role: 'admin' | 'user';
    createdAt: Date;
}

export type JobStatus = 'pending' | 'active' | 'completed';

export function doSomething() {
    return true;
    // line
    // line
}`;

        const chunks = await chunker.chunk('types.ts', code, 'typescript');
        
        const interfaces = chunks.filter(c => c.chunkType === 'interface');
        assert.gte(interfaces.length, 1, 'should detect interface');
        const firstInterface = interfaces[0];
        assert.ok(firstInterface && firstInterface.name?.includes('UserProfile'), 'should be UserProfile');
    },

    async 'Python: detects functions and classes'(assert: any) {
        const chunker = makeChunker(5);
        const code = `import os

class Calculator:
    def __init__(self):
        self.result = 0
        self.history = []

    def add(self, x, y):
        self.result = x + y
        self.history.append(self.result)
        return self.result

    def subtract(self, x, y):
        self.result = x - y
        return self.result

def standalone_func():
    return 42
    # extra line
    # extra line
`;

        const chunks = await chunker.chunk('calc.py', code, 'python');
        assert.gt(chunks.length, 1, 'should produce multiple chunks');
        
        const methods = chunks.filter(c => c.chunkType === 'method');
        const functions = chunks.filter(c => c.chunkType === 'function');
        assert.gte(methods.length + functions.length, 1, 'should detect methods/functions');
    },

    async 'unsupported language falls back to sliding window'(assert: any) {
        const chunker = makeChunker(10);
        const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
        const code = lines.join('\n');

        const chunks = await chunker.chunk('data.yaml', code, 'yaml');
        
        assert.gt(chunks.length, 0, 'should produce chunks');
        assert.equal(chunks[0].chunkType, 'block', 'should be generic block type');
    },

    async 'large method gets split with overlap'(assert: any) {
        const chunker = makeChunker(10);
        const methodLines = [];
        methodLines.push('export class BigService {');
        methodLines.push('    async processData() {');
        for (let i = 0; i < 25; i++) {
            methodLines.push(`        const step${i} = await doStep(${i});`);
        }
        methodLines.push('        return result;');
        methodLines.push('    }');
        methodLines.push('}');

        const code = methodLines.join('\n');
        const chunks = await chunker.chunk('big.ts', code, 'typescript');
        
        const parts = chunks.filter(c => c.name?.includes('part'));
        assert.gt(parts.length, 1, 'large method should be split into parts');
    },
};

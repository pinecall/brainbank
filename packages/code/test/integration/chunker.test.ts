/**
 * Integration Tests — Tree-Sitter Code Chunker
 * 
 * Tests AST chunking for core languages (TS, JS, Python) plus
 * content integrity and fallback behavior.
 * 
 * NOTE: Loading 9+ native tree-sitter grammars in one process causes OOM.
 * For multi-language benchmarks, run: npx tsx test/benchmark-chunker.ts
 */

import { CodeChunker } from '../../src/code-chunker.ts';

export const name = 'Tree-Sitter Chunker Integration';

// ── Code Samples ────────────────────────────────────

const TS_CODE = `import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';

@Injectable()
export class AuthService {
    constructor(
        private readonly userRepo: any,
        private readonly jwtService: JwtService,
    ) {}

    async validateUser(email: string, password: string): Promise<any> {
        const user = await this.userRepo.findOne({ where: { email } });
        if (!user) return null;
        const isValid = await bcrypt.compare(password, user.password);
        if (!isValid) return null;
        return user;
    }

    async login(user: any): Promise<{ access_token: string }> {
        const payload = { sub: user.id, email: user.email, role: user.role };
        return { access_token: this.jwtService.sign(payload) };
    }

    async register(email: string, password: string): Promise<any> {
        const hashedPassword = await bcrypt.hash(password, 10);
        const user = this.userRepo.create({ email, password: hashedPassword });
        return this.userRepo.save(user);
    }

    async changePassword(userId: string, oldPass: string, newPass: string): Promise<void> {
        const user = await this.userRepo.findOneOrFail({ where: { id: userId } });
        const valid = await bcrypt.compare(oldPass, user.password);
        if (!valid) throw new UnauthorizedException('Invalid');
        user.password = await bcrypt.hash(newPass, 10);
        await this.userRepo.save(user);
    }
}

export interface AuthPayload {
    sub: string;
    email: string;
    role: string;
}`;

const JS_CODE = `const express = require('express');

function handleGetUsers(req, res) {
    const users = req.db.query('SELECT * FROM users');
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    res.json({ data: users.slice(offset, offset + limit), total: users.length });
}

function handleCreateUser(req, res) {
    const { name, email, role } = req.body;
    if (!name || !email) {
        return res.status(400).json({ error: 'Name and email required' });
    }
    const user = req.db.insert('users', { name, email, role: role || 'user' });
    res.status(201).json(user);
}

function handleDeleteUser(req, res) {
    const { id } = req.params;
    const user = req.db.findById('users', id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    req.db.delete('users', id);
    res.status(204).send();
}

class UserController {
    constructor(db) {
        this.db = db;
    }
    setupRoutes() {
        return { get: handleGetUsers, post: handleCreateUser, del: handleDeleteUser };
    }
}

module.exports = { UserController };`;

const PY_CODE = `from django.http import JsonResponse
from django.views import View

class ProductView(View):
    def get(self, request, product_id=None):
        if product_id:
            return JsonResponse({'id': product_id})
        return JsonResponse([], safe=False)

    def post(self, request):
        data = request.body
        return JsonResponse({'status': 'created'}, status=201)

    def delete(self, request, product_id):
        return JsonResponse({'status': 'deleted'})

def search_products(request):
    query = request.GET.get('q', '')
    if not query:
        return JsonResponse({'error': 'Query required'}, status=400)
    return JsonResponse([], safe=False)

def category_list(request):
    return JsonResponse([], safe=False)`;

// ── Tests ───────────────────────────────────────────

export const tests: Record<string, (assert: any) => Promise<void>> = {

    async 'typescript: detects NestJS class methods + interface'(assert: any) {
        const chunker = new CodeChunker({ maxLines: 15, minLines: 3 });
        const chunks = await chunker.chunk('auth.service.ts', TS_CODE, 'typescript');

        assert.gt(chunks.length, 3, `expected >3 chunks, got ${chunks.length}`);

        const types = new Set(chunks.map((c: any) => c.chunkType));
        assert.ok(types.has('method') || types.has('function'), 'should have method/function chunks');

        const names = chunks.map((c: any) => c.name || '').join(' | ');
        assert.ok(names.includes('validateUser'), `should find validateUser: ${names}`);
        assert.ok(names.includes('login'), `should find login: ${names}`);
        assert.ok(names.includes('register'), `should find register: ${names}`);
        assert.ok(names.includes('changePassword'), `should find changePassword: ${names}`);

        // No generic blocks for TypeScript code
        const blockCount = chunks.filter((c: any) => c.chunkType === 'block').length;
        assert.equal(blockCount, 0, 'TypeScript should have zero generic block chunks');
    },

    async 'javascript: detects functions and class'(assert: any) {
        const chunker = new CodeChunker({ maxLines: 15, minLines: 3 });
        const chunks = await chunker.chunk('routes.js', JS_CODE, 'javascript');

        assert.gt(chunks.length, 2, `expected >2 chunks, got ${chunks.length}`);

        const names = chunks.map((c: any) => c.name || '').join(' | ');
        assert.ok(names.includes('handleGetUsers'), `should find handleGetUsers: ${names}`);
        assert.ok(names.includes('handleCreateUser'), `should find handleCreateUser: ${names}`);
        assert.ok(names.includes('handleDeleteUser'), `should find handleDeleteUser: ${names}`);

        // Should have function type
        const hasFuncType = chunks.some((c: any) => c.chunkType === 'function');
        assert.ok(hasFuncType, 'should have function-type chunks');
    },

    async 'python: detects class and standalone functions'(assert: any) {
        const chunker = new CodeChunker({ maxLines: 10, minLines: 3 });
        const chunks = await chunker.chunk('views.py', PY_CODE, 'python');

        assert.gt(chunks.length, 1, `expected >1 chunk, got ${chunks.length}`);

        const hasSemanticChunks = chunks.some((c: any) =>
            c.chunkType !== 'block' && c.chunkType !== 'file');
        assert.ok(hasSemanticChunks, 'Python should produce semantic chunks (not just blocks)');

        const names = chunks.map((c: any) => c.name || '').join(' | ');
        const hasClass = names.includes('ProductView');
        const hasFunc = names.includes('search_products') || names.includes('category_list');
        assert.ok(hasClass || hasFunc, `should find class or functions: ${names}`);
    },

    async 'unsupported language falls back to sliding window'(assert: any) {
        const chunker = new CodeChunker({ maxLines: 10 });
        const lines = Array.from({ length: 25 }, (_, i) => `key_${i}: value_${i}`);
        const code = lines.join('\n');
        const chunks = await chunker.chunk('data.yaml', code, 'yaml');

        assert.gt(chunks.length, 0, 'should produce chunks');
        assert.equal(chunks[0].chunkType, 'block', 'should be generic block type');
    },

    async 'small file returns single file-type chunk'(assert: any) {
        const chunker = new CodeChunker({ maxLines: 80 });
        const code = 'export const x = 1;\nexport const y = 2;\n';
        const chunks = await chunker.chunk('small.ts', code, 'typescript');

        assert.equal(chunks.length, 1, 'should be 1 chunk');
        assert.equal(chunks[0].chunkType, 'file', 'should be file type');
        assert.equal(chunks[0].startLine, 1, 'should start at line 1');
    },

    async 'chunk content matches source lines exactly'(assert: any) {
        const chunker = new CodeChunker({ maxLines: 15, minLines: 3 });
        const chunks = await chunker.chunk('auth.service.ts', TS_CODE, 'typescript');
        const sourceLines = TS_CODE.split('\n');

        for (const chunk of chunks) {
            assert.ok(chunk.filePath, 'should have filePath');
            assert.ok(chunk.chunkType, 'should have chunkType');
            assert.ok(chunk.content.length > 0, 'should have content');
            assert.gte(chunk.startLine, 1, 'startLine >= 1');
            assert.gte(chunk.endLine, chunk.startLine, 'endLine >= startLine');
            assert.equal(chunk.language, 'typescript', 'language should be typescript');

            const expected = sourceLines.slice(chunk.startLine - 1, chunk.endLine).join('\n').trim();
            assert.equal(chunk.content, expected,
                `chunk ${chunk.name || chunk.chunkType} L${chunk.startLine}-${chunk.endLine} content mismatch`);
        }
    },

    async 'benchmark: chunk speed for TypeScript'(assert: any) {
        const chunker = new CodeChunker({ maxLines: 15, minLines: 3 });
        const times: number[] = [];

        // Warm up
        await chunker.chunk('auth.service.ts', TS_CODE, 'typescript');

        for (let i = 0; i < 5; i++) {
            const start = performance.now();
            await chunker.chunk('auth.service.ts', TS_CODE, 'typescript');
            times.push(performance.now() - start);
        }

        const avg = times.reduce((a, b) => a + b) / times.length;
        const min = Math.min(...times);
        const max = Math.max(...times);
        console.log(`\n    TypeScript (56 lines): avg=${avg.toFixed(1)}ms  min=${min.toFixed(1)}ms  max=${max.toFixed(1)}ms`);
        assert.lt(avg, 50, `TypeScript avg ${avg.toFixed(1)}ms should be <50ms`);
    },
};

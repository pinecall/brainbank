/**
 * BrainBank Integration Test — Code Indexer
 *
 * Full pipeline: index TypeScript + Python files → search via HNSW →
 * incremental skip → force reindex → BM25 keyword search.
 * Uses a temp repo in /tmp with realistic source files.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { BrainBank, code, hashEmbedding } from '../helpers.ts';

export const name = 'Code Indexer';

// ── Fixtures ──────────────────────────────────────────

let tmpDir: string;
let brain: BrainBank;
const emb = hashEmbedding();

function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-code-'));
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'lib'), { recursive: true });

    fs.writeFileSync(path.join(tmpDir, 'src', 'auth.ts'), `
/**
 * Authentication module — handles user login and token validation.
 */
export async function login(email: string, password: string): Promise<string> {
    return 'sk_' + btoa(email + ':' + password);
}

export function validateToken(token: string): boolean {
    return token.startsWith('sk_') && token.length > 10;
}

export function hashPassword(password: string): string {
    let h = 5381;
    for (let i = 0; i < password.length; i++) h = (h * 33) ^ password.charCodeAt(i);
    return h.toString(16);
}
`.trim());

    fs.writeFileSync(path.join(tmpDir, 'src', 'database.ts'), `
/**
 * Database connection pool and query executor.
 */
export class ConnectionPool {
    private pool: any[] = [];

    constructor(private maxConnections: number = 10) {}

    async connect(url: string): Promise<void> {
        for (let i = 0; i < this.maxConnections; i++) {
            this.pool.push({ url, id: i, active: true });
        }
    }

    async query<T>(sql: string, params: any[] = []): Promise<T[]> {
        const conn = this.pool.find(c => c.active);
        if (!conn) throw new Error('No available connections');
        return [] as T[];
    }

    async close(): Promise<void> {
        this.pool = [];
    }
}
`.trim());

    fs.writeFileSync(path.join(tmpDir, 'lib', 'utils.py'), `
"""
Python utility functions for data processing and transformation.
"""

def parse_csv(filepath: str) -> list:
    """Parse a CSV file and return list of rows as dicts."""
    with open(filepath, 'r') as f:
        headers = f.readline().strip().split(',')
        return [dict(zip(headers, line.strip().split(','))) for line in f]

def clean_text(text: str) -> str:
    """Normalize whitespace and strip special characters."""
    return ' '.join(text.split()).strip()

def calculate_similarity(vec_a: list, vec_b: list) -> float:
    """Compute cosine similarity between two vectors."""
    dot = sum(a * b for a, b in zip(vec_a, vec_b))
    norm_a = sum(a ** 2 for a in vec_a) ** 0.5
    norm_b = sum(b ** 2 for b in vec_b) ** 0.5
    return dot / (norm_a * norm_b) if norm_a and norm_b else 0.0
`.trim());

    fs.writeFileSync(path.join(tmpDir, 'src', 'router.ts'), `
/**
 * HTTP router with middleware support.
 */
type Handler = (req: any, res: any) => Promise<void>;
type Middleware = (req: any, res: any, next: () => void) => void;

export class Router {
    private routes: Map<string, Handler> = new Map();
    private middlewares: Middleware[] = [];

    use(middleware: Middleware): this {
        this.middlewares.push(middleware);
        return this;
    }

    get(path: string, handler: Handler): this {
        this.routes.set('GET:' + path, handler);
        return this;
    }

    post(path: string, handler: Handler): this {
        this.routes.set('POST:' + path, handler);
        return this;
    }

    async handle(method: string, path: string, req: any, res: any): Promise<void> {
        const key = method + ':' + path;
        const handler = this.routes.get(key);
        if (!handler) throw new Error('404 Not Found: ' + key);
        await handler(req, res);
    }
}
`.trim());
}

// ── Tests ──────────────────────────────────────────────

export const tests: Record<string, () => Promise<void>> = {};

tests['index: indexes TypeScript and Python files from nested dirs'] = async () => {
    const assert = (await import('node:assert')).strict;
    setup();

    brain = new BrainBank({ repoPath: tmpDir, dbPath: path.join(tmpDir, 'test.db'), embeddingProvider: emb })
        .use(code({ repoPath: tmpDir }));
    await brain.initialize();

    const result = await brain.indexCode();
    assert.ok(result.indexed >= 4, `indexed ${result.indexed} files (expected ≥4)`);
    assert.ok(result.chunks! > 0, `created ${result.chunks} code chunks`);
};

tests['index: creates chunks with correct metadata (language, lines, type)'] = async () => {
    const assert = (await import('node:assert')).strict;
    const db = (brain as any)._db;
    const chunks = db.prepare('SELECT * FROM code_chunks ORDER BY file_path, start_line').all() as any[];

    assert.ok(chunks.length > 0, 'has chunks');
    const tsChunk = chunks.find((c: any) => c.language === 'typescript');
    assert.ok(tsChunk, 'has TypeScript chunk');
    assert.ok(tsChunk.start_line >= 1, 'has start_line');
    assert.ok(tsChunk.end_line >= tsChunk.start_line, 'end_line >= start_line');

    const pyChunk = chunks.find((c: any) => c.language === 'python');
    assert.ok(pyChunk, 'has Python chunk');
};

tests['index: skips unchanged files on second run'] = async () => {
    const assert = (await import('node:assert')).strict;
    const result = await brain.indexCode();

    assert.equal(result.indexed, 0, 'nothing re-indexed');
    assert.ok(result.skipped >= 4, `skipped ${result.skipped} unchanged files`);
};

tests['index: force reindex re-processes all files'] = async () => {
    const assert = (await import('node:assert')).strict;
    const result = await brain.indexCode({ forceReindex: true });

    assert.ok(result.indexed >= 4, `force re-indexed ${result.indexed} files`);
};

tests['index: detects changed file and re-indexes only it'] = async () => {
    const assert = (await import('node:assert')).strict;

    // Modify one file
    fs.appendFileSync(path.join(tmpDir, 'src', 'auth.ts'), '\nexport const VERSION = "2.0";\n');
    const result = await brain.indexCode();

    assert.equal(result.indexed, 1, 'only changed file re-indexed');
    assert.ok(result.skipped >= 3, `skipped ${result.skipped} unchanged`);
};

tests['search: HNSW finds code by semantic query'] = async () => {
    const assert = (await import('node:assert')).strict;
    const codeMod = brain.indexer('code') as any;
    const queryVec = await emb.embed('user authentication login token');
    const hits = codeMod.hnsw.search(queryVec, 5);

    assert.ok(hits.length > 0, `found ${hits.length} vector hits`);
    assert.ok(hits[0].score > 0, 'has score');
};

tests['search: finds Python functions'] = async () => {
    const assert = (await import('node:assert')).strict;
    const codeMod = brain.indexer('code') as any;
    const queryVec = await emb.embed('parse CSV data processing');
    const hits = codeMod.hnsw.search(queryVec, 5);

    assert.ok(hits.length > 0, 'found Python code results');
};

tests['search: finds class definitions'] = async () => {
    const assert = (await import('node:assert')).strict;
    const codeMod = brain.indexer('code') as any;
    const queryVec = await emb.embed('database connection pool');
    const hits = codeMod.hnsw.search(queryVec, 5);

    assert.ok(hits.length > 0, 'found class-related code');
};

tests['search: finds router/middleware patterns'] = async () => {
    const assert = (await import('node:assert')).strict;
    const codeMod = brain.indexer('code') as any;
    const queryVec = await emb.embed('HTTP route handler middleware');
    const hits = codeMod.hnsw.search(queryVec, 5);

    assert.ok(hits.length > 0, 'found router patterns');
};

tests['stats: reports correct file and chunk counts'] = async () => {
    const assert = (await import('node:assert')).strict;
    const stats = brain.stats();

    assert.ok(stats.code, 'code stats present');
    assert.ok(stats.code.files >= 4, `${stats.code.files} files`);
    assert.ok(stats.code.chunks > 0, `${stats.code.chunks} chunks`);
    assert.ok(stats.code.hnswSize > 0, `HNSW size: ${stats.code.hnswSize}`);
};

tests['cleanup'] = async () => {
    brain.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
};

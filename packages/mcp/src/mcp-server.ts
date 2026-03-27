#!/usr/bin/env node

/**
 * BrainBank — MCP Server
 * 
 * Exposes BrainBank as an MCP server via stdio transport.
 * Works with Google Antigravity, Claude Desktop, and any MCP-compatible client.
 * 
 * Usage in Antigravity mcp_config.json:
 * {
 *   "mcpServers": {
 *     "brainbank": {
 *       "command": "npx",
 *       "args": ["tsx", "/path/to/brainbank/packages/mcp/src/mcp-server.ts"],
 *       "env": { "BRAINBANK_REPO": "/path/to/your/repo" }
 *     }
 *   }
 * }
 * 
 * Tools (6):
 *   brainbank_search     — Unified search (hybrid, vector, or keyword mode)
 *   brainbank_context    — Formatted knowledge context for a task
 *   brainbank_index      — Trigger code/git/docs indexing
 *   brainbank_stats      — Index statistics
 *   brainbank_history    — Git history for a specific file
 *   brainbank_collection — KV collection operations (add, search, trim)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod/v3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BrainBank } from 'brainbank';
import { code } from 'brainbank/code';
import { git } from 'brainbank/git';
import { docs } from 'brainbank/docs';

// ── Configuration from env ──────────────────────────

/**
 * Detect repo root by walking up from startDir until we find `.git/`.
 * Returns startDir itself if no `.git/` is found (mono-repo or non-git project).
 */
function findRepoRoot(startDir: string): string {
    let dir = path.resolve(startDir);
    while (true) {
        if (fs.existsSync(path.join(dir, '.git'))) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) break; // filesystem root
        dir = parent;
    }
    return path.resolve(startDir); // fallback: use startDir as-is
}

const defaultRepoPath = process.env.BRAINBANK_REPO || undefined;

// ── Reranker (default: none, set BRAINBANK_RERANKER=qwen3 to enable) ──

async function createReranker() {
    const rerankerEnv = process.env.BRAINBANK_RERANKER ?? 'none';
    if (rerankerEnv === 'none') return undefined;
    if (rerankerEnv === 'qwen3') {
        const { Qwen3Reranker } = await import('brainbank');
        return new Qwen3Reranker();
    }
    return undefined;
}

// ── Multi-Workspace BrainBank Pool ─────────────────────

const MAX_POOL_SIZE = 10;

interface PoolEntry {
    brain: BrainBank;
    lastAccess: number;
}

const _pool = new Map<string, PoolEntry>();
let _sharedReranker: any = undefined;
let _sharedReady = false;

async function ensureShared() {
    if (_sharedReady) return;
    _sharedReranker = await createReranker();
    _sharedReady = true;
}

async function getBrainBank(targetRepo?: string): Promise<BrainBank> {
    const rp = targetRepo ?? defaultRepoPath;
    if (!rp) {
        throw new Error(
            'No repository specified. Pass the `repo` parameter with the workspace path, ' +
            'or set BRAINBANK_REPO environment variable.'
        );
    }
    const resolved = rp.replace(/\/+$/, '');

    if (_pool.has(resolved)) {
        const entry = _pool.get(resolved)!;
        try {
            const codeStats = entry.brain.plugin('code')?.stats?.();
            if (codeStats && codeStats.hnswSize === 0) {
                const dbPath = path.join(resolved, '.brainbank', 'brainbank.db');
                const dbSize = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0;
                if (dbSize > 100_000) {
                    evictPool(resolved);
                } else {
                    entry.lastAccess = Date.now();
                    return entry.brain;
                }
            } else {
                entry.lastAccess = Date.now();
                return entry.brain;
            }
        } catch {
            entry.lastAccess = Date.now();
            return entry.brain;
        }
    }

    await ensureShared();

    if (_pool.size >= MAX_POOL_SIZE) {
        let oldest: string | undefined;
        let oldestTime = Infinity;
        for (const [key, entry] of _pool) {
            if (entry.lastAccess < oldestTime) {
                oldestTime = entry.lastAccess;
                oldest = key;
            }
        }
        if (oldest) evictPool(oldest);
    }

    const brain = await _createBrain(resolved);
    _pool.set(resolved, { brain, lastAccess: Date.now() });
    return brain;
}

async function _createBrain(resolved: string): Promise<BrainBank> {
    // Embedding provider auto-resolves from stored DB config (no env var needed)
    const opts: Record<string, any> = { repoPath: resolved, reranker: _sharedReranker };
    const brain = new BrainBank(opts)
        .use(code({ repoPath: resolved }))
        .use(git({ repoPath: resolved }))
        .use(docs());

    try {
        await brain.initialize();
    } catch (err: any) {
        if (err?.message?.includes('Invalid the given array length')) {
            const dbPath = path.join(resolved, '.brainbank', 'brainbank.db');
            try { fs.unlinkSync(dbPath); } catch {}
            try { fs.unlinkSync(dbPath + '-wal'); } catch {}
            try { fs.unlinkSync(dbPath + '-shm'); } catch {}

            const fresh = new BrainBank(opts)
                .use(code({ repoPath: resolved }))
                .use(git({ repoPath: resolved }))
                .use(docs());
            await fresh.initialize();
            return fresh;
        }
        throw err;
    }

    return brain;
}

function evictPool(resolved: string) {
    const entry = _pool.get(resolved);
    if (entry) {
        try { entry.brain.close(); } catch {}
        _pool.delete(resolved);
    }
}

// ── MCP Server Setup ────────────────────────────────

const server = new McpServer({
    name: 'brainbank',
    version: '0.2.0',
});

// ── Tool: brainbank_search ──────────────────────────
// Replaces: brainbank_search, brainbank_hybrid_search, brainbank_keyword_search

server.registerTool(
    'brainbank_search',
    {
        title: 'BrainBank Search',
        description:
            'Search indexed code and git commits. Supports three modes:\n' +
            '- hybrid (default): vector + BM25 fused with RRF — best quality\n' +
            '- vector: semantic similarity only\n' +
            '- keyword: instant BM25 for exact terms, function names, error messages',
        inputSchema: z.object({
            query: z.string().describe('Search query — works with both keywords and natural language'),
            mode: z.enum(['hybrid', 'vector', 'keyword']).optional().default('hybrid').describe('Search strategy'),
            codeK: z.number().optional().default(8).describe('Max code results'),
            gitK: z.number().optional().default(5).describe('Max git results'),
            minScore: z.number().optional().default(0.25).describe('Minimum similarity score (0-1), only for vector mode'),
            collections: z.record(z.string(), z.number()).optional().describe(
                'Max results per source. Reserved: "code", "git", "docs". Any other key = KV collection.'
            ),
            repo: z.string().optional().describe('Repository path (default: BRAINBANK_REPO)'),
        }),
    },
    async ({ query, mode, codeK, gitK, minScore, collections, repo }) => {
        const brainbank = await getBrainBank(repo);

        let results;
        if (mode === 'keyword') {
            results = await brainbank.searchBM25(query, { codeK, gitK });
        } else if (mode === 'vector') {
            results = await brainbank.search(query, { codeK, gitK, minScore });
        } else {
            results = await brainbank.hybridSearch(query, { codeK, gitK, collections });
        }

        if (results.length === 0) {
            return { content: [{ type: 'text', text: 'No results found.' }] };
        }

        const modeLabel = mode === 'keyword' ? 'Keyword (BM25)' : mode === 'vector' ? 'Vector' : 'Hybrid (Vector + BM25 → RRF)';
        return { content: [{ type: 'text', text: formatResults(results, modeLabel) }] };
    },
);

// ── Tool: brainbank_context ─────────────────────────

server.registerTool(
    'brainbank_context',
    {
        title: 'BrainBank Context',
        description: 'Get a formatted knowledge context block for a task. Returns relevant code, git history, and co-edit patterns as markdown.',
        inputSchema: z.object({
            task: z.string().describe('Description of the task you need context for'),
            affectedFiles: z.array(z.string()).optional().default([]).describe('Files you plan to modify (improves co-edit suggestions)'),
            codeResults: z.number().optional().default(6).describe('Max code results'),
            gitResults: z.number().optional().default(5).describe('Max git commit results'),
            repo: z.string().optional().describe('Repository path (default: BRAINBANK_REPO)'),
        }),
    },
    async ({ task, affectedFiles, codeResults, gitResults, repo }) => {
        const brainbank = await getBrainBank(repo);
        const context = await brainbank.getContext(task, {
            affectedFiles,
            codeResults,
            gitResults,
        });

        return { content: [{ type: 'text', text: context }] };
    },
);

// ── Tool: brainbank_index ───────────────────────────

server.registerTool(
    'brainbank_index',
    {
        title: 'BrainBank Index',
        description: 'Index (or re-index) code, git history, and docs. Incremental — only changed files are processed.',
        inputSchema: z.object({
            modules: z.array(z.enum(['code', 'git', 'docs'])).optional().describe('Which modules to index (default: all)'),
            docsPath: z.string().optional().describe('Path to a docs folder to register and index'),
            forceReindex: z.boolean().optional().default(false).describe('Force re-index of all files'),
            gitDepth: z.number().optional().default(500).describe('Number of git commits to index'),
            repo: z.string().optional().describe('Repository path (default: BRAINBANK_REPO)'),
        }),
    },
    async ({ modules, docsPath, forceReindex, gitDepth, repo }) => {
        const brainbank = await getBrainBank(repo);

        if (docsPath) {
            const absPath = path.resolve(docsPath);
            const collName = path.basename(absPath);
            try {
                brainbank.addCollection({
                    name: collName,
                    path: absPath,
                    pattern: '**/*.md',
                    ignore: ['deprecated/**', 'node_modules/**'],
                });
            } catch {
                // docs module not loaded
            }
        }

        const result = await brainbank.index({ modules, forceReindex, gitDepth });

        const lines = [
            '## Indexing Complete',
            '',
            `**Code**: ${result.code?.indexed ?? 0} files indexed, ${result.code?.skipped ?? 0} skipped, ${result.code?.chunks ?? 0} chunks`,
            `**Git**: ${result.git?.indexed ?? 0} commits indexed, ${result.git?.skipped ?? 0} skipped`,
        ];

        if (result.docs) {
            for (const [name, stat] of Object.entries(result.docs)) {
                lines.push(`**Docs [${name}]**: ${stat.indexed} indexed, ${stat.skipped} skipped, ${stat.chunks} chunks`);
            }
        }

        const stats = brainbank.stats();
        lines.push('');
        lines.push(`**Totals**: ${stats.code?.chunks ?? 0} code chunks, ${stats.git?.commits ?? 0} commits, ${stats.documents?.documents ?? 0} docs`);

        return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
);

// ── Tool: brainbank_stats ───────────────────────────

server.registerTool(
    'brainbank_stats',
    {
        title: 'BrainBank Stats',
        description: 'Get index statistics: file count, code chunks, git commits, HNSW sizes, KV collections.',
        inputSchema: z.object({
            repo: z.string().optional().describe('Repository path (default: BRAINBANK_REPO)'),
        }),
    },
    async ({ repo }) => {
        const brainbank = await getBrainBank(repo);
        const s = brainbank.stats();

        const lines = ['## BrainBank Stats', ''];

        if (s.code) {
            lines.push(`**Code**: ${s.code.files} files, ${s.code.chunks} chunks, ${s.code.hnswSize} vectors`);
        }
        if (s.git) {
            lines.push(`**Git**: ${s.git.commits} commits, ${s.git.filesTracked} files, ${s.git.coEdits} co-edit pairs`);
        }
        if (s.documents) {
            lines.push(`**Docs**: ${s.documents.collections} collections, ${s.documents.documents} documents`);
        }

        const kvNames = brainbank.listCollectionNames();
        if (kvNames.length > 0) {
            lines.push('');
            lines.push('**KV Collections**:');
            for (const name of kvNames) {
                const coll = brainbank.collection(name);
                lines.push(`- ${name}: ${coll.count()} items`);
            }
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
);

// ── Tool: brainbank_history ─────────────────────────

server.registerTool(
    'brainbank_history',
    {
        title: 'BrainBank File History',
        description: 'Get git commit history for a file. Shows changes, authors, and line counts.',
        inputSchema: z.object({
            filePath: z.string().describe('File path (relative or partial, e.g. "auth.ts")'),
            limit: z.number().optional().default(20).describe('Max commits to return'),
            repo: z.string().optional().describe('Repository path (default: BRAINBANK_REPO)'),
        }),
    },
    async ({ filePath, limit, repo }) => {
        const brainbank = await getBrainBank(repo);
        const history = await brainbank.fileHistory(filePath, limit);

        if (history.length === 0) {
            return { content: [{ type: 'text', text: `No git history found for "${filePath}"` }] };
        }

        const lines = [`## Git History: ${filePath}`, ''];
        for (const h of history as any[]) {
            lines.push(`**[${h.short_hash}]** ${h.message} *(${h.author}, +${h.additions}/-${h.deletions})*`);
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
);

// ── Tool: brainbank_collection ──────────────────────
// Replaces: brainbank_collection_add, brainbank_collection_search, brainbank_collection_trim

server.registerTool(
    'brainbank_collection',
    {
        title: 'BrainBank Collection',
        description:
            'Operate on KV collections (auto-created). Actions:\n' +
            '- add: store content with optional metadata\n' +
            '- search: hybrid vector + keyword search\n' +
            '- trim: keep only N most recent items',
        inputSchema: z.object({
            action: z.enum(['add', 'search', 'trim']).describe('Operation to perform'),
            collection: z.string().describe('Collection name (e.g. "errors", "decisions")'),
            content: z.string().optional().describe('Content to store (required for add)'),
            query: z.string().optional().describe('Search query (required for search)'),
            metadata: z.record(z.any()).optional().default({}).describe('Metadata for add'),
            k: z.number().optional().default(5).describe('Max results for search'),
            keep: z.number().optional().describe('Items to keep for trim'),
            repo: z.string().optional().describe('Repository path (default: BRAINBANK_REPO)'),
        }),
    },
    async ({ action, collection, content, query, metadata, k, keep, repo }) => {
        const brainbank = await getBrainBank(repo);
        const coll = brainbank.collection(collection);

        if (action === 'add') {
            if (!content) throw new Error('BrainBank: content is required for add action.');
            const id = await coll.add(content, metadata);
            return {
                content: [{ type: 'text', text: `✓ Item #${id} added to '${collection}' (${coll.count()} total)` }],
            };
        }

        if (action === 'search') {
            if (!query) throw new Error('BrainBank: query is required for search action.');
            const results = await coll.search(query, { k });

            if (results.length === 0) {
                return { content: [{ type: 'text', text: `No results in '${collection}' for "${query}"` }] };
            }

            const lines = [`## Collection: ${collection}`, ''];
            for (const r of results) {
                const score = Math.round((r.score ?? 0) * 100);
                lines.push(`[${score}%] ${r.content}`);
                if (Object.keys(r.metadata).length > 0) {
                    lines.push(`  ${JSON.stringify(r.metadata)}`);
                }
                lines.push('');
            }
            return { content: [{ type: 'text', text: lines.join('\n') }] };
        }

        if (action === 'trim') {
            if (keep == null) throw new Error('BrainBank: keep is required for trim action.');
            const result = await coll.trim({ keep });
            return {
                content: [{ type: 'text', text: `✓ Trimmed ${result.removed} items from '${collection}' (kept ${keep})` }],
            };
        }

        throw new Error(`BrainBank: Unknown action "${action}".`);
    },
);

// ── Shared result formatter ─────────────────────────

function formatResults(results: any[], mode: string): string {
    const lines: string[] = [`## ${mode}`, ''];
    for (const r of results) {
        const score = Math.round(r.score * 100);
        if (r.type === 'code') {
            const m = r.metadata;
            lines.push(`[CODE ${score}%] ${r.filePath} — ${m.name || m.chunkType} (L${m.startLine}-${m.endLine})`);
            lines.push(r.content);
            lines.push('');
        } else if (r.type === 'commit') {
            const m = r.metadata;
            lines.push(`[COMMIT ${score}%] ${m.shortHash} — ${r.content} (${m.author})`);
            if (m.files?.length) lines.push(`  Files: ${m.files.join(', ')}`);
            lines.push('');
        } else if (r.type === 'document') {
            const ctx = r.context ? ` — ${r.context}` : '';
            lines.push(`[DOC ${score}%] ${r.filePath} [${r.metadata.collection}]${ctx}`);
            lines.push(r.content);
            lines.push('');
        } else if (r.type === 'collection') {
            const col = r.metadata?.collection ?? 'unknown';
            lines.push(`[COLLECTION ${score}%] [${col}]`);
            lines.push(r.content);
            lines.push('');
        }
    }
    return lines.join('\n');
}

// ── Start Server ────────────────────────────────────

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main().catch(err => {
    console.error(`BrainBank MCP Server Error: ${err.message}`);
    process.exit(1);
});

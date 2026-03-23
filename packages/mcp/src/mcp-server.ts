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
 *       "args": ["tsx", "/path/to/brainbank/src/integrations/mcp-server.ts"],
 *       "env": { "BRAINBANK_REPO": "/path/to/your/repo" }
 *     }
 *   }
 * }
 * 
 * Tools exposed:
 *   brainbank_search         — Semantic search across code, commits
 *   brainbank_hybrid_search  — Best quality: vector + BM25 fused
 *   brainbank_keyword_search — Instant BM25 full-text
 *   brainbank_context        — Get formatted context for a task
 *   brainbank_index          — Trigger code/git indexing
 *   brainbank_stats          — Get index statistics
 *   brainbank_history        — Git history for a specific file
 *   brainbank_coedits        — Files that frequently change together
 *   brainbank_collection_add     — Add item to a dynamic collection
 *   brainbank_collection_search  — Search a dynamic collection
 *   brainbank_collection_trim    — Trim a dynamic collection
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

// ── Reranker (default: qwen3, set BRAINBANK_RERANKER=none to disable) ──

async function createReranker() {
    const rerankerEnv = process.env.BRAINBANK_RERANKER ?? 'none';
    if (rerankerEnv === 'none') return undefined;
    if (rerankerEnv === 'qwen3') {
        const { Qwen3Reranker } = await import('@brainbank/reranker');
        return new Qwen3Reranker();
    }
    return undefined;
}

// ── Embedding Provider (default: local, set BRAINBANK_EMBEDDING=openai) ──

async function createEmbeddingProvider() {
    const embeddingEnv = process.env.BRAINBANK_EMBEDDING ?? 'local';
    if (embeddingEnv === 'openai') {
        const { OpenAIEmbedding } = await import('brainbank');
        return new OpenAIEmbedding();
    }
    return undefined; // BrainBank defaults to local WASM
}

// ── Multi-Workspace BrainBank Pool ─────────────────────
// Reranker + embedding provider are shared; each repo gets its own DB.

const _pool = new Map<string, BrainBank>();
let _sharedReranker: any = undefined;
let _sharedEmbedding: any = undefined;
let _sharedReady = false;

async function ensureShared() {
    if (_sharedReady) return;
    _sharedReranker = await createReranker();
    _sharedEmbedding = await createEmbeddingProvider();
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
    const resolved = rp.replace(/\/+$/, ''); // normalize

    if (_pool.has(resolved)) return _pool.get(resolved)!;

    await ensureShared();

    const opts: Record<string, any> = { repoPath: resolved, reranker: _sharedReranker };
    if (_sharedEmbedding) {
        opts.embeddingProvider = _sharedEmbedding;
        opts.embeddingDims = _sharedEmbedding.dims;
    }
    const brain = new BrainBank(opts)
        .use(code({ repoPath: resolved }))
        .use(git({ repoPath: resolved }))
        .use(docs());
    await brain.initialize();

    _pool.set(resolved, brain);
    return brain;
}

// ── MCP Server Setup ────────────────────────────────

const server = new McpServer({
    name: 'brainbank',
    version: '0.1.0',
});

// ── Tool: brainbank_search ─────────────────────────────

server.registerTool(
    'brainbank_search',
    {
        title: 'BrainBank Search',
        description: 'Semantic search across indexed code and git commits. Returns the most relevant results sorted by similarity score.',
        inputSchema: z.object({
            query: z.string().describe('Natural language search query describing what you are looking for'),
            codeK: z.number().optional().default(6).describe('Max code results to return'),
            gitK: z.number().optional().default(5).describe('Max git commit results to return'),
            minScore: z.number().optional().default(0.25).describe('Minimum similarity score threshold (0-1)'),
            repo: z.string().optional().describe('Repository path to search (default: BRAINBANK_REPO)'),
        }),
    },
    async ({ query, codeK, gitK, minScore, repo }) => {
        const brainbank = await getBrainBank(repo);
        const results = await brainbank.search(query, { codeK, gitK, minScore });

        if (results.length === 0) {
            return { content: [{ type: 'text', text: 'No results found for this query.' }] };
        }

        return { content: [{ type: 'text', text: formatResults(results, 'Semantic Search') }] };
    },
);

// ── Tool: brainbank_context ────────────────────────────

server.registerTool(
    'brainbank_context',
    {
        title: 'BrainBank Context',
        description: 'Get a formatted knowledge context block for a task. Returns relevant code snippets, git history, co-edit patterns as markdown. Perfect for enriching your understanding before working on a task.',
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

// ── Tool: brainbank_index ──────────────────────────────

server.registerTool(
    'brainbank_index',
    {
        title: 'BrainBank Index',
        description: 'Index (or re-index) the repository code and git history. Run this before searching if the codebase has changed. Indexing is incremental — only changed files are processed.',
        inputSchema: z.object({
            forceReindex: z.boolean().optional().default(false).describe('Force re-index of all files, even unchanged ones'),
            gitDepth: z.number().optional().default(500).describe('Number of git commits to index'),
            repo: z.string().optional().describe('Repository path to index (default: BRAINBANK_REPO)'),
        }),
    },
    async ({ forceReindex, gitDepth, repo }) => {
        const brainbank = await getBrainBank(repo);
        const result = await brainbank.index({ forceReindex, gitDepth });

        const lines = [
            '## Indexing Complete',
            '',
            `**Code**: ${result.code?.indexed ?? 0} files indexed, ${result.code?.skipped ?? 0} skipped, ${result.code?.chunks ?? 0} chunks`,
            `**Git**: ${result.git?.indexed ?? 0} commits indexed, ${result.git?.skipped ?? 0} skipped`,
        ];

        const stats = brainbank.stats();
        lines.push('');
        lines.push(`**Totals**: ${stats.code?.chunks ?? 0} code chunks, ${stats.git?.commits ?? 0} commits`);

        return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
);

// ── Tool: brainbank_stats ──────────────────────────────

server.registerTool(
    'brainbank_stats',
    {
        title: 'BrainBank Stats',
        description: 'Get statistics about the indexed knowledge base: file count, code chunks, git commits, HNSW index sizes, and KV collections.',
        inputSchema: z.object({
            repo: z.string().optional().describe('Repository path (default: BRAINBANK_REPO)'),
        }),
    },
    async ({ repo }) => {
        const brainbank = await getBrainBank(repo);
        const s = brainbank.stats();

        const lines = [
            '## BrainBank Knowledge Base Stats',
            '',
        ];

        if (s.code) {
            lines.push('### Code');
            lines.push(`- Files indexed: ${s.code.files}`);
            lines.push(`- Code chunks: ${s.code.chunks}`);
            lines.push(`- HNSW vectors: ${s.code.hnswSize}`);
            lines.push('');
        }

        if (s.git) {
            lines.push('### Git History');
            lines.push(`- Commits indexed: ${s.git.commits}`);
            lines.push(`- Files tracked: ${s.git.filesTracked}`);
            lines.push(`- Co-edit pairs: ${s.git.coEdits}`);
            lines.push(`- HNSW vectors: ${s.git.hnswSize}`);
            lines.push('');
        }

        if (s.documents) {
            lines.push('### Documents');
            lines.push(`- Collections: ${s.documents.collections}`);
            lines.push(`- Documents: ${s.documents.documents}`);
            lines.push(`- HNSW vectors: ${s.documents.hnswSize}`);
            lines.push('');
        }

        const kvNames = brainbank.listCollectionNames();
        if (kvNames.length > 0) {
            lines.push('### KV Collections');
            for (const name of kvNames) {
                const coll = brainbank.collection(name);
                lines.push(`- ${name}: ${coll.count()} items`);
            }
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
);

// ── Tool: brainbank_history ────────────────────────────

server.registerTool(
    'brainbank_history',
    {
        title: 'BrainBank File History',
        description: 'Get the git commit history for a specific file. Shows recent changes, authors, and line counts.',
        inputSchema: z.object({
            filePath: z.string().describe('File path (relative or partial match, e.g. "auth.ts" or "src/core/agent.ts")'),
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

// ── Tool: brainbank_coedits ────────────────────────────

server.registerTool(
    'brainbank_coedits',
    {
        title: 'BrainBank Co-Edits',
        description: 'Find files that historically change together with a given file. Useful for understanding dependencies and ensuring you do not miss related changes.',
        inputSchema: z.object({
            filePath: z.string().describe('File path to check co-edit relationships for'),
            limit: z.number().optional().default(5).describe('Max co-edit suggestions'),
            repo: z.string().optional().describe('Repository path (default: BRAINBANK_REPO)'),
        }),
    },
    async ({ filePath, limit, repo }) => {
        const brainbank = await getBrainBank(repo);
        const suggestions = brainbank.coEdits(filePath, limit);

        if (suggestions.length === 0) {
            return { content: [{ type: 'text', text: `No co-edit patterns found for "${filePath}"` }] };
        }

        const lines = [`## Co-Edits for: ${filePath}`, ''];
        lines.push('Files that frequently change together:');
        for (const s of suggestions) {
            lines.push(`- **${s.file}** (changed together ${s.count} times)`);
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
);

// ── Tool: brainbank_hybrid_search ─────────────────────

server.registerTool(
    'brainbank_hybrid_search',
    {
        title: 'BrainBank Hybrid Search',
        description: 'Best quality search: combines semantic vector search + BM25 keyword search using Reciprocal Rank Fusion. Catches both exact keyword matches AND conceptual similarities. Use this by default for all searches.',
        inputSchema: z.object({
            query: z.string().describe('Search query — works with both keywords and natural language'),
            codeK: z.number().optional().default(8).describe('Max code results (shorthand for collections.code)'),
            gitK: z.number().optional().default(5).describe('Max git results (shorthand for collections.git)'),
            collections: z.record(z.string(), z.number()).optional().describe(
                'Max results per source. Reserved keys: "code", "git", "docs" control built-in indexers. ' +
                'Any other key is a KV collection. Example: { "code": 8, "git": 5, "errors": 3, "slack": 2 }'
            ),
            repo: z.string().optional().describe('Repository path to search (default: BRAINBANK_REPO)'),
        }),
    },
    async ({ query, codeK, gitK, collections, repo }) => {
        const t0 = performance.now();
        const brainbank = await getBrainBank(repo);
        const t1 = performance.now();
        const results = await brainbank.hybridSearch(query, { codeK, gitK, collections });
        const t2 = performance.now();

        const timing = `\n\n⏱ getBrainBank: ${(t1 - t0).toFixed(0)}ms | hybridSearch: ${(t2 - t1).toFixed(0)}ms | total: ${(t2 - t0).toFixed(0)}ms`;

        if (results.length === 0) {
            return { content: [{ type: 'text', text: 'No results found for this query.' + timing }] };
        }

        return { content: [{ type: 'text', text: formatResults(results, 'Hybrid Search (Vector + BM25 → RRF)') + timing }] };
    },
);

// ── Tool: brainbank_keyword_search ────────────────────

server.registerTool(
    'brainbank_keyword_search',
    {
        title: 'BrainBank Keyword Search',
        description: 'Instant BM25 keyword search (no embedding computation needed). Best for exact terms, function names, variable names, error messages, and specific identifiers.',
        inputSchema: z.object({
            query: z.string().describe('Keywords to search for'),
            codeK: z.number().optional().default(8).describe('Max code results to return'),
            gitK: z.number().optional().default(5).describe('Max git commit results to return'),
            repo: z.string().optional().describe('Repository path to search (default: BRAINBANK_REPO)'),
        }),
    },
    async ({ query, codeK, gitK, repo }) => {
        const brainbank = await getBrainBank(repo);
        const results = brainbank.searchBM25(query, { codeK, gitK });

        if (results.length === 0) {
            return { content: [{ type: 'text', text: 'No keyword matches found.' }] };
        }

        return { content: [{ type: 'text', text: formatResults(results, 'Keyword Search (BM25)') }] };
    },
);

// ── Tool: brainbank_collection_add ────────────────────

server.registerTool(
    'brainbank_collection_add',
    {
        title: 'BrainBank Collection Add',
        description: 'Add an item to a dynamic KV collection. Collections are created automatically. Use this to store any structured data: errors, decisions, notes, context, etc.',
        inputSchema: z.object({
            collection: z.string().describe('Collection name (e.g. "errors", "decisions", "context")'),
            content: z.string().describe('Content to store'),
            metadata: z.record(z.any()).optional().default({}).describe('Optional metadata object'),
            repo: z.string().optional().describe('Repository path (default: BRAINBANK_REPO)'),
        }),
    },
    async ({ collection, content, metadata, repo }) => {
        const brainbank = await getBrainBank(repo);
        const coll = brainbank.collection(collection);
        const id = await coll.add(content, metadata);

        return {
            content: [{ type: 'text', text: `✓ Item #${id} added to '${collection}' (${coll.count()} total)` }],
        };
    },
);

// ── Tool: brainbank_collection_search ──────────────────

server.registerTool(
    'brainbank_collection_search',
    {
        title: 'BrainBank Collection Search',
        description: 'Search a dynamic KV collection using hybrid vector + keyword search. Returns semantically similar items.',
        inputSchema: z.object({
            collection: z.string().describe('Collection name to search'),
            query: z.string().describe('Search query'),
            k: z.number().optional().default(5).describe('Max results'),
            mode: z.enum(['hybrid', 'vector', 'keyword']).optional().default('hybrid').describe('Search mode'),
            repo: z.string().optional().describe('Repository path (default: BRAINBANK_REPO)'),
        }),
    },
    async ({ collection, query, k, mode, repo }) => {
        const brainbank = await getBrainBank(repo);
        const coll = brainbank.collection(collection);
        const results = await coll.search(query, { k, mode: mode as any });

        if (results.length === 0) {
            return { content: [{ type: 'text', text: `No results in '${collection}' for "${query}"` }] };
        }

        const lines = [`## Collection: ${collection} — "${query}"`, ''];
        for (const r of results) {
            const score = Math.round((r.score ?? 0) * 100);
            lines.push(`[${score}%] ${r.content}`);
            if (Object.keys(r.metadata).length > 0) {
                lines.push(`  ${JSON.stringify(r.metadata)}`);
            }
            lines.push('');
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
);

// ── Tool: brainbank_collection_trim ────────────────────

server.registerTool(
    'brainbank_collection_trim',
    {
        title: 'BrainBank Collection Trim',
        description: 'Trim a dynamic collection to keep only the N most recent items. Use this to prevent collections from growing unbounded.',
        inputSchema: z.object({
            collection: z.string().describe('Collection name'),
            keep: z.number().describe('Number of most recent items to keep'),
            repo: z.string().optional().describe('Repository path (default: BRAINBANK_REPO)'),
        }),
    },
    async ({ collection, keep, repo }) => {
        const brainbank = await getBrainBank(repo);
        const coll = brainbank.collection(collection);
        const result = await coll.trim({ keep });

        return {
            content: [{
                type: 'text',
                text: `✓ Trimmed ${result.removed} items from '${collection}' (kept ${keep})`,
            }],
        };
    },
);

// ── Shared result formatter ────────────────────────

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

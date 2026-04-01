#!/usr/bin/env node

/**
 * BrainBank — MCP Server
 * 
 * Exposes BrainBank as an MCP server via stdio transport.
 * Works with Google Antigravity, Claude Desktop, and any MCP-compatible client.
 * 
 * Usage in mcp_config.json:
 * {
 *   "mcpServers": {
 *     "brainbank": {
 *       "command": "npx",
 *       "args": ["-y", "@brainbank/mcp"]
 *     }
 *   }
 * }
 * 
 * Tools (7):
 *   brainbank_search     — Unified search (hybrid, vector, or keyword mode)
 *   brainbank_context    — Formatted knowledge context for a task
 *   brainbank_index      — Trigger code/git/docs indexing
 *   brainbank_stats      — Index statistics
 *   brainbank_history    — Git history for a specific file
 *   brainbank_collection — KV collection operations (add, search, trim)
 *   brainbank_workspaces — Pool observability (list, evict, stats)
 */

import type { SearchResult } from 'brainbank';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod/v3';
import * as path from 'node:path';
import { WorkspacePool } from './workspace-pool.js';
import { createWorkspaceBrain, resolveRepoPath } from './workspace-factory.js';

// ── Multi-Workspace BrainBank Pool ─────────────────────

const pool = new WorkspacePool({
    factory: createWorkspaceBrain,
    maxMemoryMB: parseInt(process.env.BRAINBANK_MAX_MEMORY_MB ?? '2048', 10),
    ttlMinutes: parseInt(process.env.BRAINBANK_TTL_MINUTES ?? '30', 10),
    onError: (repo, err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`BrainBank pool error [${repo}]: ${msg}`);
    },
});

/** Resolve repo and get a BrainBank from the pool. */
async function getBrainBank(targetRepo?: string) {
    return pool.get(resolveRepoPath(targetRepo));
}

// ── MCP Server Setup ────────────────────────────────

const server = new McpServer({
    name: 'brainbank',
    version: '0.3.0',
});

// ── Tool: brainbank_search ──────────────────────────

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

        // Merge codeK/gitK shorthands into sources
        const sources: Record<string, number> = { ...collections, code: codeK, git: gitK };

        let results: SearchResult[];
        if (mode === 'keyword') {
            results = await brainbank.searchBM25(query, { sources });
        } else if (mode === 'vector') {
            results = await brainbank.search(query, { sources, minScore });
        } else {
            results = await brainbank.hybridSearch(query, { sources });
        }

        if (results.length === 0) {
            return { content: [{ type: 'text' as const, text: 'No results found.' }] };
        }

        const modeLabel = mode === 'keyword' ? 'Keyword (BM25)' : mode === 'vector' ? 'Vector' : 'Hybrid (Vector + BM25 → RRF)';
        return { content: [{ type: 'text' as const, text: formatResults(results, modeLabel) }] };
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
            sources: { code: codeResults, git: gitResults },
        });

        return { content: [{ type: 'text' as const, text: context }] };
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
                const { isDocsPlugin } = await import('brainbank') as typeof import('brainbank');
                const docsPlugin = brainbank.plugin('docs');
                if (docsPlugin && isDocsPlugin(docsPlugin)) {
                    await docsPlugin.addCollection({
                        name: collName,
                        path: absPath,
                        pattern: '**/*.md',
                        ignore: ['deprecated/**', 'node_modules/**'],
                    });
                }
            } catch {
                // docs plugin not loaded — skip
            }
        }

        const result = await brainbank.index({ modules, forceReindex, pluginOptions: { gitDepth } });

        const lines = [
            '## Indexing Complete',
            '',
        ];

        const codeResult = result.code as { indexed?: number; skipped?: number; chunks?: number } | undefined;
        const gitResult = result.git as { indexed?: number; skipped?: number } | undefined;

        lines.push(`**Code**: ${codeResult?.indexed ?? 0} files indexed, ${codeResult?.skipped ?? 0} skipped, ${codeResult?.chunks ?? 0} chunks`);
        lines.push(`**Git**: ${gitResult?.indexed ?? 0} commits indexed, ${gitResult?.skipped ?? 0} skipped`);

        const docsResult = result.docs as Record<string, { indexed: number; skipped: number; chunks: number }> | undefined;
        if (docsResult) {
            for (const [name, stat] of Object.entries(docsResult)) {
                lines.push(`**Docs [${name}]**: ${stat.indexed} indexed, ${stat.skipped} skipped, ${stat.chunks} chunks`);
            }
        }

        const stats = brainbank.stats();
        const codeStats = stats.code as { chunks?: number } | undefined;
        const gitStats = stats.git as { commits?: number } | undefined;
        const docStats = stats.documents as { documents?: number } | undefined;
        lines.push('');
        lines.push(`**Totals**: ${codeStats?.chunks ?? 0} code chunks, ${gitStats?.commits ?? 0} commits, ${docStats?.documents ?? 0} docs`);

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
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

        const code = s.code as { files?: number; chunks?: number; hnswSize?: number } | undefined;
        const git = s.git as { commits?: number; filesTracked?: number; coEdits?: number } | undefined;
        const docs = s.documents as { collections?: number; documents?: number } | undefined;

        if (code) lines.push(`**Code**: ${code.files} files, ${code.chunks} chunks, ${code.hnswSize} vectors`);
        if (git) lines.push(`**Git**: ${git.commits} commits, ${git.filesTracked} files, ${git.coEdits} co-edit pairs`);
        if (docs) lines.push(`**Docs**: ${docs.collections} collections, ${docs.documents} documents`);

        const kvNames = brainbank.listCollectionNames();
        if (kvNames.length > 0) {
            lines.push('');
            lines.push('**KV Collections**:');
            for (const name of kvNames) {
                const coll = brainbank.collection(name);
                lines.push(`- ${name}: ${coll.count()} items`);
            }
        }

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
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
        const gitPlugin = brainbank.plugin('git');
        if (!gitPlugin) {
            return { content: [{ type: 'text' as const, text: 'Git plugin not loaded for this workspace.' }] };
        }

        const history = await (gitPlugin as unknown as { fileHistory(fp: string, limit: number): Promise<GitHistoryEntry[]> }).fileHistory(filePath, limit);

        if (history.length === 0) {
            return { content: [{ type: 'text' as const, text: `No git history found for "${filePath}"` }] };
        }

        const lines = [`## Git History: ${filePath}`, ''];
        for (const h of history) {
            lines.push(`**[${h.short_hash}]** ${h.message} *(${h.author}, +${h.additions}/-${h.deletions})*`);
        }

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    },
);

/** Git history entry shape returned by the git plugin. */
interface GitHistoryEntry {
    short_hash: string;
    message: string;
    author: string;
    additions: number;
    deletions: number;
}

// ── Tool: brainbank_collection ──────────────────────

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
            metadata: z.record(z.string(), z.unknown()).optional().default({}).describe('Metadata for add'),
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
                content: [{ type: 'text' as const, text: `✓ Item #${id} added to '${collection}' (${coll.count()} total)` }],
            };
        }

        if (action === 'search') {
            if (!query) throw new Error('BrainBank: query is required for search action.');
            const results = await coll.search(query, { k });

            if (results.length === 0) {
                return { content: [{ type: 'text' as const, text: `No results in '${collection}' for "${query}"` }] };
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
            return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
        }

        if (action === 'trim') {
            if (keep == null) throw new Error('BrainBank: keep is required for trim action.');
            const result = await coll.trim({ keep });
            return {
                content: [{ type: 'text' as const, text: `✓ Trimmed ${result.removed} items from '${collection}' (kept ${keep})` }],
            };
        }

        throw new Error(`BrainBank: Unknown action "${action}".`);
    },
);

// ── Tool: brainbank_workspaces ──────────────────────

server.registerTool(
    'brainbank_workspaces',
    {
        title: 'BrainBank Workspaces',
        description:
            'Pool observability. Actions:\n' +
            '- list: show loaded workspaces with memory usage and last access\n' +
            '- evict: force-evict a workspace from the pool\n' +
            '- stats: show total pool memory and configuration',
        inputSchema: z.object({
            action: z.enum(['list', 'evict', 'stats']).describe('Operation to perform'),
            repo: z.string().optional().describe('Repository path (required for evict)'),
        }),
    },
    async ({ action, repo }) => {
        if (action === 'list' || action === 'stats') {
            const s = pool.stats();
            const lines = [
                `## Workspace Pool`,
                '',
                `**Loaded**: ${s.size} workspace(s)`,
                `**Total Memory**: ${s.totalMemoryMB} MB`,
                '',
            ];

            if (s.entries.length > 0) {
                lines.push('| Workspace | Memory | Last Access | Active Ops |');
                lines.push('|---|---|---|---|');
                for (const e of s.entries) {
                    lines.push(`| ${e.repoPath} | ${e.memoryMB} MB | ${e.lastAccessAgo} | ${e.activeOps} |`);
                }
            }

            return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
        }

        if (action === 'evict') {
            if (!repo) throw new Error('BrainBank: repo is required for evict action.');
            pool.evict(repo);
            return { content: [{ type: 'text' as const, text: `✓ Evicted workspace: ${repo}` }] };
        }

        throw new Error(`BrainBank: Unknown workspace action "${action}".`);
    },
);

// ── Shared result formatter ─────────────────────────

function formatResults(results: SearchResult[], mode: string): string {
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
    const message = err instanceof Error ? err.message : String(err);
    console.error(`BrainBank MCP Server Error: ${message}`);
    process.exit(1);
});

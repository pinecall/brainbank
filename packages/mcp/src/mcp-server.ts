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
 * Tools (2):
 *   brainbank_context — Workflow Trace: search + call tree + called-by annotations
 *   brainbank_index  — Re-index (requires .brainbank/config.json)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod/v3';
import { existsSync } from 'node:fs';
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
    version: '0.4.0',
});

// ── Tool: brainbank_context ─────────────────────────

server.registerTool(
    'brainbank_context',
    {
        title: 'BrainBank Context',
        description:
            'Get a formatted knowledge context block for a task. Returns a Workflow Trace: ' +
            'search hits + full call tree with `called by` annotations, topologically ordered. ' +
            'All source code included — no trimming, no truncation.',
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
        description:
            'Re-index code, git history, and docs. Requires .brainbank/config.json to exist. ' +
            'Incremental — only changed files are processed.',
        inputSchema: z.object({
            forceReindex: z.boolean().optional().default(false).describe('Force re-index of all files'),
            repo: z.string().optional().describe('Repository path (default: BRAINBANK_REPO)'),
        }),
    },
    async ({ forceReindex, repo }) => {
        const repoPath = resolveRepoPath(repo);

        // Require config.json — force users to set up structure first
        if (!existsSync(`${repoPath}/.brainbank/config.json`)) {
            return {
                content: [{
                    type: 'text' as const,
                    text:
                        `BrainBank: No .brainbank/config.json found at ${repoPath}.\n\n` +
                        `## How to set up\n\n` +
                        `Create \`${repoPath}/.brainbank/config.json\` with:\n\n` +
                        '```json\n' +
                        '{\n' +
                        '  "plugins": ["code"],\n' +
                        '  "code": {\n' +
                        '    "embedding": "perplexity-context",\n' +
                        '    "ignore": [\n' +
                        '      "node_modules/**", "dist/**", "build/**",\n' +
                        '      ".next/**", "coverage/**", "__pycache__/**",\n' +
                        '      "**/*.min.js", "**/*.min.css",\n' +
                        '      "tests/**", "test/**",\n' +
                        '      "**/test_*.py", "**/*_test.py",\n' +
                        '      "**/*.test.ts", "**/*.spec.ts"\n' +
                        '    ]\n' +
                        '  },\n' +
                        '  "embedding": "perplexity-context"\n' +
                        '}\n' +
                        '```\n\n' +
                        `**Embedding options:** \`local\` (free, offline), \`openai\`, \`perplexity\`, \`perplexity-context\` (best quality)\n` +
                        `**Plugins available:** \`code\`, \`git\`, \`docs\`\n\n` +
                        `Then run:\n` +
                        '```bash\nbrainbank index . --force --yes\n```',
                }],
            };
        }

        const brainbank = await getBrainBank(repo);
        const result = await brainbank.index({ forceReindex });

        const lines = ['## Indexing Complete', ''];

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

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
 * Tools:
 *   brainbank_context — Workflow Trace: search + call tree + called-by annotations
 *   brainbank_files   — Direct file viewer for indexed files
 *
 * Indexing is handled by the CLI (`brainbank index`) — not exposed as an MCP tool.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod/v3';

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
            codeResults: z.number().optional().default(20).describe('Max code results'),
            gitResults: z.number().optional().default(5).describe('Max git commit results'),
            docsResults: z.number().optional().describe('Max document results (omit to skip docs)'),
            sources: z.record(z.number()).optional().describe('Per-source result limits, overrides codeResults/gitResults/docsResults (e.g. { code: 10, git: 0, docs: 5 })'),
            path: z.string().optional().describe('Filter results to files under this path prefix (e.g. src/services/)'),
            ignore: z.array(z.string()).optional().describe('Exclude results whose filePath starts with any of these prefixes (e.g. ["src/tests/", "src/mocks/"])'),
            repo: z.string().describe('Repository path (default: BRAINBANK_REPO)'),
            // BrainBankQL context fields
            lines: z.boolean().optional().describe('Prefix each code line with its source line number (e.g. 127| code)'),
            symbols: z.boolean().optional().describe('Append symbol index (all functions, classes, interfaces) for matched files'),
            compact: z.boolean().optional().describe('Show only function/class signatures, skip bodies'),
            callTree: z.union([z.boolean(), z.object({ depth: z.number() })]).optional().describe('Include call tree expansion. Pass { depth: N } to control depth'),
            imports: z.boolean().optional().describe('Include dependency/import summary section'),
            expander: z.boolean().optional().describe('Enable LLM-powered context expansion to discover related chunks not found by search'),
        }),
    },
    async ({ task, affectedFiles, codeResults, gitResults, docsResults, sources, path, ignore, repo, lines, symbols, compact, callTree, imports, expander }) => {
        const repoPath = resolveRepoPath(repo);
        const brainbank = await getBrainBank(repo);

        // Build sources from explicit params, then let `sources` override
        const base: Record<string, number> = { code: codeResults, git: gitResults };
        if (docsResults !== undefined) base.docs = docsResults;
        const resolvedSources = sources ? { ...base, ...sources } : base;

        // Build fields from explicit params (only include defined values)
        const fields: Record<string, unknown> = {};
        if (lines !== undefined) fields.lines = lines;
        if (symbols !== undefined) fields.symbols = symbols;
        if (compact !== undefined) fields.compact = compact;
        if (callTree !== undefined) fields.callTree = callTree;
        if (imports !== undefined) fields.imports = imports;
        if (expander !== undefined) fields.expander = expander;

        const context = await brainbank.getContext(task, {
            affectedFiles,
            sources: resolvedSources,
            pathPrefix: path,
            ignorePaths: ignore,
            source: 'mcp',
            fields: Object.keys(fields).length > 0 ? fields : undefined,
        });

        return { content: [{ type: 'text' as const, text: context }] };
    },
);

// ── Tool: brainbank_files ───────────────────────────

server.registerTool(
    'brainbank_files',
    {
        title: 'BrainBank Files',
        description:
            'Fetch full file contents from the index. Use AFTER brainbank_context ' +
            'to view complete files identified by search. No semantic search runs — ' +
            'this is a direct file viewer.\n\n' +
            'Supports:\n' +
            '- Exact paths: "src/auth/login.ts"\n' +
            '- Directories: "src/graph/" (trailing / = all files under path)\n' +
            '- Glob patterns: "src/**/*.service.ts"\n' +
            '- Fuzzy basename: "plugin.ts" (matches src/plugin.ts when exact fails)',
        inputSchema: z.object({
            files: z.array(z.string()).describe(
                'File paths to fetch. Exact paths, directories (trailing /), ' +
                'glob patterns (e.g. src/**/*.ts), or fuzzy basenames.',
            ),
            repo: z.string().describe('Repository path (default: BRAINBANK_REPO)'),
            lines: z.boolean().optional().describe('Prefix each line with source line number'),
        }),
    },
    async ({ files, repo, lines }) => {
        const brainbank = await getBrainBank(repo);
        const results = brainbank.resolveFiles(files);

        if (results.length === 0) {
            return { content: [{ type: 'text' as const, text: 'No matching files found in the index.' }] };
        }

        // Format: markdown with file headers + fenced code blocks
        const parts: string[] = [];
        for (const r of results) {
            const meta = r.metadata as Record<string, unknown>;
            const lang = (meta.language as string) ?? '';
            const startLine = (meta.startLine as number) ?? 1;

            parts.push(`## ${r.filePath}\n`);
            parts.push('```' + lang);

            if (lines) {
                const codeLines = r.content.split('\n');
                const pad = String(startLine + codeLines.length - 1).length;
                parts.push(codeLines.map((l, i) =>
                    `${String(startLine + i).padStart(pad)}| ${l}`,
                ).join('\n'));
            } else {
                parts.push(r.content);
            }

            parts.push('```\n');
        }

        return { content: [{ type: 'text' as const, text: parts.join('\n') }] };
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

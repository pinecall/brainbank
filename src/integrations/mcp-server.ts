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
 *   brainbank_search   — Semantic search across code, commits, and patterns
 *   brainbank_context  — Get formatted context for a task (markdown)
 *   brainbank_index    — Trigger code/git indexing
 *   brainbank_learn    — Store a learned pattern from a task
 *   brainbank_stats    — Get index statistics
 *   brainbank_history  — Git history for a specific file
 *   brainbank_coedits  — Files that frequently change together
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { BrainBank } from '../core/brainbank.ts';

// ── Configuration from env ──────────────────────────

const repoPath = process.env.BRAINBANK_REPO || process.env.REPO_PATH || process.cwd();
const dbPath = process.env.BRAINBANK_DB || undefined;

// ── Lazy BrainBank Instance ────────────────────────────

let _brainbank: BrainBank | null = null;

async function getBrainBank(): Promise<BrainBank> {
    if (!_brainbank) {
        _brainbank = new BrainBank({
            repoPath,
            ...(dbPath ? { dbPath } : {}),
        });
        await _brainbank.initialize();
    }
    return _brainbank;
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
        description: 'Semantic search across indexed code, git commits, and learned patterns. Returns the most relevant results sorted by similarity score.',
        inputSchema: z.object({
            query: z.string().describe('Natural language search query describing what you are looking for'),
            codeK: z.number().optional().default(6).describe('Max code results to return'),
            gitK: z.number().optional().default(5).describe('Max git commit results to return'),
            memoryK: z.number().optional().default(4).describe('Max learned pattern results to return'),
            minScore: z.number().optional().default(0.25).describe('Minimum similarity score threshold (0-1)'),
        }),
    },
    async ({ query, codeK, gitK, memoryK, minScore }) => {
        const brainbank = await getBrainBank();
        const results = await brainbank.search(query, { codeK, gitK, memoryK, minScore });

        if (results.length === 0) {
            return { content: [{ type: 'text', text: 'No results found for this query.' }] };
        }

        const lines: string[] = [];
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
            } else if (r.type === 'pattern') {
                const m = r.metadata;
                lines.push(`[PATTERN ${score}%] ${m.taskType} — ${Math.round(m.successRate * 100)}% success`);
                lines.push(`  Task: ${m.task}`);
                lines.push(`  Approach: ${r.content}`);
                lines.push('');
            }
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
);

// ── Tool: brainbank_context ────────────────────────────

server.registerTool(
    'brainbank_context',
    {
        title: 'BrainBank Context',
        description: 'Get a formatted knowledge context block for a task. Returns relevant code snippets, git history, co-edit patterns, and learned strategies as markdown. Perfect for enriching your understanding before working on a task.',
        inputSchema: z.object({
            task: z.string().describe('Description of the task you need context for'),
            affectedFiles: z.array(z.string()).optional().default([]).describe('Files you plan to modify (improves co-edit suggestions)'),
            codeResults: z.number().optional().default(6).describe('Max code results'),
            gitResults: z.number().optional().default(5).describe('Max git commit results'),
        }),
    },
    async ({ task, affectedFiles, codeResults, gitResults }) => {
        const brainbank = await getBrainBank();
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
        }),
    },
    async ({ forceReindex, gitDepth }) => {
        const brainbank = await getBrainBank();
        const result = await brainbank.index({ forceReindex, gitDepth });

        const lines = [
            '## Indexing Complete',
            '',
            `**Code**: ${result.code.indexed} files indexed, ${result.code.skipped} skipped, ${result.code.chunks ?? 0} chunks`,
            `**Git**: ${result.git.indexed} commits indexed, ${result.git.skipped} skipped`,
        ];

        const stats = brainbank.stats();
        lines.push('');
        lines.push(`**Totals**: ${stats.code.chunks} code chunks, ${stats.git.commits} commits, ${stats.memory.patterns} patterns`);

        return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
);

// ── Tool: brainbank_learn ──────────────────────────────

server.registerTool(
    'brainbank_learn',
    {
        title: 'BrainBank Learn',
        description: 'Store a learned pattern from a completed task. This builds the agent knowledge base over time, so future tasks can benefit from past experience. Always call this after completing a task successfully.',
        inputSchema: z.object({
            taskType: z.string().describe('Category: api, refactor, debug, feature, test, docs, etc'),
            task: z.string().describe('What was the task'),
            approach: z.string().describe('How it was approached and solved'),
            outcome: z.string().optional().describe('What happened / final result'),
            successRate: z.number().min(0).max(1).describe('How successful was this approach (0.0 to 1.0)'),
            critique: z.string().optional().describe('What could be done better next time'),
        }),
    },
    async ({ taskType, task, approach, outcome, successRate, critique }) => {
        const brainbank = await getBrainBank();
        const id = await brainbank.learn({
            taskType, task, approach, outcome, successRate, critique,
        });

        return {
            content: [{
                type: 'text',
                text: `✓ Pattern #${id} stored (${taskType}, ${Math.round(successRate * 100)}% success)`,
            }],
        };
    },
);

// ── Tool: brainbank_stats ──────────────────────────────

server.registerTool(
    'brainbank_stats',
    {
        title: 'BrainBank Stats',
        description: 'Get statistics about the indexed knowledge base: file count, code chunks, git commits, learned patterns, HNSW index sizes.',
        inputSchema: z.object({}),
    },
    async () => {
        const brainbank = await getBrainBank();
        const s = brainbank.stats();

        const lines = [
            '## BrainBank Knowledge Base Stats',
            '',
            '### Code',
            `- Files indexed: ${s.code.files}`,
            `- Code chunks: ${s.code.chunks}`,
            `- HNSW vectors: ${s.code.hnswSize}`,
            '',
            '### Git History',
            `- Commits indexed: ${s.git.commits}`,
            `- Files tracked: ${s.git.filesTracked}`,
            `- Co-edit pairs: ${s.git.coEdits}`,
            `- HNSW vectors: ${s.git.hnswSize}`,
            '',
            '### Agent Memory',
            `- Learned patterns: ${s.memory.patterns}`,
            `- Average success rate: ${Math.round(s.memory.avgSuccess * 100)}%`,
            `- HNSW vectors: ${s.memory.hnswSize}`,
        ];

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
        }),
    },
    async ({ filePath, limit }) => {
        const brainbank = await getBrainBank();
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
        }),
    },
    async ({ filePath, limit }) => {
        const brainbank = await getBrainBank();
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
        description: 'Best quality search: combines semantic vector search + BM25 keyword search using Reciprocal Rank Fusion. Catches both exact keyword matches ("express-rate-limit") AND conceptual similarities ("error handling patterns"). Use this by default for all searches.',
        inputSchema: z.object({
            query: z.string().describe('Search query — works with both keywords and natural language'),
            codeK: z.number().optional().default(8).describe('Max code results to return'),
            gitK: z.number().optional().default(5).describe('Max git commit results to return'),
            memoryK: z.number().optional().default(4).describe('Max learned pattern results to return'),
        }),
    },
    async ({ query, codeK, gitK, memoryK }) => {
        const brainbank = await getBrainBank();
        const results = await brainbank.hybridSearch(query, { codeK, gitK, memoryK });

        if (results.length === 0) {
            return { content: [{ type: 'text', text: 'No results found for this query.' }] };
        }

        return { content: [{ type: 'text', text: formatResults(results, 'Hybrid Search (Vector + BM25 → RRF)') }] };
    },
);

// ── Tool: brainbank_keyword_search ────────────────────

server.registerTool(
    'brainbank_keyword_search',
    {
        title: 'BrainBank Keyword Search',
        description: 'Instant BM25 keyword search (no embedding computation needed). Best for exact terms, function names, variable names, error messages, and specific identifiers. Uses Porter stemming for flexible matching.',
        inputSchema: z.object({
            query: z.string().describe('Keywords to search for (e.g. function names, error messages, exact terms)'),
            codeK: z.number().optional().default(8).describe('Max code results to return'),
            gitK: z.number().optional().default(5).describe('Max git commit results to return'),
            memoryK: z.number().optional().default(4).describe('Max learned pattern results to return'),
        }),
    },
    async ({ query, codeK, gitK, memoryK }) => {
        const brainbank = await getBrainBank();
        const results = brainbank.searchBM25(query, { codeK, gitK, memoryK });

        if (results.length === 0) {
            return { content: [{ type: 'text', text: 'No keyword matches found.' }] };
        }

        return { content: [{ type: 'text', text: formatResults(results, 'Keyword Search (BM25)') }] };
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
        } else if (r.type === 'pattern') {
            const m = r.metadata;
            lines.push(`[PATTERN ${score}%] ${m.taskType} — ${Math.round(m.successRate * 100)}% success`);
            lines.push(`  Task: ${m.task}`);
            lines.push(`  Approach: ${r.content}`);
            lines.push('');
        }
    }
    return lines.join('\n');
}

// ── Tool: brainbank_remember ──────────────────────────

server.registerTool(
    'brainbank_remember',
    {
        title: 'BrainBank Remember',
        description: 'Store a conversation digest for long-term memory. Call this at the end of each conversation to save what was discussed, decided, and learned. The digest is embedded and indexed for future retrieval via brainbank_recall.',
        inputSchema: z.object({
            title: z.string().describe('Short title summarizing the conversation (e.g. "Added BM25 hybrid search")'),
            summary: z.string().describe('2-3 sentence summary of what happened'),
            decisions: z.array(z.string()).optional().default([]).describe('Key decisions made during the conversation'),
            filesChanged: z.array(z.string()).optional().default([]).describe('Files that were created or modified'),
            patterns: z.array(z.string()).optional().default([]).describe('What worked, what to remember for next time'),
            openQuestions: z.array(z.string()).optional().default([]).describe('Unresolved questions or follow-up items'),
            tags: z.array(z.string()).optional().default([]).describe('Tags for categorization (e.g. "search", "auth", "refactor")'),
        }),
    },
    async ({ title, summary, decisions, filesChanged, patterns, openQuestions, tags }) => {
        const brainbank = await getBrainBank();
        const id = await brainbank.remember({
            title, summary, decisions, filesChanged, patterns, openQuestions, tags,
        });

        return {
            content: [{
                type: 'text',
                text: `✓ Conversation memory #${id} stored: "${title}"\n\nThis memory is now searchable via brainbank_recall.`,
            }],
        };
    },
);

// ── Tool: brainbank_recall ────────────────────────────

server.registerTool(
    'brainbank_recall',
    {
        title: 'BrainBank Recall',
        description: 'Search conversation memories to find relevant past context. Use this at the START of a conversation to check if there are relevant past discussions about the current topic. Returns structured digests with decisions, patterns, and files from previous conversations.',
        inputSchema: z.object({
            query: z.string().describe('What you want to recall (e.g. "authentication changes", "database refactoring")'),
            k: z.number().optional().default(5).describe('Max memories to return'),
            mode: z.enum(['hybrid', 'vector', 'keyword']).optional().default('hybrid').describe('Search mode: hybrid (best), vector (semantic), or keyword (exact)'),
        }),
    },
    async ({ query, k, mode }) => {
        const brainbank = await getBrainBank();
        const memories = await brainbank.recall(query, { k, mode: mode as any });

        if (memories.length === 0) {
            return { content: [{ type: 'text', text: 'No relevant conversation memories found.' }] };
        }

        const lines = ['## Recalled Conversation Memories', ''];
        for (const m of memories) {
            const score = Math.round((m.score ?? 0) * 100);
            const date = new Date(m.createdAt * 1000).toISOString().split('T')[0];
            lines.push(`### [${score}%] ${m.title} *(${date}, ${m.tier})*`);
            lines.push(m.summary);
            if (m.decisions?.length) lines.push(`**Decisions:** ${m.decisions.join('; ')}`);
            if (m.filesChanged?.length) lines.push(`**Files:** ${m.filesChanged.join(', ')}`);
            if (m.patterns?.length) lines.push(`**Patterns:** ${m.patterns.join('; ')}`);
            if (m.openQuestions?.length) lines.push(`**Open:** ${m.openQuestions.join('; ')}`);
            lines.push('');
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
);

// ── Start Server ────────────────────────────────────

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main().catch(err => {
    console.error(`BrainBank MCP Server Error: ${err.message}`);
    process.exit(1);
});

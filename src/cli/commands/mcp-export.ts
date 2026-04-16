/**
 * brainbank mcp:export [target] — Export MCP server config for AI IDEs.
 *
 * Generates the MCP server config block for brainbank and merges it into
 * the target IDE's config file. Currently supports: antigravity.
 *
 * Detects: node path, cli.js path, API keys from config or env vars.
 */

import type { ProjectConfig } from '@/cli/factory/config-loader.ts';

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { c, args, getFlag } from '@/cli/utils.ts';
import { getConfig } from '@/cli/factory/index.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Supported export targets and their config file paths. */
const TARGETS: Record<string, { configPath: string; label: string }> = {
    antigravity: {
        configPath: path.join(process.env.HOME ?? '~', '.gemini', 'antigravity', 'mcp_config.json'),
        label: 'Gemini Antigravity',
    },
};

interface McpServerConfig {
    command: string;
    args: string[];
    env?: Record<string, string>;
    cwd?: string;
}

interface McpConfig {
    mcpServers: Record<string, McpServerConfig>;
}

/**
 * Build the brainbank MCP server config block.
 * Resolves node binary, dist/cli.js path, and API keys.
 */
function buildBrainbankMcpBlock(config: ProjectConfig | null): McpServerConfig {
    const nodeBin = process.execPath;

    // Resolve dist/cli.js from the global install location (node_prefix/lib/node_modules/brainbank/dist/cli.js)
    const globalCliJs = path.join(path.dirname(nodeBin), '..', 'lib', 'node_modules', 'brainbank', 'dist', 'cli.js');
    // Fallback: relative to this file (dev / npm link)
    const localCliJs = path.resolve(__dirname, '..', '..', 'dist', 'cli.js');
    const resolvedCliJs = fs.existsSync(globalCliJs) ? globalCliJs : localCliJs;

    const env: Record<string, string> = {};

    // Resolve API keys: config.keys > env vars
    const keys = config?.keys;
    const perplexityKey = keys?.perplexity ?? process.env.PERPLEXITY_API_KEY;
    const anthropicKey = keys?.anthropic ?? process.env.ANTHROPIC_API_KEY;
    const openaiKey = keys?.openai ?? process.env.OPENAI_API_KEY;

    if (perplexityKey) env.PERPLEXITY_API_KEY = perplexityKey;
    if (anthropicKey) env.ANTHROPIC_API_KEY = anthropicKey;
    if (openaiKey) env.OPENAI_API_KEY = openaiKey;

    const block: McpServerConfig = {
        command: nodeBin,
        args: ['--disable-warning=ExperimentalWarning', resolvedCliJs, 'mcp'],
    };

    if (Object.keys(env).length > 0) {
        block.env = env;
    }

    return block;
}

/**
 * Load existing MCP config, merge brainbank entry, and write back.
 * Preserves all other server entries.
 */
function mergeAndWrite(targetPath: string, block: McpServerConfig): { created: boolean } {
    let existing: McpConfig = { mcpServers: {} };
    const created = !fs.existsSync(targetPath);

    if (!created) {
        try {
            const raw = fs.readFileSync(targetPath, 'utf-8');
            existing = JSON.parse(raw) as McpConfig;
            if (!existing.mcpServers) existing.mcpServers = {};
        } catch {
            // Corrupt or empty file — start fresh
            existing = { mcpServers: {} };
        }
    }

    existing.mcpServers.brainbank = block;

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, JSON.stringify(existing, null, 2) + '\n');

    return { created };
}

/** Check if an MCP config already has a brainbank entry. */
export function hasBrainbankMcpEntry(targetPath: string): boolean {
    if (!fs.existsSync(targetPath)) return false;
    try {
        const raw = fs.readFileSync(targetPath, 'utf-8');
        const config = JSON.parse(raw) as McpConfig;
        return !!config.mcpServers?.brainbank;
    } catch {
        return false;
    }
}

/** Auto-export: called after index when Antigravity is detected. */
export async function autoExportMcp(repoPath: string): Promise<void> {
    const target = TARGETS.antigravity;
    if (!target) return;

    // Only auto-export if Antigravity dir exists
    const antigravityDir = path.dirname(target.configPath);
    if (!fs.existsSync(antigravityDir)) return;

    // Only auto-export if brainbank isn't already configured
    if (hasBrainbankMcpEntry(target.configPath)) return;

    const config = await getConfig(repoPath);
    const block = buildBrainbankMcpBlock(config);
    mergeAndWrite(target.configPath, block);
    console.log(`  ${c.green('✓')} Exported MCP config to ${c.dim(path.relative(process.env.HOME ?? '', target.configPath))}`);
}

/** CLI command: brainbank mcp:export [target] */
export async function cmdMcpExport(): Promise<void> {
    const targetName = args[1] || getFlag('target') || 'antigravity';
    const repoPath = getFlag('repo') || '.';

    const target = TARGETS[targetName];
    if (!target) {
        console.error(c.red(`Unknown export target: ${targetName}`));
        console.error(c.dim(`  Available: ${Object.keys(TARGETS).join(', ')}`));
        process.exit(1);
    }

    const config = await getConfig(repoPath);
    const block = buildBrainbankMcpBlock(config);
    const { created } = mergeAndWrite(target.configPath, block);

    console.log(c.bold(`\n━━━ MCP Export: ${target.label} ━━━\n`));
    console.log(`  ${c.green('✓')} ${created ? 'Created' : 'Updated'} ${c.dim(target.configPath)}`);
    console.log(`  ${c.dim('Node:')}    ${block.command}`);
    const cliPath = block.args.find(a => !a.startsWith('--')) ?? block.args[0];
    console.log(`  ${c.dim('CLI:')}     ${cliPath}`);

    const envKeys = block.env ? Object.keys(block.env) : [];
    if (envKeys.length > 0) {
        console.log(`  ${c.dim('Keys:')}    ${envKeys.join(', ')}`);
    } else {
        console.log(`  ${c.yellow('⚠')} No API keys found. Set env vars or add keys to .brainbank/config.json`);
    }

    console.log(`\n  ${c.dim('Restart your IDE to apply changes.')}\n`);
}

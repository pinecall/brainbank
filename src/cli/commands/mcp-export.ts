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

// ── GEMINI.md BrainBank Section ──────────────────────────────

const BRAINBANK_SECTION_MARKER = '<!-- brainbank:start -->';
const BRAINBANK_SECTION_END = '<!-- brainbank:end -->';

/** Global GEMINI.md path — ~/.gemini/GEMINI.md (shared across all projects). */
const GLOBAL_GEMINI = path.join(process.env.HOME ?? '~', '.gemini', 'GEMINI.md');

function buildGeminiSection(): string {
    return `${BRAINBANK_SECTION_MARKER}

## BrainBank — Code Intelligence

When \`brainbank_context\` and \`brainbank_files\` MCP tools are available, **always use them instead of \`grep_search\` or \`list_dir\`**.

**\`brainbank_context\`** — semantic search. Use \`path:\` to scope, \`compact: false\`, \`sources: { code: 25, docs: 0, git: 0 }\`.

**\`brainbank_files\`** — read full indexed files (\`lines: true\` always). Only works with files tracked by the index — for \`.env\`, \`docker-compose.yml\`, etc. use \`view_file\`.

**Sources rule:** Default to code-only (\`docs: 0\`). Only add \`docs\` when the user explicitly asks about documentation. Never mix code and docs in the same query — fire separate queries.

### Output handling (critical)

BrainBank may return results **inline** or save them to an **output file**:

- **Inline:** read and proceed normally.
- **File result** (saved to \`output.txt\`): show the path as a clickable link, ask user to paste, then **STOP and WAIT**:

  📋 Output: [output.txt](file:///path/to/output.txt) — _"Could you paste the context output here?"_

  Do **NOT** read the file yourself. Wait for the paste before proceeding.

${BRAINBANK_SECTION_END}
`;
}

/** Check if GEMINI.md already has the brainbank section. */
function hasGeminiSection(geminiPath: string): boolean {
    if (!fs.existsSync(geminiPath)) return false;
    const content = fs.readFileSync(geminiPath, 'utf-8');
    return content.includes(BRAINBANK_SECTION_MARKER);
}

/** Append BrainBank section to GEMINI.md (creates if doesn't exist). */
function appendGeminiSection(geminiPath: string): void {
    const section = buildGeminiSection();
    if (fs.existsSync(geminiPath)) {
        fs.appendFileSync(geminiPath, section);
    } else {
        fs.writeFileSync(geminiPath, `# GEMINI.md\n${section}`);
    }
}

/** Replace BrainBank section between markers in GEMINI.md. */
function replaceGeminiSection(geminiPath: string): void {
    const content = fs.readFileSync(geminiPath, 'utf-8');
    const startIdx = content.indexOf(BRAINBANK_SECTION_MARKER);
    const endIdx = content.indexOf(BRAINBANK_SECTION_END);
    if (startIdx === -1 || endIdx === -1) return;

    const before = content.slice(0, startIdx);
    const after = content.slice(endIdx + BRAINBANK_SECTION_END.length);
    const section = buildGeminiSection();
    fs.writeFileSync(geminiPath, before + section + after);
}

/** CLI command: brainbank mcp:export [target] */
export async function cmdMcpExport(): Promise<void> {
    const targetName = args[1] || getFlag('target') || 'antigravity';
    const repoPath = getFlag('repo') || '.';
    const { confirm } = await import('@inquirer/prompts');

    const target = TARGETS[targetName];
    if (!target) {
        console.error(c.red(`Unknown export target: ${targetName}`));
        console.error(c.dim(`  Available: ${Object.keys(TARGETS).join(', ')}`));
        process.exit(1);
    }

    const config = await getConfig(repoPath);
    const block = buildBrainbankMcpBlock(config);

    console.log(c.bold(`\n━━━ MCP Export: ${target.label} ━━━\n`));

    // ── MCP Config ────────────────────────────────────────────
    const mcpExists = hasBrainbankMcpEntry(target.configPath);
    let writeMcp = true;

    if (mcpExists) {
        console.log(`  ${c.yellow('●')} MCP config already has brainbank entry`);
        const cliPath = block.args.find(a => !a.startsWith('--')) ?? block.args[0];
        console.log(`  ${c.dim('  New:')} ${block.command} ${cliPath}`);
        const envKeys = block.env ? Object.keys(block.env) : [];
        if (envKeys.length > 0) console.log(`  ${c.dim('  Keys:')} ${envKeys.join(', ')}`);
        writeMcp = await confirm({ message: 'Override existing brainbank MCP entry?', default: true });
    }

    if (writeMcp) {
        const { created } = mergeAndWrite(target.configPath, block);
        console.log(`  ${c.green('✓')} ${created ? 'Created' : 'Updated'} ${c.dim(target.configPath)}`);
    } else {
        console.log(`  ${c.dim('MCP config — skipped')}`);
    }

    // ── Global GEMINI.md (~/.gemini/GEMINI.md) ────────────────
    const geminiHasSection = hasGeminiSection(GLOBAL_GEMINI);

    if (geminiHasSection) {
        console.log(`  ${c.yellow('●')} ~/.gemini/GEMINI.md already has BrainBank section`);
        const override = await confirm({ message: 'Override existing BrainBank section?', default: false });
        if (override) {
            replaceGeminiSection(GLOBAL_GEMINI);
            console.log(`  ${c.green('✓')} Replaced BrainBank section in ${c.dim('~/.gemini/GEMINI.md')}`);
        } else {
            console.log(`  ${c.dim('GEMINI.md — skipped')}`);
        }
    } else {
        const addGemini = await confirm({
            message: 'Add BrainBank instructions to ~/.gemini/GEMINI.md? (teaches AI tools how to use BrainBank)',
            default: true,
        });
        if (addGemini) {
            appendGeminiSection(GLOBAL_GEMINI);
            console.log(`  ${c.green('✓')} Added BrainBank section to ${c.dim('~/.gemini/GEMINI.md')}`);
        }
    }

    console.log(`\n  ${c.dim('Restart your IDE to apply changes.')}\n`);
}

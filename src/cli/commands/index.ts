/**
 * brainbank index [path] — Interactive scan → select → index
 *
 * Scans the repo first, shows a summary tree, and prompts the user
 * with checkboxes to select which modules to index. Use --yes to skip.
 */

import type { ScanResult, ScanModule } from './scan.ts';

import * as fs from 'node:fs';
import * as path from 'node:path';
import { c, args, getFlag, hasFlag, stripFlags } from '@/cli/utils.ts';
import { createBrain, getConfig, registerConfigCollections } from '@/cli/factory/index.ts';
import { findDocsPlugin } from '@/cli/utils.ts';
import { autoExportMcp } from './mcp-export.ts';
import { scanRepo } from './scan.ts';

export async function cmdIndex(): Promise<void> {
    const positional = stripFlags(args);
    const repoPath = positional[1] || '.';
    const force = hasFlag('force');
    const depth = parseInt(getFlag('depth') || '500', 10);
    const onlyRaw = getFlag('only');
    const docsPath = getFlag('docs');
    const skipPrompt = hasFlag('yes') || hasFlag('y');


    const scan = scanRepo(repoPath);
    printScanTree(scan, depth);


    let modules: string[];

    if (onlyRaw) {
        // --only flag: explicit module selection
        modules = onlyRaw.split(',').map(s => s.trim());
    } else if (scan.config.plugins && scan.config.plugins.length > 0) {
        // Config exists with plugins field — use it as source of truth
        modules = scan.config.plugins;
        console.log(c.dim(`\n  Using config: plugins = [${modules.join(', ')}]\n`));
    } else if (skipPrompt) {
        modules = buildDefaultModules(scan);
    } else {
        modules = await promptModules(scan);
        if (modules.length === 0) {
            console.log(c.dim('\n  Nothing selected. Exiting.\n'));
            return;
        }

        // Clean screen and show selection summary
        console.clear();
        console.log(c.bold('\n━━━ BrainBank ━━━\n'));
        console.log('  Selected modules:');
        for (const m of modules) {
            console.log(`    ${c.green('✓')} ${m}`);
        }
        console.log('');
    }

    // If --docs is passed, auto-include 'docs' in modules
    if (docsPath && !modules.includes('docs')) {
        modules.push('docs');
    }

    // Auto-generate config.json if it doesn't exist yet
    if (!scan.config.exists && !skipPrompt) {
        await saveConfig(scan.repoPath, modules);
    }


    console.log(c.bold(`\n━━━ Indexing: ${modules.join(', ')} ━━━`));

    const brain = await createBrain(repoPath);
    await brain.initialize();

    const config = await getConfig(repoPath);
    await registerConfigCollections(brain, repoPath, config);

    if (docsPath) {
        const absDocsPath = path.resolve(docsPath);
        const collName = path.basename(absDocsPath);
        try {
            const docsPlugin = findDocsPlugin(brain);
            await docsPlugin?.addCollection({
                name: collName,
                path: absDocsPath,
                pattern: '**/*.md',
                ignore: ['deprecated/**', 'node_modules/**'],
            });
            console.log(c.dim(`  Registered docs collection: ${collName}`));
        } catch {
            console.log(c.yellow(`  Warning: docs module not loaded, skipping --docs`));
        }
    }

    const result = await brain.index({
        modules,
        forceReindex: force,
        pluginOptions: { depth },
        onProgress: (stage, msg) => {
            process.stdout.write(`\r  ${c.cyan(stage.toUpperCase())} ${msg}                    `);
        },
    });

    console.log('\n');
    for (const [name, value] of Object.entries(result)) {
        if (!value) continue;
        const v = value as Record<string, unknown>;
        if (typeof v.indexed === 'number') {
            const parts = [`${v.indexed} indexed`, `${v.skipped ?? 0} skipped`];
            if (typeof v.chunks === 'number') parts.push(`${v.chunks} chunks`);
            if (typeof v.removed === 'number' && v.removed > 0) parts.push(`${v.removed} removed`);
            console.log(`  ${c.green(name)}: ${parts.join(', ')}`);
        } else {
            console.log(`  ${c.green(name)}: done`);
        }
    }

    const stats = brain.stats();
    console.log(`\n  ${c.bold('Totals')}:`);
    for (const [name, s] of Object.entries(stats)) {
        if (!s || typeof s !== 'object') continue;
        const entries = Object.entries(s as Record<string, unknown>)
            .map(([k, v]) => `${k}: ${v}`)
            .join(', ');
        console.log(`    ${name}: ${entries}`);
    }

    brain.close();

    // Auto-export MCP config to Antigravity if detected and not already configured
    await autoExportMcp(repoPath);
}


function printScanTree(scan: ScanResult, depth: number): void {
    console.clear();
    console.log(c.bold('\n━━━ BrainBank Scan ━━━'));
    console.log(c.dim(`  Repo: ${scan.repoPath}`));

    // Multi-repo detection
    if (scan.gitSubdirs.length > 0) {
        console.log(c.cyan(`\n  🔀 Multi-repo — ${scan.gitSubdirs.length} git repos detected`));
        for (const sub of scan.gitSubdirs) {
            console.log(c.dim(`     └── ${sub.name}`));
        }
    }

    // Dynamic module display
    for (const mod of scan.modules) {
        console.log('');
        if (mod.available) {
            const extra = mod.name === 'git' ? ` (depth: ${depth})` : '';
            console.log(`  ${mod.icon} ${c.bold(capitalizeFirst(mod.name))} — ${mod.summary}${extra}`);
            if (mod.details) {
                for (const d of mod.details) {
                    console.log(c.dim(`     ${d}`));
                }
            }
        } else {
            console.log(`  ${mod.icon} ${c.dim(`${capitalizeFirst(mod.name)} — ${mod.summary}`)}`);
        }
    }

    // Config ignore
    if (scan.config.ignore?.length) {
        console.log(c.dim(`     Ignore: ${scan.config.ignore.join(', ')}`));
    }

    // Config & DB
    console.log('');
    if (scan.config.exists) {
        console.log(`  ⚙️  ${c.dim('Config:')} .brainbank/config.json ${c.green('✓')}`);
    }
    if (scan.db?.exists) {
        const ago = scan.db.lastModified ? timeSince(scan.db.lastModified) : '';
        console.log(`  💾 ${c.dim('DB:')} ${scan.db.sizeMB} MB${ago ? `, last indexed ${ago}` : ''}`);
    } else {
        console.log(`  💾 ${c.dim('DB: new (first index)')}`);
    }
    console.log('');
}


/** Build the default list of available modules based on scan. */
function buildDefaultModules(scan: ScanResult): string[] {
    return scan.modules.filter(m => m.available && m.checked).map(m => m.name);
}

/** Interactive checkbox prompt via @inquirer/prompts. */
async function promptModules(scan: ScanResult): Promise<string[]> {
    const { checkbox } = await import('@inquirer/prompts');
    console.log(c.dim('  ─────────────────────────────────────────\n'));

    const choices = scan.modules.map((m: ScanModule) => ({
        name: `${capitalizeFirst(m.name).padEnd(6)} — ${m.summary}`,
        value: m.name,
        checked: m.checked && m.available,
        disabled: m.available ? undefined : m.disabled,
    }));

    return checkbox<string>({
        message: 'Select modules to index:\n',
        choices,
    });
}


function timeSince(date: Date): string {
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}

/** Capitalize first letter. */
function capitalizeFirst(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Generate .brainbank/config.json from the selected modules. */
async function saveConfig(repoPath: string, modules: string[]): Promise<void> {
    const { select, confirm } = await import('@inquirer/prompts');

    // Embedding provider selection
    const envEmbedding = process.env.BRAINBANK_EMBEDDING;
    const embedding = await select<string>({
        message: 'Embedding provider:',
        choices: [
            {
                name: 'perplexity-context  — best accuracy (recommended)',
                value: 'perplexity-context',
            },
            {
                name: 'perplexity          — fast, high quality',
                value: 'perplexity',
            },
            {
                name: 'openai              — text-embedding-3-small',
                value: 'openai',
            },
            {
                name: 'local               — offline, no API key needed',
                value: 'local',
            },
        ],
        default: envEmbedding ?? 'perplexity-context',
    });

    // Pruner selection
    const pruner = await select<string>({
        message: 'Noise pruner:',
        choices: [
            {
                name: 'haiku  — AI-powered noise filter (recommended)',
                value: 'haiku',
            },
            {
                name: 'none   — no pruning',
                value: 'none',
            },
        ],
        default: 'haiku',
    });

    const configDir = path.join(repoPath, '.brainbank');
    const configPath = path.join(configDir, 'config.json');

    const config: Record<string, unknown> = {
        plugins: modules,
        embedding,
    };

    if (pruner !== 'none') {
        config.pruner = pruner;
    }

    // Key management: detect available keys and offer to save
    const detectedKeys: Record<string, string> = {};
    const needsPerplexity = embedding.startsWith('perplexity');
    const needsAnthropic = pruner === 'haiku';
    const needsOpenai = embedding === 'openai';

    if (needsPerplexity && process.env.PERPLEXITY_API_KEY) {
        detectedKeys.perplexity = process.env.PERPLEXITY_API_KEY;
    }
    if (needsAnthropic && process.env.ANTHROPIC_API_KEY) {
        detectedKeys.anthropic = process.env.ANTHROPIC_API_KEY;
    }
    if (needsOpenai && process.env.OPENAI_API_KEY) {
        detectedKeys.openai = process.env.OPENAI_API_KEY;
    }

    if (Object.keys(detectedKeys).length > 0) {
        const keyNames = Object.keys(detectedKeys).join(', ');
        const saveKeys = await confirm({
            message: `Save API keys (${keyNames}) to config.json? (portable, no env vars needed)`,
            default: true,
        });
        if (saveKeys) {
            config.keys = detectedKeys;
        }
    }

    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
    console.log(c.green(`  ✓ Saved ${path.relative(process.cwd(), configPath)}`));
}


/**
 * brainbank index [path] — Interactive scan → select → index
 *
 * Scans the repo first, shows an interactive TUI with directory tree
 * for folder selection, then indexes. Use --yes to skip the TUI.
 */

import type { ScanResult, ScanModule } from './scan.ts';
import type { PreviewLine } from '@/cli/tui/tree-scanner.ts';

import * as fs from 'node:fs';
import * as path from 'node:path';
import { c, args, getFlag, hasFlag, stripFlags } from '@/cli/utils.ts';
import { createBrain, getConfig, registerConfigCollections, contextFromCLI } from '@/cli/factory/index.ts';
import { discoverExternalPlugins } from '@/cli/factory/plugin-loader.ts';
import { findDocsPlugin } from '@/cli/utils.ts';
import { autoExportMcp } from './mcp-export.ts';
import { scanRepo } from './scan.ts';
import { runIndexTui } from '@/cli/tui/index-tui.tsx';

export async function cmdIndex(): Promise<void> {
    const positional = stripFlags(args);
    const repoPath = positional[1] || '.';
    const force = hasFlag('force');
    const depth = parseInt(getFlag('depth') || '500', 10);
    const onlyRaw = getFlag('only');
    const docsPath = getFlag('docs');
    const skipPrompt = hasFlag('yes') || hasFlag('y');
    const forceSetup = hasFlag('setup');


    const scan = scanRepo(repoPath);

    // Discover external (non-built-in) plugins from config and .brainbank/plugins/
    const configPlugins = scan.config.plugins ?? [];
    const externalDiscovery = await discoverExternalPlugins(repoPath, configPlugins);
    let externalPreviews: Map<string, PreviewLine[]> = externalDiscovery.previews;

    // Merge external modules into scan result
    if (externalDiscovery.modules.length > 0) {
        scan.modules = [...scan.modules, ...externalDiscovery.modules];
    }

    let modules: string[];
    let tuiInclude: string[] = [];
    let tuiIgnore: string[] = [];
    let tuiConfig: { embedding: string; pruner: string; expander: string } | undefined;

    if (onlyRaw) {
        // --only flag: explicit module selection
        printIndexHeader(scan, depth);
        modules = onlyRaw.split(',').map(s => s.trim());
    } else if (scan.config.plugins && scan.config.plugins.length > 0 && !forceSetup) {
        // Config exists with plugins field — skip TUI, index directly
        printIndexHeader(scan, depth);
        modules = scan.config.plugins;
    } else if (skipPrompt) {
        printIndexHeader(scan, depth);
        modules = buildDefaultModules(scan);
    } else {
        // ── Interactive TUI ──
        const selection = await runIndexTui(scan, externalPreviews);
        if (!selection) {
            console.log(c.dim('\n  Cancelled. Exiting.\n'));
            return;
        }
        modules = selection.modules;
        tuiInclude = selection.include;
        tuiIgnore = selection.ignore;
        tuiConfig = selection.config;

        if (modules.length === 0) {
            console.log(c.dim('\n  Nothing selected. Exiting.\n'));
            return;
        }

        // ── Deindex removed modules ──
        const oldPlugins = scan.config.plugins ?? [];
        const removed = oldPlugins.filter(p => !modules.includes(p));
        if (removed.length > 0) {
            console.log(c.bold('\n━━━ Deindexing ━━━\n'));
            for (const mod of removed) {
                console.log(`  ${c.yellow('✗')} Removing ${mod} data...`);
                deindexModule(scan.repoPath, mod);
                console.log(`  ${c.green('✓')} ${mod} data cleared`);
            }
        }

        // Show selection summary
        console.log(c.bold('\n━━━ BrainBank ━━━\n'));
        console.log('  Selected modules:');
        for (const m of modules) {
            console.log(`    ${c.green('✓')} ${m}`);
        }
        if (tuiInclude.length > 0) {
            console.log(`  Include: ${c.cyan(tuiInclude.join(', '))}`);
        }
        if (tuiIgnore.length > 0) {
            console.log(`  Ignore: ${c.yellow(tuiIgnore.join(', '))}`);
        }
        console.log('');
    }

    // If --docs is passed, auto-include 'docs' in modules
    if (docsPath && !modules.includes('docs')) {
        modules.push('docs');
    }

    // Save config from TUI selection — only when TUI actually ran
    // NEVER rewrite config on headless runs (existing config + no --setup)
    if (tuiConfig) {
        // New config (first run) — save everything
        saveConfigFromTui(scan.repoPath, modules, tuiConfig.embedding, tuiConfig.pruner, tuiConfig.expander, tuiInclude, tuiIgnore);
    } else if (tuiInclude.length > 0 || tuiIgnore.length > 0) {
        // TUI ran with existing config and user changed selections — update patterns only
        updateConfigPlugins(scan.repoPath, modules, tuiInclude, tuiIgnore);
    }
    // If neither condition is true, config already exists and TUI didn't run — don't touch it


    console.log(c.bold(`\n━━━ Indexing: ${modules.join(', ')} ━━━`));

    // Build brain context, injecting TUI-selected include/ignore patterns
    const ctx = contextFromCLI(repoPath);
    if (tuiInclude.length > 0 && !ctx.flags?.include) {
        ctx.flags = { ...ctx.flags, include: tuiInclude.join(',') };
    }
    if (tuiIgnore.length > 0 && !ctx.flags?.ignore) {
        ctx.flags = { ...ctx.flags, ignore: tuiIgnore.join(',') };
    }
    const brain = await createBrain(ctx);
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

    // ── Changes summary ──
    console.log(c.bold('\n━━━ Changes ━━━\n'));
    let hasChanges = false;
    for (const [name, value] of Object.entries(result)) {
        if (!value) continue;
        const v = value as Record<string, unknown>;
        if (typeof v.indexed !== 'number') { console.log(`  ${c.green('✓')} ${name}: done`); continue; }

        const indexed = v.indexed as number;
        const skipped = (v.skipped ?? 0) as number;
        const removed = (v.removed ?? 0) as number;
        const chunks = (v.chunks ?? 0) as number;

        if (indexed > 0 || removed > 0) hasChanges = true;

        const parts: string[] = [];
        if (indexed > 0) parts.push(c.green(`+${indexed} files (${chunks} chunks)`));
        if (removed > 0) parts.push(c.red(`−${removed} files`));
        if (skipped > 0) parts.push(c.dim(`${skipped} unchanged`));

        console.log(`  ${c.bold(name)}: ${parts.join('  ')}`);
    }
    if (!hasChanges) {
        console.log(c.dim('  No changes — everything up to date'));
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


/** Compact header for headless (non-TUI) index runs. Validates include/ignore paths. */
function printIndexHeader(scan: ScanResult, _depth: number): void {
    console.log(c.bold('\n━━━ BrainBank ━━━'));
    console.log(c.dim(`  ${scan.repoPath}\n`));

    // Show plugins
    const plugins = scan.config.plugins ?? [];
    console.log(`  Plugins: ${c.cyan(plugins.join(', '))}`);

    // Validate and show include patterns
    if (scan.config.include?.length) {
        console.log('');
        for (const pattern of scan.config.include) {
            const exists = validatePattern(scan.repoPath, pattern);
            const icon = exists ? c.green('✓') : c.red('✗');
            const label = exists ? c.dim(pattern) : c.red(pattern);
            console.log(`  ${icon} ${label}`);
        }
    }

    // Validate and show ignore patterns
    if (scan.config.ignore?.length) {
        console.log('');
        console.log(c.dim('  Ignore:'));
        for (const pattern of scan.config.ignore) {
            console.log(`    ${c.yellow('─')} ${c.dim(pattern)}`);
        }
    }

    // DB info
    if (scan.db?.exists) {
        const ago = scan.db.lastModified ? timeSince(scan.db.lastModified) : '';
        console.log(c.dim(`\n  DB: ${scan.db.sizeMB} MB${ago ? `, last indexed ${ago}` : ''}`));
    }
    console.log('');
}

/** Check if a glob pattern's base directory exists on disk. */
function validatePattern(repoPath: string, pattern: string): boolean {
    // Strip trailing /** or /* or glob chars
    const base = pattern.replace(/\/\*\*$/, '').replace(/\/\*$/, '');
    const absPath = path.join(repoPath, base);
    try {
        fs.statSync(absPath);
        return true;
    } catch {
        return false;
    }
}


/** Build the default list of available modules based on scan. */
function buildDefaultModules(scan: ScanResult): string[] {
    return scan.modules.filter(m => m.available && m.checked).map(m => m.name);
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

/** Common doc folder names to auto-detect for docs plugin. */
const DOC_FOLDERS = ['docs', 'doc', 'wiki', 'documentation', 'guides', 'notes'];

/** Auto-detect document collections in a repo. Scans for common doc folders + README. */
function autoDetectDocCollections(repoPath: string): { name: string; path: string; pattern: string; context?: string }[] {
    const resolved = path.resolve(repoPath);
    const collections: { name: string; path: string; pattern: string; context?: string }[] = [];

    for (const folder of DOC_FOLDERS) {
        const absPath = path.join(resolved, folder);
        try {
            const stat = fs.statSync(absPath);
            if (stat.isDirectory()) {
                // Check it actually contains markdown files
                const entries = fs.readdirSync(absPath, { recursive: true }) as string[];
                const hasMd = entries.some(e => typeof e === 'string' && /\.md$/i.test(e));
                if (hasMd) {
                    collections.push({
                        name: folder,
                        path: folder,
                        pattern: '**/*.md',
                        context: `${folder} directory`,
                    });
                }
            }
        } catch {
            // Folder doesn't exist — skip
        }
    }

    return collections;
}

/** Save config.json from TUI selections (no interactive prompts). */
function saveConfigFromTui(
    repoPath: string, modules: string[], embedding: string, pruner: string, expander: string,
    include: string[], ignore: string[],
): void {
    const configDir = path.join(repoPath, '.brainbank');
    const configPath = path.join(configDir, 'config.json');

    const config: Record<string, unknown> = {
        plugins: modules,
        embedding,
    };

    if (pruner !== 'none') {
        config.pruner = pruner;
    }

    if (expander !== 'none') {
        config.expander = expander;
    }

    // Save include/ignore from tree selection
    if (include.length > 0) {
        config.include = include;
    }
    if (ignore.length > 0) {
        config.ignore = ignore;
    }

    // Auto-detect doc collections when docs plugin is selected
    if (modules.includes('docs')) {
        const collections = autoDetectDocCollections(repoPath);
        if (collections.length > 0) {
            config.docs = { collections };
            console.log(c.dim(`  Auto-detected docs: ${collections.map(dc => dc.name).join(', ')}`));
        }
    }

    // Auto-detect API keys from environment
    const detectedKeys: Record<string, string> = {};
    const needsPerplexity = embedding.startsWith('perplexity');
    const needsAnthropic = pruner === 'haiku' || expander === 'haiku';
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
        config.keys = detectedKeys;
    }

    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
    console.log(c.green(`  ✓ Saved ${path.relative(process.cwd(), configPath)}`));
}


/** Update plugins, include, and ignore in an existing config.json. */
function updateConfigPlugins(repoPath: string, modules: string[], include: string[], ignore: string[]): void {
    const configPath = path.join(repoPath, '.brainbank', 'config.json');
    try {
        const raw = fs.readFileSync(configPath, 'utf-8');
        const config = JSON.parse(raw) as Record<string, unknown>;
        config.plugins = modules;

        // Update include/ignore — set if present, remove if empty
        if (include.length > 0) {
            config.include = include;
        } else {
            delete config.include;
        }
        if (ignore.length > 0) {
            config.ignore = ignore;
        } else {
            delete config.ignore;
        }

        // Auto-detect doc collections when docs is newly added and none exist
        if (modules.includes('docs')) {
            const existing = config.docs as Record<string, unknown> | undefined;
            const hasCollections = existing && Array.isArray(existing.collections) && existing.collections.length > 0;
            if (!hasCollections) {
                const collections = autoDetectDocCollections(repoPath);
                if (collections.length > 0) {
                    config.docs = { ...(existing ?? {}), collections };
                    console.log(c.dim(`  Auto-detected docs: ${collections.map(dc => dc.name).join(', ')}`));
                }
            }
        }

        fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
        console.log(c.green(`  ✓ Updated config.json`));
    } catch {
        // Config doesn't exist or is corrupt — skip
    }
}


/**
 * Clear all indexed data for a specific module from the DB.
 * Opens the SQLite database directly and drops module-specific rows.
 */
function deindexModule(repoPath: string, moduleName: string): void {
    const dbPath = path.join(repoPath, '.brainbank', 'data', 'brainbank.db');
    if (!fs.existsSync(dbPath)) return;

    // Simple interface — we only need exec() and close()
    interface SimpleDB { exec(sql: string): void; close(): void }

    let db: SimpleDB | undefined;
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const sqlite = require('node:sqlite') as { DatabaseSync: new (path: string) => SimpleDB };
        db = new sqlite.DatabaseSync(dbPath);
    } catch {
        console.log(c.yellow(`    Could not open DB — skip deindex for ${moduleName}`));
        return;
    }

    if (!db) return;

    const tables: Record<string, string[]> = {
        code: [
            'DELETE FROM code_call_edges',
            'DELETE FROM code_refs',
            'DELETE FROM code_symbols',
            'DELETE FROM code_imports',
            'DELETE FROM code_vectors',
            'DELETE FROM code_chunks',
            'DELETE FROM indexed_files',
            "DELETE FROM plugin_tracking WHERE plugin = 'code'",
        ],
        docs: [
            'DELETE FROM doc_vectors',
            'DELETE FROM doc_chunks',
            'DELETE FROM path_contexts',
            'DELETE FROM collections',
            "DELETE FROM plugin_tracking WHERE plugin = 'docs'",
        ],
        git: [
            'DELETE FROM git_vectors',
            'DELETE FROM git_commits',
            "DELETE FROM plugin_tracking WHERE plugin = 'git'",
        ],
    };

    const statements = tables[moduleName];
    if (!statements) {
        console.log(c.dim(`    No known tables for ${moduleName}`));
        try { db.close(); } catch { /* ignore */ }
        return;
    }

    for (const sql of statements) {
        try { db.exec(sql); }
        catch { /* Table might not exist — that's fine */ }
    }

    try { db.close(); } catch { /* ignore */ }
}



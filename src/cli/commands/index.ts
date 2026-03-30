/**
 * brainbank index [path] — Interactive scan → select → index
 *
 * Scans the repo first, shows a summary tree, and prompts the user
 * with checkboxes to select which modules to index. Use --yes to skip.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { c, args, getFlag, hasFlag } from '@/cli/utils.ts';
import { createBrain, getConfig, registerConfigCollections } from '@/cli/factory/index.ts';
import { scanRepo, type ScanResult } from './scan.ts';

export async function cmdIndex(): Promise<void> {
    const repoPath = args[1] || '.';
    const force = hasFlag('force');
    const depth = parseInt(getFlag('depth') || '500', 10);
    const onlyRaw = getFlag('only');
    const docsPath = getFlag('docs');
    const skipPrompt = hasFlag('yes') || hasFlag('y');

    // ── Phase 1: Scan ──────────────────────────────

    const scan = scanRepo(repoPath);
    printScanTree(scan, depth);

    // ── Phase 2: Select modules ────────────────────

    let modules: ('code' | 'git' | 'docs')[];

    if (onlyRaw) {
        modules = onlyRaw.split(',').map(s => s.trim()) as typeof modules;
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

    // Offer to save config.json if it doesn't exist yet
    if (!scan.config.exists && !skipPrompt) {
        await offerSaveConfig(scan.repoPath, modules);
    }

    // ── Phase 3: Index ─────────────────────────────

    console.log(c.bold(`\n━━━ Indexing: ${modules.join(', ')} ━━━`));

    const brain = await createBrain(repoPath);

    const config = await getConfig();
    await registerConfigCollections(brain, config);

    if (docsPath) {
        const absDocsPath = path.resolve(docsPath);
        const collName = path.basename(absDocsPath);
        try {
            await brain.docs?.addCollection({
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
        gitDepth: depth,
        onProgress: (stage, msg) => {
            process.stdout.write(`\r  ${c.cyan(stage.toUpperCase())} ${msg}                    `);
        },
    });

    console.log('\n');
    if (result.code) {
        console.log(`  ${c.green('Code')}: ${result.code.indexed} indexed, ${result.code.skipped} skipped, ${result.code.chunks ?? 0} chunks`);
    }
    if (result.git) {
        console.log(`  ${c.green('Git')}:  ${result.git.indexed} indexed, ${result.git.skipped} skipped`);
    }
    if (result.docs) {
        for (const [name, stat] of Object.entries(result.docs)) {
            console.log(`  ${c.green('Docs')}: [${name}] ${stat.indexed} indexed, ${stat.skipped} skipped, ${stat.chunks} chunks`);
        }
    }

    const stats = brain.stats();
    console.log(`\n  ${c.bold('Totals')}:`);
    if (stats.code) console.log(`    Code chunks:  ${stats.code.chunks}`);
    if (stats.git) console.log(`    Git commits:  ${stats.git.commits}`);
    if (stats.git) console.log(`    Co-edit pairs: ${stats.git.coEdits}`);
    if (stats.documents) console.log(`    Documents:    ${stats.documents.documents}`);

    brain.close();
}

// ── Scan Tree Output ────────────────────────────────

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

    // Code
    console.log('');
    if (scan.code.total > 0) {
        const langCount = scan.code.byLanguage.size;
        console.log(`  📁 ${c.bold('Code')} — ${scan.code.total} files (${langCount} language${langCount > 1 ? 's' : ''})`);
        const sorted = [...scan.code.byLanguage.entries()].sort((a, b) => b[1] - a[1]);
        const maxShow = 7;
        const shown = sorted.slice(0, maxShow);
        const remaining = sorted.length - maxShow;
        for (let i = 0; i < shown.length; i++) {
            const [lang, count] = shown[i];
            const isLast = i === shown.length - 1 && remaining <= 0;
            const prefix = isLast ? '└──' : '├──';
            console.log(c.dim(`     ${prefix} ${lang.padEnd(14)} ${count} files`));
        }
        if (remaining > 0) {
            console.log(c.dim(`     └── ...and ${remaining} more`));
        }
        if (scan.config.ignore?.length) {
            console.log(c.dim(`     Ignore: ${scan.config.ignore.join(', ')}`));
        }
    } else {
        console.log(`  📁 ${c.dim('Code — no supported source files found')}`);
    }

    // Git
    if (scan.git) {
        console.log(`\n  📜 ${c.bold('Git')} — ${scan.git.commitCount.toLocaleString()} commits (depth: ${depth})`);
        if (scan.git.lastMessage) {
            console.log(c.dim(`     Last: ${scan.git.lastMessage} (${scan.git.lastDate})`));
        }
    } else {
        console.log(`\n  📜 ${c.dim('Git — no .git directory found')}`);
    }

    // Docs
    if (scan.docs.length > 0) {
        const totalFiles = scan.docs.reduce((s, d) => s + d.fileCount, 0);
        console.log(`\n  📄 ${c.bold('Docs')} — ${scan.docs.length} collection${scan.docs.length > 1 ? 's' : ''} (${totalFiles} files)`);
        for (let i = 0; i < scan.docs.length; i++) {
            const d = scan.docs[i];
            const isLast = i === scan.docs.length - 1;
            const prefix = isLast ? '└──' : '├──';
            console.log(c.dim(`     ${prefix} ${d.name.padEnd(10)} → ${d.path} (${d.fileCount} files)`));
        }
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

// ── Checkbox Prompt ─────────────────────────────────

/** Build the default list of available modules based on scan. */
function buildDefaultModules(scan: ScanResult): ('code' | 'git' | 'docs')[] {
    const m: ('code' | 'git' | 'docs')[] = [];
    if (scan.code.total > 0) m.push('code');
    if (scan.git) m.push('git');
    if (scan.docs.length > 0) m.push('docs');
    return m;
}

/** Interactive checkbox prompt via @inquirer/prompts. */
async function promptModules(scan: ScanResult): Promise<('code' | 'git' | 'docs')[]> {
    const { checkbox } = await import('@inquirer/prompts');
    console.log(c.dim('  ─────────────────────────────────────────\n'));

    type ModuleName = 'code' | 'git' | 'docs';
    const choices: { name: string; value: ModuleName; checked: boolean; disabled?: string }[] = [];

    if (scan.code.total > 0) {
        choices.push({
            name: `Code  — ${scan.code.total} files (${scan.code.byLanguage.size} languages)`,
            value: 'code',
            checked: true,
        });
    } else {
        choices.push({
            name: 'Code  — no source files found',
            value: 'code',
            checked: false,
            disabled: 'nothing to index',
        });
    }

    if (scan.git) {
        choices.push({
            name: `Git   — ${scan.git.commitCount.toLocaleString()} commits`,
            value: 'git',
            checked: true,
        });
    } else {
        choices.push({
            name: 'Git   — no .git directory',
            value: 'git',
            checked: false,
            disabled: 'not a git repo',
        });
    }

    if (scan.docs.length > 0) {
        const totalFiles = scan.docs.reduce((s, d) => s + d.fileCount, 0);
        choices.push({
            name: `Docs  — ${scan.docs.length} collection${scan.docs.length > 1 ? 's' : ''} (${totalFiles} files)`,
            value: 'docs',
            checked: true,
        });
    } else {
        choices.push({
            name: 'Docs  — no documents found',
            value: 'docs',
            checked: false,
            disabled: 'no .md/.mdx files',
        });
    }

    return checkbox<ModuleName>({
        message: 'Select modules to index:\n',
        choices,
    });
}

// ── Helpers ─────────────────────────────────────────

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

/** Offer to generate .brainbank/config.json from the selected modules. */
async function offerSaveConfig(repoPath: string, modules: ('code' | 'git' | 'docs')[]): Promise<void> {
    const { confirm, select } = await import('@inquirer/prompts');
    const shouldSave = await confirm({
        message: 'Save selection to .brainbank/config.json?',
        default: true,
    });

    if (!shouldSave) return;

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

    const configDir = path.join(repoPath, '.brainbank');
    const configPath = path.join(configDir, 'config.json');

    const config: Record<string, unknown> = {
        plugins: modules,
        embedding,
    };

    // Add sensible defaults per module
    if (modules.includes('code')) {
        config.code = { maxFileSize: 512000 };
    }
    if (modules.includes('git')) {
        config.git = { depth: 500 };
    }

    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
    console.log(c.green(`  ✓ Saved ${path.relative(process.cwd(), configPath)}`));
}

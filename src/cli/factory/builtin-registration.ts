/**
 * BrainBank CLI — Built-in Plugin Registration
 *
 * Registers code/git/docs plugins with multi-repo detection
 * and per-plugin embedding overrides.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import type { BrainBank } from '@/brainbank.ts';
import type { ProjectConfig } from './config-loader.ts';
import { loadCodePlugin, loadGitPlugin, loadDocsPlugin } from './plugin-loader.ts';
import { resolveEmbeddingKey } from './plugin-loader.ts';
import { c, getFlag } from '../utils.ts';

/** Detect subdirectories that have their own .git repo. */
function detectGitSubdirs(parentPath: string): { name: string; path: string }[] {
    try {
        const entries = fs.readdirSync(parentPath, { withFileTypes: true });
        return entries
            .filter(e =>
                e.isDirectory() &&
                !e.name.startsWith('.') &&
                !e.name.startsWith('node_modules') &&
                fs.existsSync(path.join(parentPath, e.name, '.git')),
            )
            .map(e => ({ name: e.name, path: path.join(parentPath, e.name) }));
    } catch { return []; }
}

/** Register built-in plugins with multi-repo detection and per-plugin embedding. */
export async function registerBuiltins(
    brain: BrainBank, rp: string, builtins: ('code' | 'git' | 'docs')[], config: ProjectConfig | null,
): Promise<void> {
    const resolvedRp = path.resolve(rp);
    const hasRootGit = fs.existsSync(path.join(resolvedRp, '.git'));
    const gitSubdirs = !hasRootGit ? detectGitSubdirs(resolvedRp) : [];

    const codeEmb = config?.code?.embedding ? await resolveEmbeddingKey(config.code.embedding) : undefined;
    const gitEmb = config?.git?.embedding ? await resolveEmbeddingKey(config.git.embedding) : undefined;
    const docsEmb = config?.docs?.embedding ? await resolveEmbeddingKey(config.docs.embedding) : undefined;

    const ignoreFlag = getFlag('ignore');
    const cliIgnore = ignoreFlag ? ignoreFlag.split(',').map(s => s.trim()) : [];
    const configIgnore = config?.code?.ignore ?? [];
    const mergedIgnore = [...configIgnore, ...cliIgnore];
    const ignore = mergedIgnore.length > 0 ? mergedIgnore : undefined;

    const codeFactory = builtins.includes('code') ? await loadCodePlugin() : null;
    const gitFactory = builtins.includes('git') ? await loadGitPlugin() : null;
    const docsFactory = builtins.includes('docs') ? await loadDocsPlugin() : null;

    if (builtins.includes('code') && !codeFactory) {
        console.log(c.yellow('  ⚠ @brainbank/code not installed — skipping code indexing'));
        console.log(c.dim('    Install: npm i -g @brainbank/code'));
    }
    if (builtins.includes('git') && !gitFactory) {
        console.log(c.yellow('  ⚠ @brainbank/git not installed — skipping git indexing'));
        console.log(c.dim('    Install: npm i -g @brainbank/git'));
    }
    if (builtins.includes('docs') && !docsFactory) {
        console.log(c.yellow('  ⚠ @brainbank/docs not installed — skipping docs indexing'));
        console.log(c.dim('    Install: npm i -g @brainbank/docs'));
    }

    if (gitSubdirs.length > 0 && (codeFactory || gitFactory)) {
        console.log(c.cyan(`  Multi-repo: found ${gitSubdirs.length} git repos: ${gitSubdirs.map(d => d.name).join(', ')}`));
        for (const sub of gitSubdirs) {
            if (codeFactory) {
                brain.use(codeFactory({
                    repoPath: sub.path, name: `code:${sub.name}`,
                    embeddingProvider: codeEmb, maxFileSize: config?.code?.maxFileSize, ignore,
                }));
            }
            if (gitFactory) {
                brain.use(gitFactory({
                    repoPath: sub.path, name: `git:${sub.name}`,
                    embeddingProvider: gitEmb, depth: config?.git?.depth, maxDiffBytes: config?.git?.maxDiffBytes,
                }));
            }
        }
    } else {
        if (codeFactory) {
            brain.use(codeFactory({
                repoPath: rp, embeddingProvider: codeEmb, maxFileSize: config?.code?.maxFileSize, ignore,
            }));
        }
        if (gitFactory) {
            brain.use(gitFactory({
                embeddingProvider: gitEmb, depth: config?.git?.depth, maxDiffBytes: config?.git?.maxDiffBytes,
            }));
        }
    }

    if (docsFactory) {
        brain.use(docsFactory({ embeddingProvider: docsEmb }));
    }
}

/** Register doc collections from config. Call after brain.initialize(). */
export async function registerConfigCollections(brain: BrainBank, config: ProjectConfig | null): Promise<void> {
    const collections = config?.docs?.collections;
    if (!collections?.length) return;

    const docsPlugin = brain.docs;
    if (!docsPlugin?.addCollection) return;

    for (const coll of collections) {
        const absPath = path.resolve(coll.path);
        try {
            await docsPlugin.addCollection({
                name: coll.name, path: absPath,
                pattern: coll.pattern ?? '**/*.md', ignore: coll.ignore, context: coll.context,
            });
        } catch (e: unknown) {
            if (!(e instanceof Error && e.message.includes('already'))) throw e;
            // Collection already registered — skip
        }
    }
}

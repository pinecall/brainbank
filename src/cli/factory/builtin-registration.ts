/**
 * BrainBank CLI — Plugin Registration
 *
 * Generic plugin registration with multi-repo detection
 * and per-plugin config resolution. No hardcoded plugin names.
 */

import type { BrainBank } from '@/brainbank.ts';
import type { DocumentCollection } from '@/types.ts';
import type { ProjectConfig } from './config-loader.ts';

import * as fs from 'node:fs';
import * as path from 'node:path';
import { c } from '../utils.ts';
import { loadPlugin, isMultiRepoCapable, resolveEmbeddingKey } from './plugin-loader.ts';

/** Read a nested property from a generic config section. */
function pluginCfg(config: ProjectConfig | null, pluginName: string): Record<string, unknown> {
    const section = config?.[pluginName];
    if (section && typeof section === 'object' && !Array.isArray(section)) {
        return section as Record<string, unknown>;
    }
    return {};
}

/** Detect subdirectories that have their own .git repo. Respects optional `repos` whitelist. */
function detectGitSubdirs(parentPath: string, repos?: string[]): { name: string; path: string }[] {
    try {
        const entries = fs.readdirSync(parentPath, { withFileTypes: true });
        let subdirs = entries
            .filter(e =>
                e.isDirectory() &&
                !e.name.startsWith('.') &&
                !e.name.startsWith('node_modules') &&
                fs.existsSync(path.join(parentPath, e.name, '.git')),
            )
            .map(e => ({ name: e.name, path: path.join(parentPath, e.name) }));

        if (repos && repos.length > 0) {
            const allowed = new Set(repos);
            subdirs = subdirs.filter(s => allowed.has(s.name));
        }

        return subdirs;
    } catch { return []; }
}

/** Register plugins with multi-repo detection and per-plugin config. */
export async function registerBuiltins(
    brain: BrainBank, rp: string, pluginNames: string[],
    config: ProjectConfig | null, ignorePatterns: string[] = [],
): Promise<void> {
    const resolvedRp = path.resolve(rp);
    const hasRootGit = fs.existsSync(path.join(resolvedRp, '.git'));
    const configRepos = config?.repos as string[] | undefined;
    const gitSubdirs = !hasRootGit ? detectGitSubdirs(resolvedRp, configRepos) : [];

    for (const name of pluginNames) {
        const factory = await loadPlugin(name);
        if (!factory) {
            console.log(c.yellow(`  ⚠ @brainbank/${name} not installed — skipping ${name} indexing`));
            console.log(c.dim(`    Install: npm i -g @brainbank/${name}`));
            continue;
        }

        const cfg = pluginCfg(config, name);

        // Resolve per-plugin embedding if configured
        const embKey = cfg.embedding as string | undefined;
        const embeddingProvider = embKey ? await resolveEmbeddingKey(embKey) : undefined;

        // Multi-repo: create one plugin instance per git subdir
        if (gitSubdirs.length > 0 && isMultiRepoCapable(name)) {
            console.log(c.cyan(`  Multi-repo: found ${gitSubdirs.length} git repos: ${gitSubdirs.map(d => d.name).join(', ')}`));
            for (const sub of gitSubdirs) {
                const mergedIgnore = [...(cfg.ignore as string[] ?? []), ...ignorePatterns];
                brain.use(factory({
                    ...cfg,
                    repoPath: sub.path,
                    name: `${name}:${sub.name}`,
                    embeddingProvider,
                    ignore: mergedIgnore.length > 0 ? mergedIgnore : undefined,
                }));
            }
        } else {
            // Single repo: merge ignore patterns for plugins that support them
            const configIgnore = cfg.ignore as string[] | undefined ?? [];
            const mergedIgnore = [...configIgnore, ...ignorePatterns];

            brain.use(factory({
                ...cfg,
                repoPath: rp,
                embeddingProvider,
                ignore: mergedIgnore.length > 0 ? mergedIgnore : undefined,
            }));
        }
    }
}

/** Register doc collections from config. Call after brain.initialize(). */
export async function registerConfigCollections(brain: BrainBank, rp: string, config: ProjectConfig | null): Promise<void> {
    const docsCfg = pluginCfg(config, 'docs');
    const collections = docsCfg.collections as DocumentCollection[] | undefined;
    if (!collections?.length) return;

    const { isDocsPlugin } = await import('@/plugin.ts');
    const rawPlugin = brain.plugin('docs');
    if (!rawPlugin || !isDocsPlugin(rawPlugin)) return;

    const repoPath = path.resolve(rp);
    for (const coll of collections) {
        const absPath = path.resolve(repoPath, coll.path);
        try {
            await rawPlugin.addCollection({
                name: coll.name, path: absPath,
                pattern: coll.pattern ?? '**/*.md', ignore: coll.ignore, context: coll.context,
            });
        } catch (e: unknown) {
            if (!(e instanceof Error && e.message.includes('already'))) throw e;
            // Collection already registered — skip
        }
    }
}

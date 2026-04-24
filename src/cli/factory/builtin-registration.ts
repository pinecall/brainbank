/**
 * BrainBank CLI — Plugin Registration
 *
 * Generic plugin registration with per-plugin config resolution.
 */

import type { BrainBank } from '@/brainbank.ts';
import type { DocumentCollection } from '@/types.ts';
import type { ProjectConfig } from './config-loader.ts';

import * as fs from 'node:fs';
import * as path from 'node:path';
import { c } from '../utils.ts';
import { loadPlugin, resolveEmbeddingKey } from './plugin-loader.ts';

/** Read a nested property from a generic config section. */
function pluginCfg(config: ProjectConfig | null, pluginName: string): Record<string, unknown> {
    const section = config?.[pluginName];
    if (section && typeof section === 'object' && !Array.isArray(section)) {
        return section as Record<string, unknown>;
    }
    return {};
}

/** Register plugins with per-plugin config. */
export async function registerBuiltins(
    brain: BrainBank, rp: string, pluginNames: string[],
    config: ProjectConfig | null, ignorePatterns: string[] = [], includePatterns: string[] = [],
): Promise<void> {
    for (const name of pluginNames) {
        const factory = await loadPlugin(name);
        if (!factory) {
            console.error(c.yellow(`  ⚠ @brainbank/${name} not installed — skipping ${name} indexing`));
            console.error(c.dim(`    Install: npm i -g @brainbank/${name}`));
            continue;
        }

        const cfg = pluginCfg(config, name);

        // Resolve per-plugin embedding if configured
        const embKey = cfg.embedding as string | undefined;
        const embeddingProvider = embKey ? await resolveEmbeddingKey(embKey) : undefined;

        // Merge ignore/include patterns for plugins that support them
        // Sources: per-plugin config (e.g. config.code.ignore), root config (config.ignore), CLI flags
        const configIgnore = cfg.ignore as string[] | undefined ?? [];
        const rootIgnore = (config?.ignore ?? []) as string[];
        const mergedIgnore = [...configIgnore, ...rootIgnore, ...ignorePatterns];

        const configInclude = cfg.include as string[] | undefined ?? [];
        const rootInclude = (config?.include ?? []) as string[];
        const mergedInclude = [...configInclude, ...rootInclude, ...includePatterns];

        brain.use(factory({
            ...cfg,
            repoPath: rp,
            embeddingProvider,
            ignore: mergedIgnore.length > 0 ? mergedIgnore : undefined,
            include: mergedInclude.length > 0 ? mergedInclude : undefined,
        }));
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

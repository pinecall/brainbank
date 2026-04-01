/**
 * BrainBank CLI — Brain Factory
 *
 * Creates a configured BrainBank instance with dynamically loaded plugins,
 * auto-discovered indexers, and config file support.
 * Delegates to focused modules in factory/.
 */

import type { Plugin } from '@/plugin.ts';
import type { BrainBankConfig } from '@/types.ts';
import type { BrainContext } from './brain-context.ts';

import { BrainBank } from '@/brainbank.ts';
import { contextFromCLI, ctxFlag, ctxEnv } from './brain-context.ts';
import { registerBuiltins, registerConfigCollections } from './builtin-registration.ts';
import { loadConfig, getConfig, resetConfigCache } from './config-loader.ts';
import { discoverFolderPlugins, resetPluginCache, setupProviders } from './plugin-loader.ts';

export type { ProjectConfig } from './config-loader.ts';
export type { BrainContext } from './brain-context.ts';
export { contextFromCLI } from './brain-context.ts';
export { getConfig, registerConfigCollections };

/** Reset factory caches. Useful for tests. */
export function resetFactoryCache(): void {
    resetConfigCache();
    resetPluginCache();
}

/**
 * Create a BrainBank with built-in + discovered + config plugins.
 *
 * Accepts either a `BrainContext` (for programmatic use) or an optional
 * `repoPath` string (for CLI backward compat — builds context from argv).
 */
export async function createBrain(contextOrRepo?: BrainContext | string): Promise<BrainBank> {
    const ctx: BrainContext = typeof contextOrRepo === 'string'
        ? contextFromCLI(contextOrRepo)
        : contextOrRepo ?? contextFromCLI();

    const rp = ctx.repoPath;
    const config = await loadConfig(rp);
    const folderPlugins = await discoverFolderPlugins(rp);

    const brainOpts: Partial<BrainBankConfig> & Record<string, unknown> = { repoPath: rp, ...(config?.brainbank ?? {}) };
    if (config?.maxFileSize) brainOpts.maxFileSize = config.maxFileSize as number;
    await setupProviders(brainOpts, config, ctx.flags, ctx.env);

    const brain = new BrainBank(brainOpts);
    const builtins = config?.plugins ?? ['code', 'git', 'docs'];

    // Merge ignore patterns from context flags
    const ignoreFlag = ctxFlag(ctx, 'ignore');
    const ignorePatterns = ignoreFlag ? ignoreFlag.split(',').map(s => s.trim()) : [];

    await registerBuiltins(brain, rp, builtins, config, ignorePatterns);

    for (const plugin of folderPlugins) brain.use(plugin);

    if (config?.indexers) {
        for (const plugin of config.indexers as Plugin[]) brain.use(plugin);
    }

    return brain;
}

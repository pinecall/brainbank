/**
 * WorkspaceFactory — creates BrainBank instances via the core factory.
 *
 * Delegates to `createBrain()` from the core factory, passing
 * a portable `BrainContext`. No plugin hardcoding — the factory handles
 * plugin discovery from config and installed packages.
 */

import type { BrainBank } from '@/brainbank.ts';
import type { BrainContext } from '@/cli/factory/brain-context.ts';

import { createBrain, resetFactoryCache } from '@/cli/factory/index.ts';

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Detect repo root by walking up from startDir until we find `.git/`.
 * Returns startDir itself if no `.git/` is found.
 */
export function findRepoRoot(startDir: string): string {
    let dir = path.resolve(startDir);
    while (true) {
        if (fs.existsSync(path.join(dir, '.git'))) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return path.resolve(startDir);
}

/** Resolve the effective repo path from an optional target, env, or cwd. */
export function resolveRepoPath(targetRepo?: string): string {
    const rp = targetRepo
        ?? process.env.BRAINBANK_REPO
        ?? findRepoRoot(process.cwd());
    return rp.replace(/\/+$/, '');
}

/**
 * Create a BrainBank instance for a workspace.
 * Uses the core factory which handles:
 * - Config loading from .brainbank/config.json
 * - Dynamic plugin discovery and registration
 * - Embedding/pruner/expander provider setup
 * - Folder plugin auto-discovery
 */
export async function createWorkspaceBrain(repoPath: string): Promise<BrainBank> {
    resetFactoryCache();

    const context: BrainContext = {
        repoPath,
        env: process.env as Record<string, string | undefined>,
    };

    // Silence stdout during initialization — the core factory emits ANSI-colored
    // console.log messages (plugin loading, multi-repo detection) that corrupt
    // the MCP JSON-RPC stdio transport. Redirect console.log → stderr temporarily.
    const origLog = console.log;
    console.log = (...args: unknown[]) => console.error(...args);
    try {
        const brain = await createBrain(context);
        await brain.initialize();
        return brain;
    } finally {
        console.log = origLog;
    }
}

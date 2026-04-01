/**
 * BrainBank — Brain Context
 *
 * Portable input for `createBrain()`. Decouples the factory from
 * `process.argv` / `process.env` so it can be called from the CLI,
 * MCP server, tests, or any programmatic consumer.
 */

import { getFlag } from '../utils.ts';

/** Everything the factory needs to build a BrainBank instance. */
export interface BrainContext {
    /** Repository root path. */
    repoPath: string;
    /** Environment variable overrides. Falls back to `process.env`. */
    env?: Record<string, string | undefined>;
    /** CLI flag overrides (e.g. `{ ignore: 'dist,vendor' }`). */
    flags?: Record<string, string | undefined>;
}

/** Build a `BrainContext` from CLI argv + process.env. */
export function contextFromCLI(repoPath?: string): BrainContext {
    return {
        repoPath: repoPath ?? getFlag('repo') ?? '.',
        env: process.env as Record<string, string | undefined>,
        flags: {
            ignore: getFlag('ignore'),
            reranker: getFlag('reranker'),
            embedding: getFlag('embedding'),
        },
    };
}

/** Read a flag from context, falling back to process.env equivalent. */
export function ctxFlag(ctx: BrainContext, name: string): string | undefined {
    return ctx.flags?.[name];
}

/** Read an env var from context, falling back to process.env. */
export function ctxEnv(ctx: BrainContext, name: string): string | undefined {
    return ctx.env?.[name] ?? process.env[name];
}

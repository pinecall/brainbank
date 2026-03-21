/**
 * BrainBank — Configuration
 * 
 * Sensible defaults + merge utility.
 */

import type { BrainBankConfig, ResolvedConfig } from '../types.ts';

// ── Defaults ────────────────────────────────────────

export const DEFAULTS: ResolvedConfig = {
    repoPath: '.',
    dbPath: '.brainbank/brainbank.db',
    gitDepth: 500,
    maxFileSize: 512_000,      // 500KB
    maxDiffBytes: 8192,
    hnswM: 16,
    hnswEfConstruction: 200,
    hnswEfSearch: 50,
    embeddingDims: 384,
    maxElements: 2_000_000,
};

// ── Resolver ────────────────────────────────────────

/**
 * Merge partial config with defaults.
 * All fields become required.
 */
export function resolveConfig(partial: BrainBankConfig = {}): ResolvedConfig {
    return {
        repoPath:          partial.repoPath          ?? DEFAULTS.repoPath,
        dbPath:            partial.dbPath            ?? DEFAULTS.dbPath,
        gitDepth:          partial.gitDepth          ?? DEFAULTS.gitDepth,
        maxFileSize:       partial.maxFileSize       ?? DEFAULTS.maxFileSize,
        maxDiffBytes:      partial.maxDiffBytes      ?? DEFAULTS.maxDiffBytes,
        hnswM:             partial.hnswM             ?? DEFAULTS.hnswM,
        hnswEfConstruction: partial.hnswEfConstruction ?? DEFAULTS.hnswEfConstruction,
        hnswEfSearch:      partial.hnswEfSearch      ?? DEFAULTS.hnswEfSearch,
        embeddingDims:     partial.embeddingDims     ?? DEFAULTS.embeddingDims,
        maxElements:       partial.maxElements       ?? DEFAULTS.maxElements,
        embeddingProvider: partial.embeddingProvider,
    };
}

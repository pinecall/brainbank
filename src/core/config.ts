/**
 * BrainBank — Configuration
 * 
 * Sensible defaults + merge utility.
 */

import type { BrainBankConfig, ResolvedConfig, ResolvedFeatureFlags } from '../types.ts';

// ── Default Feature Flags ────────────────────────────

export const DEFAULT_FEATURES: ResolvedFeatureFlags = {
    code: true,
    git: true,
    documents: false,
    conversations: true,
    patterns: true,
};

// ── Defaults ────────────────────────────────────────

export const DEFAULTS: ResolvedConfig = {
    repoPath: '.',
    dbPath: '.brainbank/brainbank.db',
    features: { ...DEFAULT_FEATURES },
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
        features:          resolveFeatures(partial.features),
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

/**
 * Resolve partial feature flags with defaults.
 */
function resolveFeatures(partial?: Partial<ResolvedFeatureFlags>): ResolvedFeatureFlags {
    if (!partial) return { ...DEFAULT_FEATURES };
    return {
        code:           partial.code           ?? DEFAULT_FEATURES.code,
        git:            partial.git            ?? DEFAULT_FEATURES.git,
        documents:      partial.documents      ?? DEFAULT_FEATURES.documents,
        conversations:  partial.conversations  ?? DEFAULT_FEATURES.conversations,
        patterns:       partial.patterns       ?? DEFAULT_FEATURES.patterns,
    };
}

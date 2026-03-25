/**
 * BrainBank — FTS Utilities
 * 
 * Shared helpers for SQLite FTS5 query sanitization.
 */

/**
 * Split camelCase, PascalCase, and snake_case into individual words.
 *   "MagicLinkCallback" → "Magic Link Callback"
 *   "tenant_worker"     → "tenant worker"
 */
function splitCompound(word: string): string {
    return word
        .replace(/([a-z])([A-Z])/g, '$1 $2')   // camelCase → camel Case
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2') // HTMLParser → HTML Parser
        .replace(/[_\-./\\]/g, ' ')              // snake_case, kebab-case, paths
        .trim();
}

/**
 * Sanitize a user query for FTS5 syntax.
 * Strips operators that would cause parse errors, splits compound words,
 * and converts words to implicit AND with exact-match quoting.
 */
export function sanitizeFTS(query: string): string {
    const clean = query
        .replace(/[{}[\]()^~*:]/g, ' ')
        .replace(/\bAND\b|\bOR\b|\bNOT\b|\bNEAR\b/gi, '')
        .trim();

    // Split compound words (camelCase, PascalCase, snake_case)
    const expanded = clean.split(/\s+/)
        .map(w => splitCompound(w))
        .join(' ');

    const words = expanded.split(/\s+/).filter(w => w.length > 1);
    if (words.length === 0) return '';

    return words.map(w => `"${w}"`).join(' ');
}

/**
 * Normalize BM25 score from SQLite (negative, lower = better)
 * to 0.0–1.0 (higher = better) for consistency with vector search.
 */
export function normalizeBM25(rawScore: number): number {
    const abs = Math.abs(rawScore);
    return 1.0 / (1.0 + Math.exp(-0.3 * (abs - 5)));
}

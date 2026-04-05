/**
 * BrainBank — Haiku Pruner
 *
 * LLM-based noise filter using Anthropic's Haiku 4.5 model.
 * Binary classification: for each search result, Haiku decides
 * "relevant" or "noise" based on filePath, metadata, and full
 * file content (capped at ~8K chars per item by prune.ts).
 *
 * Latency: ~300-600ms.
 */

import type { Pruner, PrunerItem } from '@/types.ts';

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

export interface HaikuPrunerOptions {
    /** Anthropic API key. Falls back to ANTHROPIC_API_KEY env var. */
    apiKey?: string;
    /** Model to use. Default: claude-haiku-4-5-20251001 */
    model?: string;
}

export class HaikuPruner implements Pruner {
    private readonly _apiKey: string;
    private readonly _model: string;

    constructor(options: HaikuPrunerOptions = {}) {
        this._apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY ?? '';
        this._model = options.model ?? DEFAULT_MODEL;

        if (!this._apiKey) {
            throw new Error(
                'HaikuPruner: No API key provided. Set ANTHROPIC_API_KEY env var or pass apiKey option.',
            );
        }
    }

    async prune(query: string, items: PrunerItem[]): Promise<number[]> {
        if (items.length === 0) return [];
        if (items.length === 1) return [items[0].id];

        const itemLines = items.map(item => {
            // Only show useful metadata fields (skip raw scores, IDs, large arrays)
            const SKIP_KEYS = new Set(['id', 'chunkIds', 'rrfScore', 'filePath']);
            const meta = Object.entries(item.metadata)
                .filter(([k, v]) => v !== undefined && v !== null && !SKIP_KEYS.has(k))
                .map(([k, v]) => `${k}=${v}`)
                .join(' | ');
            return `#${item.id} ${item.filePath} | ${meta}\n${item.preview}`;
        }).join('\n---\n');

        const prompt =
            `Query: "${query}"\n\nSearch results (full file content):\n${itemLines}\n\n` +
            `You are a search result filter. You have access to the FULL source code of each file.\n` +
            `Return a JSON array of #IDs to KEEP.\n\n` +
            `Rules:\n` +
            `- ONLY drop files that are CLEARLY AND OBVIOUSLY unrelated to the query.\n` +
            `- KEEP any file that mentions, implements, imports, configures, or tests anything related to the query — even indirectly.\n` +
            `- KEEP types, interfaces, entities, configs, DTOs, modules, stores, services, and controllers that touch the query domain.\n` +
            `- KEEP utility files if they contain functions used by the query domain.\n` +
            `- When in doubt, ALWAYS KEEP. False negatives (dropping a relevant file) are FAR WORSE than false positives.\n` +
            `- You should typically keep 80-100% of results. Only drop obvious noise.\n\n` +
            `Respond with ONLY the JSON array. Example: [0, 1, 2, 5, 8]`;

        try {
            const response = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': this._apiKey,
                    'anthropic-version': '2023-06-01',
                },
                body: JSON.stringify({
                    model: this._model,
                    max_tokens: 512,
                    messages: [{
                        role: 'user',
                        content: prompt,
                    }],
                }),
            });

            if (!response.ok) {
                // API error → fail-open, return all
                return items.map(i => i.id);
            }

            const data = await response.json() as {
                content: { type: string; text: string }[];
            };

            const text = data.content?.[0]?.text ?? '';
            // Haiku may wrap in ```json ... ``` — extract any JSON array
            const match = text.match(/\[[\d\s,]+\]/);
            if (!match) return items.map(i => i.id);

            const keepIds = JSON.parse(match[0]) as number[];
            const validIds = new Set(items.map(i => i.id));
            return keepIds.filter(id => validIds.has(id));
        } catch {
            // Network error → fail-open, return all
            return items.map(i => i.id);
        }
    }

    async close(): Promise<void> {
        // No resources to release (stateless HTTP)
    }
}

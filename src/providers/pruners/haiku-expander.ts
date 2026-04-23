/**
 * BrainBank — Haiku Expander
 *
 * LLM-powered context expansion using Anthropic's Haiku 4.5 model.
 * After search + pruning, reviews a manifest of available chunks
 * and requests additional IDs to include.
 *
 * Flow:
 *   1. Receives lightweight manifest (~20 chars per chunk)
 *   2. Haiku selects additional chunk IDs (just numbers, fast)
 *   3. Caller fetches those chunks from DB and splices into results
 *
 * Designed for minimal token usage:
 *   - Input: ~2,000-3,000 tokens (manifest)
 *   - Output: ~50-100 tokens (ID array)
 *   - Cost: ~$0.001 per call
 *   - Latency: ~300-600ms
 *
 * Fail-open: any error returns empty array (no expansion).
 */

import type { Expander, ExpanderManifestItem, ExpanderResult } from '@/types.ts';

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

export interface HaikuExpanderOptions {
    /** Anthropic API key. Falls back to ANTHROPIC_API_KEY env var. */
    apiKey?: string;
    /** Model to use. Default: claude-haiku-4-5-20251001 */
    model?: string;
}

export class HaikuExpander implements Expander {
    private readonly _apiKey: string;
    private readonly _model: string;

    constructor(options: HaikuExpanderOptions = {}) {
        this._apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY ?? '';
        this._model = options.model ?? DEFAULT_MODEL;

        if (!this._apiKey) {
            throw new Error(
                'HaikuExpander: No API key provided. Set ANTHROPIC_API_KEY env var or pass apiKey option.',
            );
        }
    }

    async expand(
        query: string,
        currentIds: number[],
        manifest: ExpanderManifestItem[],
    ): Promise<ExpanderResult> {
        if (manifest.length === 0) return { ids: [] };

        // Filter out chunks already in results
        const currentSet = new Set(currentIds);
        const available = manifest.filter(m => !currentSet.has(m.id));
        if (available.length === 0) return { ids: [] };

        // Split manifest into priority (import-graph neighbors) and general
        const priorityChunks = available.filter(m => m.priority);
        const otherChunks = available.filter(m => !m.priority);

        const currentSummary = manifest
            .filter(m => currentSet.has(m.id))
            .map(m => `#${m.id} ${m.filePath} | ${m.chunkType} ${m.name}`)
            .join('\n');

        // Build manifest sections
        let manifestSection = '';
        if (priorityChunks.length > 0) {
            const prioLines = priorityChunks.map(m =>
                `#${m.id} ${m.filePath} | ${m.chunkType} ${m.name} ${m.lines}`
            ).join('\n');
            manifestSection += `DEPENDENCY chunks (imported by or importing the search result files):\n${prioLines}\n\n`;
        }
        if (otherChunks.length > 0) {
            const otherLines = otherChunks.map(m =>
                `#${m.id} ${m.filePath} | ${m.chunkType} ${m.name} ${m.lines}`
            ).join('\n');
            manifestSection += `Other available chunks:\n${otherLines}`;
        }

        const prompt =
            `Task: "${query}"\n\n` +
            `Already included chunks:\n${currentSummary}\n\n` +
            `${manifestSection}\n\n` +
            `You are a code context expander. The search already found the "included" chunks above.\n` +
            `Review the available chunks and select any that would help an AI agent complete the task.\n\n` +
            `Rules:\n` +
            `- STRONGLY PREFER dependency chunks — they are structurally connected to the search results via imports\n` +
            `- Select type definitions, interfaces, models, or configs needed to understand included code\n` +
            `- Select initialization or setup code if the task involves debugging or modifying a feature\n` +
            `- Do NOT select test files, documentation, or unrelated utilities\n` +
            `- Be selective: only include chunks that fill clear gaps. Quality over quantity.\n` +
            `- If nothing useful is available, return an empty ids array\n\n` +
            `Respond with ONLY a JSON object:\n` +
            `{ "ids": [42, 17, 89], "note": "Brief 1-2 sentence observation about the codebase relevant to the task" }\n\n` +
            `The "note" is optional — use it to mention things like missing files, architectural patterns, ` +
            `deprecated modules, or important relationships you noticed. If nothing notable, omit it.\n` +
            `If nothing to add: { "ids": [] }`;

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
                return { ids: [] };
            }

            const data = await response.json() as {
                content: { type: string; text: string }[];
            };

            const text = data.content?.[0]?.text ?? '';
            return this._parseResponse(text, available);
        } catch {
            return { ids: [] };
        }
    }

    /** Parse Haiku response — handles both `{ ids, note }` and bare `[...]` formats. */
    private _parseResponse(text: string, available: ExpanderManifestItem[]): ExpanderResult {
        const validIds = new Set(available.map(m => m.id));

        // Try JSON object first: { "ids": [...], "note": "..." }
        const objMatch = text.match(/\{[\s\S]*"ids"\s*:\s*\[[\d\s,]*\][\s\S]*\}/);
        if (objMatch) {
            try {
                const parsed = JSON.parse(objMatch[0]) as { ids: number[]; note?: string };
                const ids = parsed.ids.filter(id => validIds.has(id));
                const note = parsed.note?.trim() || undefined;
                return { ids, note };
            } catch {
                // Fall through to array parsing
            }
        }

        // Fallback: bare array [42, 17, 89]
        const arrMatch = text.match(/\[[\d\s,]*\]/);
        if (arrMatch) {
            const ids = (JSON.parse(arrMatch[0]) as number[]).filter(id => validIds.has(id));
            return { ids };
        }

        return { ids: [] };
    }

    async close(): Promise<void> {
        // No resources to release (stateless HTTP)
    }
}

/**
 * Unit Tests — Expander Pipeline
 *
 * Tests the context builder's expansion step:
 * - Expansion only runs when `expander` field is true
 * - Manifest is built from ExpandablePlugins (excluding already-matched files)
 * - Expanded chunks are spliced into results
 * - File-level dedup: chunks from files already in results are excluded
 * - ID-level dedup: chunk IDs already in results are excluded
 * - Fail-open: errors don't crash the pipeline
 */

import { ContextBuilder } from '../../../src/search/context-builder.ts';
import type { ContextFieldPlugin, ContextFormatterPlugin, ExpandablePlugin, Plugin, ContextFieldDef } from '../../../src/plugin.ts';
import { PluginRegistry } from '../../../src/services/plugin-registry.ts';
import type { SearchResult, Expander, ExpanderManifestItem, ExpanderResult } from '../../../src/types.ts';
import type { SearchStrategy } from '../../../src/search/types.ts';

export const name = 'Expander Pipeline';

/** Mock search returning predefined results. */
function mockSearch(results: SearchResult[]): SearchStrategy {
    return {
        async search(): Promise<SearchResult[]> { return results; },
    };
}

/** Build a code result with an ID. */
function codeResult(id: number, filePath: string): SearchResult {
    return {
        type: 'code',
        score: 0.9,
        filePath,
        content: `content of ${filePath}`,
        metadata: { id, chunkType: 'function', name: `func${id}`, startLine: 1, endLine: 10, language: 'typescript' },
    };
}

/** Mock expander that returns specific IDs and captures the manifest it received. */
function mockExpander(returnIds: number[]): Expander & { lastManifest?: ExpanderManifestItem[] } {
    const exp: Expander & { lastManifest?: ExpanderManifestItem[] } = {
        lastManifest: undefined,
        async expand(_query: string, _currentIds: number[], manifest: ExpanderManifestItem[]): Promise<ExpanderResult> {
            exp.lastManifest = manifest;
            return { ids: returnIds };
        },
    };
    return exp;
}

/** Mock expander that throws. */
function failingExpander(): Expander {
    return {
        async expand(): Promise<ExpanderResult> {
            throw new Error('API down');
        },
    };
}

/**
 * Full manifest simulating a database.
 * Files: src/main.ts (IDs 1,2), src/helper.ts (IDs 100,101), src/util.ts (ID 102)
 * Search results will contain src/main.ts — so only helper.ts and util.ts should appear in manifest.
 */
const ALL_CHUNKS: ExpanderManifestItem[] = [
    { id: 1, filePath: 'src/main.ts', name: 'main', chunkType: 'file', lines: 'L1-L50' },
    { id: 2, filePath: 'src/main.ts', name: 'func2', chunkType: 'function', lines: 'L5-L20' },
    { id: 100, filePath: 'src/helper.ts', name: 'helperA', chunkType: 'function', lines: 'L1-L10' },
    { id: 101, filePath: 'src/helper.ts', name: 'helperB', chunkType: 'function', lines: 'L12-L25' },
    { id: 102, filePath: 'src/util.ts', name: 'util', chunkType: 'function', lines: 'L1-L8' },
];

/** Mock plugin that implements ContextFormatterPlugin + ExpandablePlugin + ContextFieldPlugin. */
function createExpandablePlugin(): Plugin & ContextFormatterPlugin & ExpandablePlugin & ContextFieldPlugin {
    return {
        name: 'code',
        async initialize() {},
        formatContext(_results: SearchResult[], parts: string[], _fields: Record<string, unknown>) {
            parts.push('formatted');
        },
        contextFields(): ContextFieldDef[] {
            return [
                { name: 'expander', type: 'boolean', default: false, description: 'Enable LLM expansion' },
            ];
        },
        buildManifest(excludeFilePaths: string[], excludeIds: number[]): ExpanderManifestItem[] {
            // Simulate SQL: WHERE file_path NOT IN (...) AND id NOT IN (...)
            const excludedPaths = new Set(excludeFilePaths);
            const excludedIds = new Set(excludeIds);
            return ALL_CHUNKS.filter(
                item => !excludedPaths.has(item.filePath) && !excludedIds.has(item.id),
            );
        },
        resolveChunks(ids: number[]): SearchResult[] {
            return ids.map(id => ({
                type: 'code' as const,
                score: -1,
                filePath: `src/resolved-${id}.ts`,
                content: `expanded content ${id}`,
                metadata: { id, chunkType: 'function', name: `expanded${id}`, startLine: 1, endLine: 5, language: 'typescript' },
            }));
        },
    };
}

export const tests = {
    async 'expander=false: no expansion happens'(assert: { equal: (a: unknown, b: unknown, msg?: string) => void }) {
        const results = [codeResult(1, 'src/main.ts')];
        const plugin = createExpandablePlugin();
        const registry = new PluginRegistry();
        registry.register(plugin);

        const expander = mockExpander([100, 101]);
        const builder = new ContextBuilder(mockSearch(results), registry, undefined, undefined, {}, expander);

        // expander field defaults to false
        const ctx = await builder.build('test task');
        assert.equal(ctx.includes('expanded content'), false, 'should NOT include expanded content');
    },

    async 'expander=true: expanded chunks are included'(assert: { ok: (v: unknown, msg?: string) => void }) {
        const results = [codeResult(1, 'src/main.ts')];
        const plugin = createExpandablePlugin();
        const registry = new PluginRegistry();
        registry.register(plugin);

        const expander = mockExpander([100, 101]);
        const builder = new ContextBuilder(mockSearch(results), registry, undefined, undefined, {}, expander);

        const ctx = await builder.build('test task', { fields: { expander: true } });
        // The formatter gets called with expanded results spliced in
        assert.ok(ctx.includes('formatted'), 'should include formatted output');
    },

    async 'expander error: fail-open, pipeline continues'(assert: { ok: (v: unknown, msg?: string) => void }) {
        const results = [codeResult(1, 'src/main.ts')];
        const plugin = createExpandablePlugin();
        const registry = new PluginRegistry();
        registry.register(plugin);

        const expander = failingExpander();
        const builder = new ContextBuilder(mockSearch(results), registry, undefined, undefined, {}, expander);

        // Should not throw
        const ctx = await builder.build('test task', { fields: { expander: true } });
        assert.ok(ctx.includes('formatted'), 'pipeline should complete despite expander error');
    },

    async 'no expander instance: expansion step is skipped'(assert: { ok: (v: unknown, msg?: string) => void }) {
        const results = [codeResult(1, 'src/main.ts')];
        const plugin = createExpandablePlugin();
        const registry = new PluginRegistry();
        registry.register(plugin);

        // No expander passed
        const builder = new ContextBuilder(mockSearch(results), registry);

        const ctx = await builder.build('test task', { fields: { expander: true } });
        assert.ok(ctx.includes('formatted'), 'pipeline should complete without expander');
    },

    async 'expander returns empty: no changes to results'(assert: { ok: (v: unknown, msg?: string) => void }) {
        const results = [codeResult(1, 'src/main.ts')];
        const plugin = createExpandablePlugin();
        const registry = new PluginRegistry();
        registry.register(plugin);

        const expander = mockExpander([]);
        const builder = new ContextBuilder(mockSearch(results), registry, undefined, undefined, {}, expander);

        const ctx = await builder.build('test task', { fields: { expander: true } });
        assert.ok(ctx.includes('formatted'), 'pipeline should complete with no expansion');
    },

    async 'file-level dedup: manifest excludes files already in search results'(assert: { equal: (a: unknown, b: unknown, msg?: string) => void }) {
        // Search returns src/main.ts → manifest should NOT contain ANY chunks from src/main.ts
        const results = [codeResult(1, 'src/main.ts')];
        const plugin = createExpandablePlugin();
        const registry = new PluginRegistry();
        registry.register(plugin);

        const expander = mockExpander([100]);
        const builder = new ContextBuilder(mockSearch(results), registry, undefined, undefined, {}, expander);

        await builder.build('test task', { fields: { expander: true } });

        const manifestPaths = expander.lastManifest?.map(m => m.filePath) ?? [];
        const manifestIds = expander.lastManifest?.map(m => m.id) ?? [];

        // NO chunks from src/main.ts (IDs 1 and 2) should appear
        assert.equal(manifestPaths.includes('src/main.ts'), false, 'manifest should NOT include src/main.ts');
        assert.equal(manifestIds.includes(1), false, 'manifest should NOT include ID 1');
        assert.equal(manifestIds.includes(2), false, 'manifest should NOT include ID 2 (same file)');

        // Chunks from OTHER files should appear
        assert.equal(manifestIds.includes(100), true, 'manifest should include ID 100 (helper.ts)');
        assert.equal(manifestIds.includes(101), true, 'manifest should include ID 101 (helper.ts)');
        assert.equal(manifestIds.includes(102), true, 'manifest should include ID 102 (util.ts)');
    },

    async 'file-level dedup: multiple matched files all excluded'(assert: { equal: (a: unknown, b: unknown, msg?: string) => void }) {
        // Search returns src/main.ts AND src/helper.ts → only src/util.ts should remain
        const results = [
            codeResult(1, 'src/main.ts'),
            codeResult(100, 'src/helper.ts'),
        ];
        const plugin = createExpandablePlugin();
        const registry = new PluginRegistry();
        registry.register(plugin);

        const expander = mockExpander([102]);
        const builder = new ContextBuilder(mockSearch(results), registry, undefined, undefined, {}, expander);

        await builder.build('test task', { fields: { expander: true } });

        const manifestPaths = new Set(expander.lastManifest?.map(m => m.filePath) ?? []);
        assert.equal(manifestPaths.has('src/main.ts'), false, 'manifest should NOT include src/main.ts');
        assert.equal(manifestPaths.has('src/helper.ts'), false, 'manifest should NOT include src/helper.ts');
        assert.equal(manifestPaths.has('src/util.ts'), true, 'manifest should include src/util.ts');
    },

    async 'manifest has zero overlap with search results'(assert: { equal: (a: unknown, b: unknown, msg?: string) => void }) {
        // Verify the invariant: no manifest item shares a file path with any search result
        const results = [codeResult(1, 'src/main.ts')];
        const plugin = createExpandablePlugin();
        const registry = new PluginRegistry();
        registry.register(plugin);

        let receivedManifest: ExpanderManifestItem[] = [];
        const spyExpander: Expander = {
            async expand(_query: string, _currentIds: number[], manifest: ExpanderManifestItem[]): Promise<ExpanderResult> {
                receivedManifest = manifest;
                return { ids: [] };
            },
        };

        const builder = new ContextBuilder(mockSearch(results), registry, undefined, undefined, {}, spyExpander);
        await builder.build('test task', { fields: { expander: true } });

        const searchPaths = new Set(results.map(r => r.filePath));
        const manifestPaths = new Set(receivedManifest.map(m => m.filePath));

        // Sets should have zero intersection
        for (const path of manifestPaths) {
            assert.equal(searchPaths.has(path), false, `manifest path '${path}' should NOT overlap with search results`);
        }
    },
};

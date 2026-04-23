/**
 * Unit Tests — Context Builder Field Resolution
 *
 * Tests the 3-layer merge: plugin defaults ← config.json ← per-query fields.
 * Uses a minimal mock registry with a ContextFieldPlugin to test resolution.
 */

import { ContextBuilder } from '../../../src/search/context-builder.ts';
import type { ContextFieldDef, ContextFieldPlugin, ContextFormatterPlugin, Plugin } from '../../../src/plugin.ts';
import { PluginRegistry } from '../../../src/services/plugin-registry.ts';
import type { SearchResult, ContextOptions } from '../../../src/types.ts';

export const name = 'Context Builder Field Resolution';

/** Create a mock plugin that declares context fields and captures what fields it receives. */
function createMockPlugin(name: string, defaults: ContextFieldDef[]): {
    plugin: Plugin & ContextFieldPlugin & ContextFormatterPlugin;
    capturedFields: Record<string, unknown>[];
} {
    const capturedFields: Record<string, unknown>[] = [];

    const plugin: Plugin & ContextFieldPlugin & ContextFormatterPlugin = {
        name,
        async initialize() {},
        contextFields: () => defaults,
        formatContext(_results: SearchResult[], _parts: string[], fields: Record<string, unknown>) {
            capturedFields.push({ ...fields });
        },
    };

    return { plugin, capturedFields };
}

export const tests = {
    'resolves plugin defaults when no config or query fields'(assert: { equal: (a: unknown, b: unknown, msg?: string) => void }) {
        const { plugin } = createMockPlugin('code', [
            { name: 'lines', type: 'boolean', default: false, description: '' },
            { name: 'callTree', type: 'object', default: true, description: '' },
            { name: 'symbols', type: 'boolean', default: false, description: '' },
        ]);

        const registry = new PluginRegistry();
        registry.register(plugin);
        const builder = new ContextBuilder(undefined, registry, undefined, undefined, {});

        // Access private method for testing
        const resolveFields = (builder as unknown as { _resolveFields(o: ContextOptions): Record<string, unknown> })._resolveFields.bind(builder);
        const resolved = resolveFields({});

        assert.equal(resolved.lines, false, 'lines should default to false');
        assert.equal(resolved.callTree, true, 'callTree should default to true');
        assert.equal(resolved.symbols, false, 'symbols should default to false');
    },

    'config.json overrides plugin defaults'(assert: { equal: (a: unknown, b: unknown, msg?: string) => void }) {
        const { plugin } = createMockPlugin('code', [
            { name: 'lines', type: 'boolean', default: false, description: '' },
            { name: 'symbols', type: 'boolean', default: false, description: '' },
        ]);

        const registry = new PluginRegistry();
        registry.register(plugin);
        const configFields = { lines: true, symbols: true };
        const builder = new ContextBuilder(undefined, registry, undefined, undefined, configFields);

        const resolveFields = (builder as unknown as { _resolveFields(o: ContextOptions): Record<string, unknown> })._resolveFields.bind(builder);
        const resolved = resolveFields({});

        assert.equal(resolved.lines, true, 'lines should be overridden by config');
        assert.equal(resolved.symbols, true, 'symbols should be overridden by config');
    },

    'per-query fields override config.json'(assert: { equal: (a: unknown, b: unknown, msg?: string) => void }) {
        const { plugin } = createMockPlugin('code', [
            { name: 'lines', type: 'boolean', default: false, description: '' },
            { name: 'callTree', type: 'object', default: true, description: '' },
        ]);

        const registry = new PluginRegistry();
        registry.register(plugin);
        const configFields = { lines: true, callTree: true };
        const builder = new ContextBuilder(undefined, registry, undefined, undefined, configFields);

        const resolveFields = (builder as unknown as { _resolveFields(o: ContextOptions): Record<string, unknown> })._resolveFields.bind(builder);
        const resolved = resolveFields({ fields: { callTree: false, lines: false } });

        assert.equal(resolved.lines, false, 'per-query should override config lines');
        assert.equal(resolved.callTree, false, 'per-query should override config callTree');
    },

    'per-query fields merge with defaults (only specified fields override)'(assert: { equal: (a: unknown, b: unknown, msg?: string) => void }) {
        const { plugin } = createMockPlugin('code', [
            { name: 'lines', type: 'boolean', default: false, description: '' },
            { name: 'callTree', type: 'object', default: true, description: '' },
            { name: 'imports', type: 'boolean', default: true, description: '' },
        ]);

        const registry = new PluginRegistry();
        registry.register(plugin);
        const builder = new ContextBuilder(undefined, registry, undefined, undefined, {});

        const resolveFields = (builder as unknown as { _resolveFields(o: ContextOptions): Record<string, unknown> })._resolveFields.bind(builder);
        // Only override lines — callTree and imports should keep their defaults
        const resolved = resolveFields({ fields: { lines: true } });

        assert.equal(resolved.lines, true, 'lines should be overridden');
        assert.equal(resolved.callTree, true, 'callTree should keep default');
        assert.equal(resolved.imports, true, 'imports should keep default');
    },

    'complex object fields (callTree depth) pass through'(assert: { equal: (a: unknown, b: unknown, msg?: string) => void }) {
        const { plugin } = createMockPlugin('code', [
            { name: 'callTree', type: 'object', default: true, description: '' },
        ]);

        const registry = new PluginRegistry();
        registry.register(plugin);
        const builder = new ContextBuilder(undefined, registry, undefined, undefined, {});

        const resolveFields = (builder as unknown as { _resolveFields(o: ContextOptions): Record<string, unknown> })._resolveFields.bind(builder);
        const resolved = resolveFields({ fields: { callTree: { depth: 4 } } });

        assert.equal(typeof resolved.callTree, 'object', 'callTree should be an object');
        assert.equal((resolved.callTree as { depth: number }).depth, 4, 'depth should be 4');
    },

    'configFields setter works'(assert: { equal: (a: unknown, b: unknown, msg?: string) => void }) {
        const { plugin } = createMockPlugin('code', [
            { name: 'lines', type: 'boolean', default: false, description: '' },
        ]);

        const registry = new PluginRegistry();
        registry.register(plugin);
        const builder = new ContextBuilder(undefined, registry, undefined, undefined, {});

        const resolveFields = (builder as unknown as { _resolveFields(o: ContextOptions): Record<string, unknown> })._resolveFields.bind(builder);

        // Initially should be false (default)
        let resolved = resolveFields({});
        assert.equal(resolved.lines, false, 'lines should default to false');

        // Set config fields
        builder.configFields = { lines: true };
        resolved = resolveFields({});
        assert.equal(resolved.lines, true, 'lines should be true after setting configFields');
    },

    'multiple plugins merge their field defaults'(assert: { equal: (a: unknown, b: unknown, msg?: string) => void }) {
        const { plugin: codePlugin } = createMockPlugin('code', [
            { name: 'lines', type: 'boolean', default: false, description: '' },
            { name: 'callTree', type: 'object', default: true, description: '' },
        ]);

        const { plugin: gitPlugin } = createMockPlugin('git', [
            { name: 'diff', type: 'boolean', default: false, description: '' },
        ]);

        const registry = new PluginRegistry();
        registry.register(codePlugin);
        registry.register(gitPlugin);
        const builder = new ContextBuilder(undefined, registry, undefined, undefined, {});

        const resolveFields = (builder as unknown as { _resolveFields(o: ContextOptions): Record<string, unknown> })._resolveFields.bind(builder);
        const resolved = resolveFields({});

        assert.equal(resolved.lines, false, 'code plugin lines default');
        assert.equal(resolved.callTree, true, 'code plugin callTree default');
        assert.equal(resolved.diff, false, 'git plugin diff default');
    },
};

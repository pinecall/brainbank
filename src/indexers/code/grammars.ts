/**
 * BrainBank — Tree-Sitter Grammar Registry
 *
 * Maps language names to their tree-sitter grammar packages
 * and the AST node types that represent semantic blocks.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// ── Types ───────────────────────────────────────────

export interface LangGrammar {
    grammar: any;
    nodeTypes: {
        class?: string[];
        function?: string[];
        interface?: string[];
        variable?: string[];
        method?: string[];
        struct?: string[];
        impl?: string[];
    };
}

// ── Loader ──────────────────────────────────────────

/** Try to require a grammar, return null if not installed. */
function tryGrammar(pkg: string, nodeTypes: LangGrammar['nodeTypes'], accessor?: string): () => LangGrammar | null {
    return () => {
        try {
            const mod = require(pkg);
            return { grammar: accessor ? mod[accessor] : mod, nodeTypes };
        } catch { return null; }
    };
}

// ── Grammar Table ───────────────────────────────────

export const GRAMMARS: Record<string, () => LangGrammar | null> = {
    // ── Web ──────────────────────────────────────────
    typescript: tryGrammar('tree-sitter-typescript', {
        class: ['class_declaration'],
        interface: ['interface_declaration', 'type_alias_declaration'],
        function: ['function_declaration', 'method_definition'],
        variable: ['lexical_declaration'],
    }, 'typescript'),
    javascript: tryGrammar('tree-sitter-javascript', {
        class: ['class_declaration'],
        function: ['function_declaration', 'method_definition'],
        variable: ['lexical_declaration'],
    }),
    html: tryGrammar('tree-sitter-html', {}),
    css: tryGrammar('tree-sitter-css', {}),

    // ── Systems ──────────────────────────────────────
    go: tryGrammar('tree-sitter-go', {
        function: ['function_declaration', 'method_declaration'],
        struct: ['type_declaration'],
    }),
    rust: tryGrammar('tree-sitter-rust', {
        function: ['function_item'],
        struct: ['struct_item'],
        impl: ['impl_item'],
    }),
    c: tryGrammar('tree-sitter-c', {
        function: ['function_definition'],
        struct: ['struct_specifier'],
    }),
    cpp: tryGrammar('tree-sitter-cpp', {
        class: ['class_specifier'],
        function: ['function_definition'],
    }),
    swift: tryGrammar('tree-sitter-swift', {
        class: ['class_declaration'],
        function: ['function_declaration'],
        struct: ['struct_declaration'],
    }),

    // ── JVM ──────────────────────────────────────────
    java: tryGrammar('tree-sitter-java', {
        class: ['class_declaration'],
        interface: ['interface_declaration'],
        method: ['method_declaration'],
    }),
    kotlin: tryGrammar('tree-sitter-kotlin', {
        class: ['class_declaration'],
        function: ['function_declaration'],
    }),
    scala: tryGrammar('tree-sitter-scala', {
        class: ['class_definition'],
        function: ['function_definition'],
    }),

    // ── Scripting ────────────────────────────────────
    python: tryGrammar('tree-sitter-python', {
        class: ['class_definition'],
        function: ['function_definition'],
    }),
    ruby: tryGrammar('tree-sitter-ruby', {
        class: ['class'],
        method: ['method', 'singleton_method'],
    }),
    php: tryGrammar('tree-sitter-php', {
        class: ['class_declaration'],
        function: ['function_definition', 'method_declaration'],
    }, 'php'),
    lua: tryGrammar('tree-sitter-lua', {
        function: ['function_declaration'],
    }),
    bash: tryGrammar('tree-sitter-bash', {
        function: ['function_definition'],
    }),
    elixir: tryGrammar('tree-sitter-elixir', {
        function: ['call'],  // defmodule, def, defp
    }),

    // ── .NET ─────────────────────────────────────────
    c_sharp: tryGrammar('tree-sitter-c-sharp', {
        class: ['class_declaration'],
        interface: ['interface_declaration'],
        method: ['method_declaration'],
    }),
};

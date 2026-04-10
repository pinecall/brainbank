/**
 * @brainbank/code — Code Indexing Plugin
 * 
 * AST-aware code indexing for 20+ languages.
 * Requires tree-sitter grammars (JS/TS/Python/HTML bundled, others install separately).
 * 
 * @example
 *   import { BrainBank } from 'brainbank';
 *   import { code } from '@brainbank/code';
 *   
 *   const brain = new BrainBank().use(code({ repoPath: '.' }));
 */

export { code } from './plugin.js';
export type { CodePluginOptions } from './plugin.js';
export { CodeChunker } from './parsing/chunker.js';
export type { ChunkerConfig } from './parsing/chunker.js';
export { CodeWalker } from './indexing/walker.js';
export type { CodeWalkerDeps, CodeIndexOptions } from './indexing/walker.js';
export { GRAMMARS } from './parsing/grammars.js';
export type { LangGrammar } from './parsing/grammars.js';
export { extractImports, extractImportPaths } from './graph/import-extractor.js';
export type { ImportEdge, ImportKind } from './graph/import-extractor.js';
export { ImportResolver } from './graph/import-resolver.js';
export { extractSymbols, extractCallRefs } from './parsing/symbols.js';
export type { SymbolDef } from './parsing/symbols.js';
export type { DependencyGraph, DependencyNode, DependencyEdge } from './graph/provider.js';

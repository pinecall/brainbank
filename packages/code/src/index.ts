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

export { code } from './code-plugin.js';
export type { CodePluginOptions } from './code-plugin.js';
export { CodeChunker } from './code-chunker.js';
export type { ChunkerConfig } from './code-chunker.js';
export { CodeWalker } from './code-walker.js';
export type { CodeWalkerDeps, CodeIndexOptions } from './code-walker.js';
export { GRAMMARS } from './grammars.js';
export type { LangGrammar } from './grammars.js';
export { extractImports } from './import-extractor.js';
export { extractSymbols, extractCallRefs } from './symbol-extractor.js';
export type { SymbolDef } from './symbol-extractor.js';

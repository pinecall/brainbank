// Conversational memory
export { Memory } from './memory.js';
export type { MemoryStore, MemoryOptions, MemoryItem, MemoryAction, MemoryOperation, EntityOperation, ProcessResult } from './memory.js';
export { EntityStore } from './entities.js';
export type { Entity, Relationship, EntityStoreOptions, EntityStoreConfig, CollectionProvider, TraversalNode, TraversalResult } from './entities.js';
export { OpenAIProvider } from './llm.js';
export type { LLMProvider, ChatMessage, GenerateOptions, OpenAIProviderOptions } from './llm.js';

// Pattern learning
export { PatternStore } from './pattern-store.js';
export type { PatternStoreDeps } from './pattern-store.js';
export { Consolidator } from './consolidator.js';
export { PatternDistiller } from './pattern-distiller.js';
export { patterns, memory } from './patterns-plugin.js';

/** Type declarations for separate @brainbank packages (dynamic imports) */

declare module '@brainbank/reranker' {
    export interface Qwen3RerankerOptions {
        modelUri?: string;
        cacheDir?: string;
        contextSize?: number;
    }
    
    export class Qwen3Reranker {
        constructor(options?: Qwen3RerankerOptions);
        rank(query: string, documents: string[]): Promise<number[]>;
        close(): Promise<void>;
    }
}

declare module '@brainbank/mcp' {
    // MCP server auto-starts on import — no exports needed
}

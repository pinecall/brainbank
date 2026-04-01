/**
 * Type declarations for separate @brainbank packages (dynamic imports).
 * 
 * IMPORTANT: These are manually maintained. If you change the public API
 * of any @brainbank/* package, update the corresponding declarations here.
 * The canonical source is each package's own src/index.ts.
 * 
 * This file exists because these packages are not npm-linked during development.
 * Once they are published and installed as real dependencies, this file can be deleted.
 */

declare module '@brainbank/code' {
    interface CodePlugin {
        readonly name: string;
        initialize(ctx: any): Promise<void>;
        stats?(): Record<string, any>;
        close?(): void;
        index?(options?: any): Promise<any>;
    }
    export interface CodePluginOptions {
        repoPath?: string;
        name?: string;
        embeddingProvider?: any;
        maxFileSize?: number;
        ignore?: string[];
    }
    export function code(options?: CodePluginOptions): CodePlugin;
}

declare module '@brainbank/git' {
    interface GitPlugin {
        readonly name: string;
        initialize(ctx: any): Promise<void>;
        stats?(): Record<string, any>;
        close?(): void;
        index?(options?: any): Promise<any>;
    }
    export interface GitPluginOptions {
        repoPath?: string;
        name?: string;
        depth?: number;
        maxDiffBytes?: number;
        embeddingProvider?: any;
    }
    export function git(options?: GitPluginOptions): GitPlugin;
}

declare module '@brainbank/docs' {
    interface DocsPlugin {
        readonly name: string;
        initialize(ctx: any): Promise<void>;
        stats?(): Record<string, any>;
        close?(): void;
        search?(query: string, options?: any): Promise<any[]>;
    }
    export interface DocsPluginOptions {
        embeddingProvider?: any;
    }
    export function docs(options?: DocsPluginOptions): DocsPlugin;
}

declare module '@brainbank/mcp' {
    // MCP server auto-starts on import — no exports needed
}



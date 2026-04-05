/** brainbank mcp — Start MCP server (stdio). Requires @brainbank/mcp. */

import { c } from '@/cli/utils.ts';

export async function cmdMcp(): Promise<void> {
    try {
        await import('@brainbank/mcp');
    } catch {
        console.error(c.red('Error: @brainbank/mcp is not installed.'));
        console.error(c.dim('  Install: npm i @brainbank/mcp'));
        process.exit(1);
    }
}

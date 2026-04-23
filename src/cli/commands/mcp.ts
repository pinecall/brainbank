/** brainbank mcp — Start MCP server (stdio). */

export async function cmdMcp(): Promise<void> {
    // Import and run the MCP server directly from core
    await import('@/mcp/mcp-server.ts');
}

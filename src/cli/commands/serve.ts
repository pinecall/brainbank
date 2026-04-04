/**
 * brainbank serve — Start BrainBank server.
 *
 * Modes:
 *   brainbank serve              → MCP stdio transport (for AI clients)
 *   brainbank serve --http       → HTTP JSON API (foreground)
 *   brainbank serve --http --daemon  → HTTP JSON API (background)
 *   brainbank serve stop         → Stop the background daemon
 */

import { c, args, hasFlag, getFlag, stripFlags } from '@/cli/utils.ts';
import { isServerRunning, removePid, DEFAULT_PORT } from '@/services/daemon.ts';
import { createBrain } from '@/cli/factory/index.ts';

export async function cmdServe(): Promise<void> {
    const pos = stripFlags(args);
    const sub = pos[1];

    // brainbank serve stop
    if (sub === 'stop') {
        return stopDaemon();
    }

    // brainbank serve --http [--daemon] [--port N]
    if (hasFlag('http')) {
        return startHttp();
    }

    // brainbank serve (MCP stdio — default)
    try {
        await import('@brainbank/mcp');
    } catch {
        console.error(c.red('Error: @brainbank/mcp is not installed.'));
        console.error(c.dim('  Install: npm i @brainbank/mcp'));
        process.exit(1);
    }
}

// ── HTTP Server ─────────────────────────────────

async function startHttp(): Promise<void> {
    const port = parseInt(getFlag('port') ?? String(DEFAULT_PORT), 10);
    const daemon = hasFlag('daemon');

    if (daemon) {
        return forkDaemon(port);
    }

    // Foreground mode — start directly
    const { HttpServer } = await import('@/services/http-server.ts');

    const server = new HttpServer({
        port,
        factory: async (repoPath: string) => {
            const brain = await createBrain(repoPath);
            await brain.initialize();
            return brain;
        },
        onError: (repo, err) => {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(c.red(`  Pool error [${repo}]: ${msg}`));
        },
        onLog: (msg) => console.log(c.dim(`  ${msg}`)),
    });

    console.log(c.bold('\n━━━ BrainBank HTTP Server ━━━\n'));

    await server.start();

    console.log(c.dim(`  Port: ${port}`));
    console.log(c.dim('  Press Ctrl+C to stop.\n'));

    // Graceful shutdown
    const shutdown = () => {
        console.log(c.dim('\n  Shutting down...'));
        server.close();
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // Keep alive
    await new Promise(() => {});
}

// ── Daemon Management ───────────────────────────

async function forkDaemon(port: number): Promise<void> {
    const { fork } = await import('node:child_process');

    // Check if already running
    const existing = isServerRunning();
    if (existing) {
        console.log(c.yellow(`  Server already running (PID ${existing.pid}, port ${existing.port})`));
        return;
    }

    // Fork a child process that runs `brainbank serve --http --port N`
    // We re-run the same entry point without --daemon
    const child = fork(process.argv[1], ['serve', '--http', '--port', String(port)], {
        detached: true,
        stdio: 'ignore',
    });

    child.unref();

    console.log(c.green(`  ✓ BrainBank daemon started (PID ${child.pid}, port ${port})`));
    console.log(c.dim('  Stop with: brainbank serve stop'));
}

function stopDaemon(): void {
    const info = isServerRunning();
    if (!info) {
        console.log(c.yellow('  No server running.'));
        return;
    }

    try {
        process.kill(info.pid, 'SIGTERM');
        removePid();
        console.log(c.green(`  ✓ Server stopped (PID ${info.pid})`));
    } catch {
        removePid();
        console.log(c.yellow(`  PID ${info.pid} not found. Cleaned up stale PID file.`));
    }
}

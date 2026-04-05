/**
 * brainbank daemon — HTTP daemon for CLI delegation.
 *
 *   brainbank daemon              → Start foreground
 *   brainbank daemon start        → Start background (fork + PID file)
 *   brainbank daemon stop         → Stop background daemon
 *   brainbank daemon restart      → Stop + start
 */

import { c, args, getFlag, stripFlags } from '@/cli/utils.ts';
import { isServerRunning, removePid, DEFAULT_PORT } from '@/services/daemon.ts';
import { createBrain } from '@/cli/factory/index.ts';

export async function cmdDaemon(): Promise<void> {
    const pos = stripFlags(args);
    const sub = pos[1]; // start | stop | undefined

    if (sub === 'stop') return stopDaemon();
    if (sub === 'restart') { stopDaemon(); return forkDaemon(); }
    if (sub === 'start') return forkDaemon();
    return startForeground();
}

// ── Foreground ──────────────────────────────────

async function startForeground(): Promise<void> {
    const port = parseInt(getFlag('port') ?? String(DEFAULT_PORT), 10);
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

    console.log(c.bold('\n━━━ BrainBank HTTP Daemon ━━━\n'));

    await server.start();

    console.log(c.dim(`  Port: ${port}`));
    console.log(c.dim('  Press Ctrl+C to stop.\n'));

    const shutdown = () => {
        console.log(c.dim('\n  Shutting down...'));
        server.close();
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    await new Promise(() => {});
}

// ── Background ──────────────────────────────────

async function forkDaemon(): Promise<void> {
    const port = parseInt(getFlag('port') ?? String(DEFAULT_PORT), 10);
    const { fork } = await import('node:child_process');

    const existing = isServerRunning();
    if (existing) {
        console.log(c.yellow(`  Daemon already running (PID ${existing.pid}, port ${existing.port})`));
        return;
    }

    const child = fork(process.argv[1], ['daemon', '--port', String(port)], {
        detached: true,
        stdio: 'ignore',
    });

    child.unref();

    console.log(c.green(`  ✓ Daemon started (PID ${child.pid}, port ${port})`));
    console.log(c.dim('  Stop with: brainbank daemon stop'));
}

function stopDaemon(): void {
    const info = isServerRunning();
    if (!info) {
        console.log(c.yellow('  No daemon running.'));
        return;
    }

    try {
        process.kill(info.pid, 'SIGTERM');
        removePid();
        console.log(c.green(`  ✓ Daemon stopped (PID ${info.pid})`));
    } catch {
        removePid();
        console.log(c.yellow(`  PID ${info.pid} not found. Cleaned up stale PID file.`));
    }
}

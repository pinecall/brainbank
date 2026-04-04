/**
 * Status Command — Show BrainBank server status.
 *
 * Usage: brainbank status
 */

import { c } from '@/cli/utils.ts';
import { serverHealth } from '@/cli/server-client.ts';
import { isServerRunning } from '@/services/daemon.ts';

function formatUptime(seconds: number): string {
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const remainMinutes = minutes % 60;
    return remainMinutes > 0 ? `${hours}h ${remainMinutes}m` : `${hours}h`;
}

export async function cmdStatus(): Promise<void> {
    const info = isServerRunning();

    if (!info) {
        console.log(`\n  ${c.dim('HTTP Server:')} ${c.yellow('stopped')}\n`);
        console.log(c.dim('  Start with: brainbank serve --http'));
        console.log('');
        return;
    }

    // Try to get detailed health from the server
    const health = await serverHealth();

    if (health) {
        const uptime = formatUptime(health.uptime);
        console.log(`\n  ${c.dim('HTTP Server:')} ${c.green('running')}`);
        console.log(`  ${c.dim('PID:')}         ${health.pid}`);
        console.log(`  ${c.dim('Port:')}        ${health.port}`);
        console.log(`  ${c.dim('Uptime:')}      ${uptime}`);
        console.log(`  ${c.dim('Workspaces:')}  ${health.workspaces}`);
        console.log('');
    } else {
        // PID file exists but server not responding
        console.log(`\n  ${c.dim('HTTP Server:')} ${c.yellow('stale')} (PID ${info.pid} not responding)`);
        console.log(c.dim('  The PID file may be stale. Restart with: brainbank serve --http'));
        console.log('');
    }
}

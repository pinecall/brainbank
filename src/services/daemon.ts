/**
 * Daemon — PID file management for the BrainBank HTTP server.
 *
 * PID file: ~/.cache/brainbank/server.pid
 * Format: JSON { pid: number, port: number }
 *
 * Used by:
 *   - `brainbank daemon` to write PID on start
 *   - `brainbank daemon stop` to find and kill the daemon
 *   - `brainbank status` to report server state
 *   - CLI commands to detect running server for delegation
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export const DEFAULT_PORT = 8181;

interface PidInfo {
    pid: number;
    port: number;
}

/** Directory for PID file and other cache data. */
function cacheDir(): string {
    return path.join(os.homedir(), '.cache', 'brainbank');
}

/** Full path to the PID file. */
function pidPath(): string {
    return path.join(cacheDir(), 'server.pid');
}

/** Write the PID file after server starts. */
export function writePid(pid: number, port: number): void {
    const dir = cacheDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(pidPath(), JSON.stringify({ pid, port } as PidInfo));
}

/** Read PID info from file. Returns null if missing or malformed. */
export function readPid(): PidInfo | null {
    try {
        const raw = fs.readFileSync(pidPath(), 'utf8');
        const info = JSON.parse(raw) as PidInfo;
        if (typeof info.pid !== 'number' || typeof info.port !== 'number') return null;
        return info;
    } catch {
        return null;
    }
}

/** Remove the PID file. */
export function removePid(): void {
    try {
        fs.unlinkSync(pidPath());
    } catch {
        // File doesn't exist — safe to ignore
    }
}

/**
 * Check if the server process is still alive.
 * Uses `kill(pid, 0)` which doesn't actually send a signal —
 * it just checks whether the process exists.
 */
export function isServerRunning(): PidInfo | null {
    const info = readPid();
    if (!info) return null;

    try {
        process.kill(info.pid, 0);
        return info;
    } catch {
        // Process not running — stale PID file
        removePid();
        return null;
    }
}

/** Get the server URL if running, or null. */
export function getServerUrl(): string | null {
    const info = isServerRunning();
    if (!info) return null;
    return `http://localhost:${info.port}`;
}

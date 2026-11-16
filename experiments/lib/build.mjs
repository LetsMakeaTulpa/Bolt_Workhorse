// Shared plumbing for the experiment suites: where to write a bundle, how to build one, and the
// minimum WebSocket supabase-js insists on. Every suite used to hardcode /tmp, which Node reads as
// C:\tmp on Windows, and to spawn `npx`, which cannot be spawned through cmd.exe. Neither is needed:
// esbuild already ships with vite, and os.tmpdir() is correct on every platform.
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** An absolute temp path with forward slashes, so it survives being pasted into a URL or a flag. */
export const tmpPath = (name) => join(tmpdir(), name).replaceAll('\\', '/');

/** The esbuild binary that came with vite; run it under node so no shell is involved. */
export const ESBUILD = fileURLToPath(new URL('../..', import.meta.url)).length
  ? fileURLToPath(new URL('../../node_modules/esbuild/bin/esbuild', import.meta.url))
  : 'esbuild';

/** Build one entry point to `out`. Throws with the child's stderr rather than an ENOENT. */
export function bundle(entry, out, extra = []) {
  const args = [ESBUILD, entry, '--bundle', '--format=esm', `--outfile=${out}`, '--log-level=error', ...extra];
  execFileSync(process.execPath, args, { stdio: 'inherit' });
  return out;
}

/** Build synchronously and capture the result, for suites that assert on a failure. */
export function bundleSync(entry, out, extra = []) {
  return spawnSync(process.execPath, [ESBUILD, entry, '--bundle', '--format=esm', `--outfile=${out}`, '--log-level=error', ...extra], {
    encoding: 'utf8',
  });
}

/** Import a built file by URL, which is what Windows needs for a bare C:/ path. */
export const asUrl = (path) => pathToFileURL(path).href;

/**
 * supabase-js constructs its realtime client on import and throws if WebSocket is undefined.
 * Node 20 has no global WebSocket, so suites that bundle api.ts or the handler need a stand-in
 * that answers the handful of members the client touches without ever opening a connection.
 */
export function installWebSocketStub() {
  if (globalThis.WebSocket) return globalThis.WebSocket;
  class WebSocketStub {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    constructor(url) {
      this.url = url;
      this.readyState = WebSocketStub.CONNECTING;
      this.listeners = new Map();
    }
    addEventListener(type, handler) {
      const list = this.listeners.get(type) ?? [];
      list.push(handler);
      this.listeners.set(type, list);
    }
    removeEventListener(type, handler) {
      this.listeners.set(type, (this.listeners.get(type) ?? []).filter((h) => h !== handler));
    }
    send() {}
    close() {
      this.readyState = WebSocketStub.CLOSED;
    }
  }
  globalThis.WebSocket = WebSocketStub;
  return WebSocketStub;
}

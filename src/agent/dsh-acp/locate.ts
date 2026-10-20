import { existsSync } from 'node:fs';
import { backendsBinPath } from '../backend-loader';
import { spawnProcess, spawnProcessSync } from '../../platform/spawn';

const IS_WIN = process.platform === 'win32';

/**
 * macOS DeepSeek Harness.app ships a self-contained `dsh` launcher at a stable
 * path. It runs the app's own Node runtime (so it does not depend on the user's
 * Node version) and works from a launchd service with a minimal environment
 * (verified with `env -i`).
 */
const MAC_APP_DSH =
  '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh';

let binCache: string | null = null;
const versionCache = new Map<string, string>();

/**
 * Resolve the dsh CLI, in priority order:
 *   1. $DSH_BIN (explicit override)
 *   2. macOS DeepSeek Harness.app bundled launcher
 *   3. bridge-managed npm install (~/.feishu-codex-bridge/backends/node_modules/.bin/dsh)
 *   4. PATH (`dsh`, via `where`/`which`)
 *
 * Only successful lookups are cached; a user installing dsh afterwards becomes
 * visible on the next force-probe (doctor / picker).
 */
export function resolveDshBin(opts?: { force?: boolean }): string | null {
  if (!opts?.force && binCache && existsSync(binCache)) return binCache;
  binCache = locateBin();
  return binCache;
}

function locateBin(): string | null {
  const env = process.env.DSH_BIN;
  if (env && existsSync(env)) return env;

  if (process.platform === 'darwin' && existsSync(MAC_APP_DSH)) return MAC_APP_DSH;

  const managed = backendsBinPath('dsh');
  if (managed && existsSync(managed)) return managed;

  const onPath = which('dsh');
  if (onPath) return onPath;

  return null;
}

function which(cmd: string): string | null {
  try {
    // `where` (Windows) / `which` (POSIX) are real executables; cross-spawn runs
    // them uniformly. `where` may return multiple lines — take the first.
    const res = spawnProcessSync(IS_WIN ? 'where' : 'which', [cmd], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (res.status !== 0 || typeof res.stdout !== 'string') return null;
    const first = res.stdout
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean);
    return first && existsSync(first) ? first : null;
  } catch {
    return null;
  }
}

/**
 * Best-effort async `dsh --version`. Async (not spawnSync) because doctor runs
 * from card/Web callbacks and must not freeze the event loop.
 */
export async function dshVersionAsync(bin: string, opts?: { force?: boolean }): Promise<string | null> {
  if (!opts?.force) {
    const hit = versionCache.get(bin);
    if (hit !== undefined) return hit;
  }
  const out = await new Promise<string | null>((resolve) => {
    let child;
    try {
      child = spawnProcess(bin, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve(null);
      return;
    }
    let stdout = '';
    // A wedged launcher must not freeze doctor / smart-default detection.
    const timer = setTimeout(() => {
      try {
        child?.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      resolve(null);
    }, 5_000);
    timer.unref?.();
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? stdout.trim() : null);
    });
  });
  if (out !== null) versionCache.set(bin, out);
  return out;
}

import type { ChildProcess } from 'node:child_process';
import type { Writable } from 'node:stream';
import { createInterface, type Interface } from 'node:readline';
import { killProcessGroup, spawnProcess } from '../../platform/spawn';
import type {
  AcpClientOptions,
  AcpMessage,
  AcpPermissionOutcome,
  AcpPermissionRequest,
  AcpUpdate,
} from './protocol';

/** JSON-RPC error codes used for client-side rejections. */
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer?: NodeJS.Timeout;
  method: string;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
}

/**
 * ACP v1 stdio client for `dsh --profile acp`.
 *
 * One client owns one dsh process and one session. The bridge's thread model is
 * one backend session per topic, so isolating processes keeps crash/close
 * semantics simple and lets `isAlive()` map to a single child exit.
 *
 * The client is deliberately thin: request/response correlation plus transport
 * for server→client notifications/requests. Turn semantics and event mapping
 * live in DshAcpThread / event-map.
 */
export class AcpClient {
  readonly bin: string;
  readonly cwd: string;

  /** Called for every `session/update` notification. */
  onUpdate: (update: AcpUpdate) => void = () => undefined;
  /** Called for `session/request_permission`; the default cancels the request. */
  onPermission: (request: AcpPermissionRequest) => AcpPermissionOutcome | Promise<AcpPermissionOutcome> =
    () => ({ outcome: 'cancelled' });
  /** Called for each non-empty stderr line (diagnostics). */
  onStderr: (line: string) => void = () => undefined;
  /** Called once when the child exits (normal close included). */
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void = () => undefined;

  private readonly child: ChildProcess;
  private readonly stdin: Writable;
  private readonly stdout: Interface;
  private readonly stderr: Interface | undefined;
  private readonly ready: Promise<void>;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private dead = false;
  private exitNotified = false;
  private closing: Promise<void> | undefined;
  private sessionIdValue: string | undefined;
  private lastActivityValue = Date.now();
  private exitResolve: () => void = () => undefined;
  private readonly exited: Promise<void>;

  constructor(opts: AcpClientOptions) {
    this.bin = opts.bin;
    this.cwd = opts.cwd;

    // cross-spawn handles Windows `.cmd` shims; windowsHide keeps a hidden
    // service from popping a console window.
    this.child = spawnProcess(opts.bin, opts.args ?? ['--profile', 'acp'], {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // POSIX: make the child a process-group leader so a wedged dsh can be
      // stopped with its descendants (killProcessGroup). Windows uses taskkill /T.
      detached: process.platform !== 'win32',
    });

    const stdin = this.child.stdin;
    const stdout = this.child.stdout;
    if (!stdin || !stdout) {
      throw new Error('无法启动 DSH ACP：子进程缺少 stdin/stdout 管道');
    }
    this.stdin = stdin;

    this.exited = new Promise<void>((resolve) => {
      this.exitResolve = resolve;
    });

    this.ready = new Promise<void>((resolve, reject) => {
      this.child.once('spawn', () => resolve());
      this.child.once('error', (err) => reject(err));
    });
    // A failed spawn is also reported by start(); mark this rejection handled so
    // an early failure cannot crash the daemon with an unhandled rejection.
    void this.ready.catch(() => undefined);

    this.stdout = createInterface({ input: stdout });
    this.stdout.on('line', (line) => this.handleLine(line));

    const stderr = this.child.stderr;
    if (stderr) {
      this.stderr = createInterface({ input: stderr });
      this.stderr.on('line', (line) => {
        const trimmed = line.trimEnd();
        if (trimmed) this.onStderr(trimmed);
      });
    }

    this.child.on('exit', (code, signal) => this.handleExit(code, signal));
    this.child.on('error', (err) => {
      // A post-spawn error (EPIPE etc.) is a death as far as the thread is
      // concerned; fail pending requests so a turn cannot hang forever.
      if (!this.dead) {
        this.dead = true;
        this.failAll(new Error(`DSH ACP 进程错误：${errorMessage(err)}`));
        this.resolveExit();
        this.notifyExit(null, null);
      }
    });
  }

  /** Wait for the child process to actually spawn. */
  async start(): Promise<void> {
    await this.ready;
    if (this.dead) throw new Error('DSH ACP 进程在启动阶段退出');
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get sessionId(): string | undefined {
    return this.sessionIdValue;
  }

  setSessionId(sessionId: string): void {
    this.sessionIdValue = sessionId;
  }

  isAlive(): boolean {
    return !this.dead && this.child.exitCode === null;
  }

  lastActivity(): number {
    return this.lastActivityValue;
  }

  /**
   * Send a JSON-RPC request. `timeoutMs <= 0` means no client-side deadline: a
   * prompt is bounded by the bridge watchdog / ⏹ instead, matching the other
   * backends (the turn can legitimately run for minutes).
   */
  request<T = unknown>(method: string, params?: unknown, timeoutMs = 0): Promise<T> {
    if (this.dead) {
      return Promise.reject(new Error(`DSH ACP 进程已退出（${method}）`));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const pending: PendingRequest = {
        resolve: resolve as (value: unknown) => void,
        reject,
        method,
      };
      if (timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          if (!this.pending.delete(id)) return;
          reject(new Error(`DSH ACP ${method} 超时（${timeoutMs}ms）`));
        }, timeoutMs);
        pending.timer.unref?.();
      }
      this.pending.set(id, pending);
      try {
        this.write({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        this.pending.delete(id);
        if (pending.timer) clearTimeout(pending.timer);
        reject(new Error(`DSH ACP 写入失败：${errorMessage(err)}`));
      }
    });
  }

  /** Send a JSON-RPC notification (no response expected). */
  notify(method: string, params?: unknown): void {
    if (this.dead) return;
    try {
      this.write({ jsonrpc: '2.0', method, params });
    } catch {
      /* the exit handler will surface the death to the thread */
    }
  }

  /**
   * Close the session and the process. `session/close` first (quiesces DSH),
   * then stdin EOF (the ACP app's documented graceful-exit trigger), then a
   * bounded SIGTERM/SIGKILL fallback. Never throws.
   */
  close(): Promise<void> {
    this.closing ??= this.doClose();
    return this.closing;
  }

  private async doClose(): Promise<void> {
    if (this.dead) {
      await this.closed();
      return;
    }
    const sessionId = this.sessionIdValue;
    if (sessionId) {
      // ACP app binds stdin EOF to shutdown; session/close first lets it flush
      // persistence and dispose the agent. Ignore failures: the process may
      // already be wedged, and the EOF/kill path below is authoritative.
      try {
        await this.request('session/close', { sessionId }, 8_000);
      } catch {
        /* ignore */
      }
    }
    try {
      this.stdin.end();
    } catch {
      /* ignore */
    }
    if (!(await this.waitExit(3_000))) {
      // Escalate to the whole process group/tree: `dsh` may have spawned tool
      // children that a single SIGTERM to the launcher would orphan.
      await killProcessGroup(this.child.pid, () => this.dead || this.child.exitCode !== null, {
        graceMs: 3_000,
      });
      await this.waitExit(1_000);
    }
    this.dead = true;
    this.failAll(new Error('DSH ACP 会话已关闭'));
    this.resolveExit();
  }

  private write(msg: AcpMessage): void {
    if (this.stdin.destroyed) throw new Error('DSH ACP stdin 已关闭');
    this.stdin.write(JSON.stringify(msg) + '\n');
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    this.lastActivityValue = Date.now();

    let msg: AcpMessage;
    try {
      msg = JSON.parse(line) as AcpMessage;
    } catch {
      // Stdout is protocol-only by contract; a stray line is a protocol bug, not
      // a reason to kill the turn. Surface it on stderr for diagnosis.
      this.onStderr(`[非 JSON stdout] ${line.slice(0, 300)}`);
      return;
    }

    if (typeof msg.method === 'string') {
      if (msg.id !== undefined) {
        void this.handleServerRequest(msg);
      } else if (msg.method === 'session/update') {
        const update = (msg.params as { update?: AcpUpdate } | undefined)?.update;
        if (update) this.onUpdate(update);
      }
      return;
    }

    if (msg.id === undefined) return;
    const id = Number(msg.id);
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    if (msg.error) {
      const detail = msg.error.data === undefined ? '' : ` ${JSON.stringify(msg.error.data)}`;
      pending.reject(new Error(`${msg.error.message ?? 'ACP 请求失败'}${detail}`));
    } else {
      pending.resolve(msg.result);
    }
  }

  private async handleServerRequest(msg: AcpMessage): Promise<void> {
    const id = msg.id;
    if (id === undefined) return;

    if (msg.method === 'session/request_permission') {
      const request = (msg.params ?? {}) as AcpPermissionRequest;
      try {
        const outcome = await this.onPermission(request);
        this.respond(id, { outcome });
      } catch (err) {
        this.respondError(id, INTERNAL_ERROR, `权限应答失败：${errorMessage(err)}`);
      }
      return;
    }

    // We advertise no filesystem/terminal/elicitation capabilities, so any other
    // server request is unexpected. Answer explicitly so DSH never hangs waiting.
    this.respondError(id, METHOD_NOT_FOUND, `不支持的客户端方法：${msg.method}`);
  }

  private respond(id: number | string, result: unknown): void {
    try {
      this.write({ jsonrpc: '2.0', id, result });
    } catch {
      /* ignore; the process is going down */
    }
  }

  private respondError(id: number | string, code: number, message: string): void {
    try {
      this.write({ jsonrpc: '2.0', id, error: { code, message } });
    } catch {
      /* ignore */
    }
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.dead = true;
    this.stdout.close();
    this.stderr?.close();
    this.failAll(new Error(`DSH ACP 进程已退出（code=${code ?? 'null'}, signal=${signal ?? 'null'}）`));
    this.resolveExit();
    this.notifyExit(code, signal);
  }

  private notifyExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exitNotified) return;
    this.exitNotified = true;
    try {
      this.onExit(code, signal);
    } catch {
      /* onExit is observer-only; never let it break teardown */
    }
  }

  private failAll(err: Error): void {
    for (const [, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }

  private resolveExit(): void {
    this.exitResolve();
  }

  private closed(): Promise<void> {
    return this.exited;
  }

  private async waitExit(ms: number): Promise<boolean> {
    if (this.dead) return true;
    return Promise.race([
      this.exited.then(() => true),
      sleep(ms).then(() => this.dead),
    ]);
  }
}

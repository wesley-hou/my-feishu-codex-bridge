import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { paths } from '../../config/paths';
import { log } from '../../core/logger';
import { mergeProcessEnv } from '../../platform/spawn';
import type {
  AgentBackend,
  AgentCapabilities,
  AgentThread,
  BackendProbe,
  ModelInfo,
  PermissionMode,
  ReasoningEffort,
  ResumeThreadOptions,
  StartThreadOptions,
  ThreadHistory,
  ThreadSummary,
} from '../types';
import { AcpClient } from './client';
import type { AcpClientOptions } from './protocol';
import { dshVersionAsync, resolveDshBin } from './locate';
import {
  STATIC_MODELS,
  encodeModelValue,
  modelsFromConfigOptions,
  pickDefaultModel,
  toDshEffort,
} from './model';
import type {
  AcpConfigOption,
  AcpInitializeResult,
  AcpNewSessionResult,
  AcpResumeSessionResult,
} from './protocol';
import { DshAcpThread } from './thread';

const INIT_TIMEOUT_MS = 30_000;
const SESSION_TIMEOUT_MS = 60_000;
const CONFIG_TIMEOUT_MS = 20_000;

const INSTALL_HINT =
  '未找到 dsh CLI。装 DeepSeek Harness 桌面版，或 npm i -g @deepseek-ai/dsh，' +
  '或设置 DSH_BIN 指向 dsh 可执行文件。';

interface AppliedConfig {
  model?: string;
  effort?: ReasoningEffort;
  configOptions: AcpConfigOption[];
}

/** Test seam: lets the backend integration test run the fake ACP agent via
 * `node fixture.mjs` (cross-platform) instead of a shebang executable. */
export type DshClientFactory = (opts: AcpClientOptions) => AcpClient;

/**
 * Map the bridge permission tier to DSH's sandbox mode.
 *
 * `qa` maps to DSH's read-only mode, which is a WEAK tier: it denies file
 * writes but does NOT confine reads or network (verified on macOS). The
 * bridge's UI labels this backend's qa as「DSH 只读（弱）」; it is not a
 * confidentiality boundary. Use write/full for trusted projects, or run DSH
 * in a container when the project needs real read isolation.
 */
export function dshPermissionMode(mode: PermissionMode | undefined): string {
  if (mode === 'qa') return 'read-only';
  if (mode === 'full') return 'danger-full-access';
  // undefined (legacy record) → the safer middle tier, not whole-machine access.
  return 'workspace-write';
}

/**
 * DeepSeek Harness ACP backend.
 *
 * Each thread owns one `dsh --profile acp` process and one ACP session. The
 * adapter maps the standard ACP surface (new/resume/prompt/cancel/close,
 * session/update, request_permission) onto the bridge's backend-neutral
 * AgentBackend/AgentThread contract.
 *
 * Capability boundaries (deliberate, see docs):
 *   goal    — ACP has no goal method; hide /goal.
 *   steer   — ACP allows one prompt in flight; the bridge queues.
 *   compact — ACP has no compaction method; DSH compacts internally.
 *   resume  — resumeThread (restart recovery) works, but ACP exposes no
 *             transcript/title, so the /resume picker is hidden.
 *   approvals — permission requests are rejected by default; a Feishu approval
 *             card would be a separate slice.
 *   qa      — exposed as a WEAK read-only tier: writes are denied, but reads
 *             outside the workspace and network egress stay open. The UI
 *             labels it explicitly as「DSH 只读（弱）」.
 */
export class DshAcpBackend implements AgentBackend {
  readonly id = 'dsh-acp';
  readonly displayName = 'DeepSeek Harness';
  readonly capabilities: AgentCapabilities = {
    goal: false,
    steer: false,
    compact: false,
    resume: false,
    approvals: false,
  };
  /** qa is the weak read-only tier (writes denied; reads/network not confined). */
  readonly supportedModes: readonly PermissionMode[] = ['qa', 'write', 'full'];

  private modelCache: ModelInfo[] | null = null;

  constructor(private readonly makeClient: DshClientFactory = (opts) => new AcpClient(opts)) {}

  async isAvailable(): Promise<boolean> {
    return (await this.doctor()).ok;
  }

  async doctor(opts?: { force?: boolean }): Promise<BackendProbe> {
    const bin = resolveDshBin(opts);
    if (!bin) {
      return {
        ok: false,
        version: null,
        installable: false,
        depState: 'external-missing',
        hint: INSTALL_HINT,
      };
    }
    const version = await dshVersionAsync(bin, opts);
    if (!version) {
      return {
        ok: false,
        version: null,
        location: bin,
        installable: false,
        depState: 'external-missing',
        hint: `dsh --version 执行失败（${bin}）`,
      };
    }
    return {
      ok: true,
      version,
      location: bin,
      depState: 'installed',
      hint: hasDshCredentials()
        ? '复用本机 DSH 登录（~/.dsh）；模型默认走 DeepSeek Account'
        : '未检测到 DSH 登录凭据：请在 DSH 桌面版登录 DeepSeek 账号，或设置 DEEPSEEK_API_KEY',
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    if (this.modelCache) return this.modelCache;
    if (!resolveDshBin()) return [...STATIC_MODELS];

    const probeCwd = join(paths.appDir, 'dsh-models-probe');
    let client: AcpClient | undefined;
    try {
      mkdirSync(probeCwd, { recursive: true });
      client = await this.connect(probeCwd, 'write');
      const session = await this.newSession(client, probeCwd);
      const models = modelsFromConfigOptions(session.configOptions ?? []);
      this.modelCache = models.length ? models : [...STATIC_MODELS];
      return this.modelCache;
    } catch (err) {
      log.fail('agent', err, { backend: 'dsh-acp', phase: 'model-discovery' });
      return [...STATIC_MODELS];
    } finally {
      if (client) {
        await client.close().catch((err: unknown) => {
          log.fail('agent', err, { backend: 'dsh-acp', phase: 'model-probe-close' });
        });
      }
    }
  }

  /**
   * ACP's session/list returns ids + cwd only (no title/preview/timestamp), and
   * the bridge's resume picker also needs a transcript. With capabilities.resume
   * = false this is never called for the picker; restart recovery still uses
   * resumeThread directly.
   */
  async listThreads(_cwd: string, _limit = 15): Promise<ThreadSummary[]> {
    return [];
  }

  async readHistory(_cwd: string, _sessionId: string, _maxTurns = 10): Promise<ThreadHistory> {
    return { turns: [], totalTurns: 0 };
  }

  async startThread(opts: StartThreadOptions): Promise<AgentThread> {
    const client = await this.connect(opts.cwd, opts.mode);
    try {
      const session = await this.newSession(client, opts.cwd);
      const applied = await this.applyConfig(
        client,
        session.configOptions ?? [],
        opts.model,
        opts.effort,
        true,
      );
      return new DshAcpThread({
        sessionId: session.sessionId,
        cwd: opts.cwd,
        client,
        model: applied.model,
        effort: applied.effort,
        injectInstructions: true,
      });
    } catch (err) {
      await client.close().catch(() => undefined);
      throw err;
    }
  }

  async resumeThread(opts: ResumeThreadOptions): Promise<AgentThread> {
    const client = await this.connect(opts.cwd, opts.mode);
    try {
      const resumed = await client.request<AcpResumeSessionResult>(
        'session/resume',
        { sessionId: opts.sessionId, cwd: opts.cwd, mcpServers: [] },
        SESSION_TIMEOUT_MS,
      );
      client.setSessionId(opts.sessionId);
      // A stale persisted model must not brick recovery: log and keep the
      // restored route instead of failing the whole resume.
      const applied = await this.applyConfig(
        client,
        resumed.configOptions ?? [],
        opts.model,
        opts.effort,
        false,
      );
      return new DshAcpThread({
        sessionId: opts.sessionId,
        cwd: opts.cwd,
        client,
        model: applied.model ?? opts.model,
        effort: applied.effort ?? opts.effort,
        injectInstructions: false,
      });
    } catch (err) {
      await client.close().catch(() => undefined);
      throw err;
    }
  }

  private async connect(cwd: string, mode: PermissionMode | undefined): Promise<AcpClient> {
    const bin = resolveDshBin();
    if (!bin) throw new Error(INSTALL_HINT);

    const resolvedMode = dshPermissionMode(mode);
    if (mode === 'qa') {
      log.info('agent', 'dsh-weak-read-only', {
        backend: 'dsh-acp',
        note: 'DSH read-only denies writes but does not confine reads/network',
      });
    }
    const env = mergeProcessEnv(process.env, {
      DSH_PERMISSION_MODE: resolvedMode,
      // Marks a bridge-owned session for any DSH skill/hook that cares; mirrors
      // the Claude/Codex backends' re-entrancy marker.
      FEISHU_CODEX_BRIDGE: '1',
    });

    const client = this.makeClient({ bin, cwd, env });
    try {
      await client.start();
      await client.request<AcpInitializeResult>(
        'initialize',
        {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { name: 'feishu-codex-bridge', version: '1.0.0' },
        },
        INIT_TIMEOUT_MS,
      );
      log.info('agent', 'dsh-connected', {
        backend: 'dsh-acp',
        bin,
        cwd,
        mode: resolvedMode,
      });
      return client;
    } catch (err) {
      await client.close().catch(() => undefined);
      throw new Error(`无法启动 DSH ACP（${bin}）：${errorMessage(err)}`);
    }
  }

  private async newSession(client: AcpClient, cwd: string): Promise<AcpNewSessionResult> {
    const session = await client.request<AcpNewSessionResult>(
      'session/new',
      { cwd, mcpServers: [] },
      SESSION_TIMEOUT_MS,
    );
    if (!session?.sessionId) throw new Error('DSH ACP session/new 未返回 sessionId');
    client.setSessionId(session.sessionId);
    return session;
  }

  /**
   * Apply the model/effort to a session. Without an explicit model we pick a
   * working default: DSH's shipped ACP profile defaults to deepseek-official,
   * which needs DEEPSEEK_API_KEY; the desktop login route is deepseek-account.
   */
  private async applyConfig(
    client: AcpClient,
    initialOptions: AcpConfigOption[],
    model: string | undefined,
    effort: ReasoningEffort | undefined,
    strict: boolean,
  ): Promise<AppliedConfig> {
    let configOptions = initialOptions;
    let chosen = model;

    if (chosen) {
      const value = encodeModelValue(chosen);
      const result = await this.setConfig(client, 'model', value, strict);
      if (result) configOptions = result.configOptions ?? configOptions;
    } else {
      const models = modelsFromConfigOptions(configOptions);
      chosen = pickDefaultModel(models);
      if (chosen) {
        const result = await this.setConfig(client, 'model', encodeModelValue(chosen), false);
        if (result) configOptions = result.configOptions ?? configOptions;
      }
    }

    if (effort) {
      const result = await this.setConfig(
        client,
        'reasoning_effort',
        toDshEffort(effort),
        strict,
      );
      if (result) configOptions = result.configOptions ?? configOptions;
    }

    return { model: chosen, effort, configOptions };
  }

  private async setConfig(
    client: AcpClient,
    configId: string,
    value: string | undefined,
    strict: boolean,
  ): Promise<{ configOptions?: AcpConfigOption[] } | undefined> {
    if (!value) {
      if (strict) throw new Error(`DSH 配置 ${configId} 的值无法编码`);
      return undefined;
    }
    try {
      return await client.request<{ configOptions?: AcpConfigOption[] }>(
        'session/set_config_option',
        { sessionId: client.sessionId, configId, value },
        CONFIG_TIMEOUT_MS,
      );
    } catch (err) {
      if (strict) throw new Error(`DSH 配置 ${configId} 失败：${errorMessage(err)}`);
      log.fail('agent', err, { backend: 'dsh-acp', phase: 'set_config_option', configId });
      return undefined;
    }
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function hasDshCredentials(): boolean {
  if (process.env.DEEPSEEK_API_KEY) return true;
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  return existsSync(join(dshHome, '.credentials.yaml'));
}

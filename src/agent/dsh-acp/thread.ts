import { log } from '../../core/logger';
import type {
  AgentEvent,
  AgentInput,
  AgentRun,
  AgentThread,
  CompactResult,
  ReasoningEffort,
  TurnOptions,
} from '../types';
import { BRIDGE_DEVELOPER_INSTRUCTIONS } from '../bridge-instructions';
import { AcpClient } from './client';
import { createUpdateMapper, type DshUpdateMapper } from './event-map';
import { encodeModelValue, toDshEffort } from './model';
import type { AcpPermissionOutcome, AcpPermissionRequest, AcpUpdate } from './protocol';

export interface DshThreadConfig {
  /** The DSH/ACP session id (persisted by the bridge as the thread id). */
  sessionId: string;
  cwd: string;
  /** Started client (initialize + session/new|resume already done). */
  client: AcpClient;
  model?: string;
  effort?: ReasoningEffort;
  /** New sessions only: prepend the bridge's Feishu output conventions once. */
  injectInstructions?: boolean;
  /**
   * Forward ACP `agent_thought_chunk` to the card. Default false: DSH's
   * chain-of-thought is verbose and noisy in Feishu; the final answer and tool
   * groups are enough. Set DSH_SHOW_THINKING=1 for debugging.
   */
  showThinking?: boolean;
}

type TurnItem = AgentEvent | '__end__';

/** A minimal single-consumer async queue (push now, await later). */
class Inbox<T> {
  private readonly buf: T[] = [];
  private readonly waiters: ((value: T) => void)[] = [];

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(value);
    else this.buf.push(value);
  }

  next(): Promise<T> {
    const value = this.buf.shift();
    if (value !== undefined) return Promise.resolve(value);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

interface ActiveTurn {
  turnId: string;
  sink: (item: TurnItem) => void;
  mapper: DshUpdateMapper;
  cancelRequested: boolean;
  ended: boolean;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * One DSH ACP session, driven over one `dsh --profile acp` process.
 *
 * The ACP server allows one prompt in flight per session; the bridge already
 * serializes turns per topic, so this thread keeps the same contract. `abort`
 * maps to `session/cancel`, which DSH settles with `stopReason: cancelled`.
 */
export class DshAcpThread implements AgentThread {
  readonly sessionId: string;
  /** ACP has no in-flight steer surface; the bridge queues the next message. */
  readonly supportsSteer = false;

  private readonly client: AcpClient;
  private readonly cwd: string;
  private readonly injectInstructions: boolean;
  private readonly showThinking: boolean;
  private model: string | undefined;
  private effort: ReasoningEffort | undefined;
  private instructionsSent = false;
  private dead = false;
  private closing = false;
  private turnSeq = 0;
  private currentTurnId: string | undefined;
  private lastActivityAt = Date.now();
  private active: ActiveTurn | undefined;

  constructor(cfg: DshThreadConfig) {
    this.sessionId = cfg.sessionId;
    this.cwd = cfg.cwd;
    this.client = cfg.client;
    this.model = cfg.model;
    this.effort = cfg.effort;
    this.injectInstructions = cfg.injectInstructions === true;
    this.showThinking = cfg.showThinking === true;

    this.client.onUpdate = (update) => this.handleUpdate(update);
    this.client.onExit = (code, signal) => this.handleExit(code, signal);
    this.client.onStderr = (line) => {
      // File-only (stdout allowlist excludes it); keep a bounded prefix so a
      // chatty child cannot flood the log.
      log.info('agent', 'dsh-stderr', { backend: 'dsh-acp', line: line.slice(0, 300) });
    };
    this.client.onPermission = (request) => this.answerPermission(request);
  }

  runStreamed(input: AgentInput, turn?: TurnOptions): AgentRun {
    const turnId = `dsh-${++this.turnSeq}`;
    this.currentTurnId = turnId;

    if (this.dead || !this.client.isAlive()) {
      return this.failedRun(turnId, 'DSH ACP 会话进程已退出，请重新发送消息。');
    }
    if (this.active) {
      return this.failedRun(turnId, '上一轮还在运行，请稍后再发。');
    }

    const inbox = new Inbox<TurnItem>();
    const active: ActiveTurn = {
      turnId,
      sink: (item) => inbox.push(item),
      mapper: createUpdateMapper({ cwd: this.cwd }),
      cancelRequested: false,
      ended: false,
    };
    this.active = active;

    void this.sendTurn(active, input, turn);

    const self = this;
    async function* gen(): AsyncGenerator<AgentEvent> {
      yield { type: 'system', threadId: self.sessionId };
      yield { type: 'turn_started', turnId };
      while (true) {
        const item = await inbox.next();
        if (item === '__end__') return;
        yield item;
      }
    }

    return {
      events: gen(),
      turnId: () => turnId,
      lastActivity: () => self.lastActivity(),
    };
  }

  /**
   * ACP has no goal surface. The capability flag hides /goal; throwing here is
   * the hard guard for a direct call (never a silent half-implementation).
   */
  runGoal(_objective: string): AgentRun {
    throw new Error('当前 DSH 后端不支持 /goal（ACP 未暴露目标能力）。');
  }

  async clearGoal(): Promise<void> {
    // No persistent goal exists for this backend.
  }

  async steer(_input: AgentInput, _expectedTurnId: string): Promise<void> {
    throw new Error('当前 DSH 后端不支持运行中引导（steer），请等这一轮结束后再发。');
  }

  async abort(_turnId: string): Promise<void> {
    const active = this.active;
    if (!active || active.ended || active.cancelRequested) return;
    active.cancelRequested = true;
    this.client.notify('session/cancel', { sessionId: this.sessionId });
    log.info('agent', 'dsh-cancel', { backend: 'dsh-acp', turnId: active.turnId });
  }

  async compact(): Promise<CompactResult> {
    throw new Error('当前 DSH 后端不支持手动 /compact（ACP 未暴露压缩方法）。');
  }

  isAlive(): boolean {
    return !this.dead && this.client.isAlive();
  }

  async close(): Promise<void> {
    if (this.closing) {
      await this.client.close();
      return;
    }
    this.closing = true;
    this.dead = true;
    const active = this.active;
    if (active && !active.ended) {
      this.client.notify('session/cancel', { sessionId: this.sessionId });
    }
    try {
      await this.client.close();
    } finally {
      if (active && !active.ended) {
        this.finishTurn(active, { type: 'done', turnId: active.turnId });
      }
    }
  }

  private lastActivity(): number {
    return Math.max(this.lastActivityAt, this.client.lastActivity());
  }

  private handleUpdate(update: AcpUpdate): void {
    this.lastActivityAt = Date.now();
    const active = this.active;
    if (!active || active.ended) return;
    for (const event of active.mapper.map(update)) {
      // DSH's thoughts are raw chain-of-thought ("The user asks...", "Let me
      // search...") — useful for a terminal, noise in a Feishu card. Hide them
      // by default; the final answer and tool activity remain.
      if (!this.showThinking && (event.type === 'thinking_delta' || event.type === 'thinking')) {
        continue;
      }
      active.sink(event);
    }
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.dead = true;
    const active = this.active;
    if (!active || active.ended) return;
    if (this.closing) {
      this.finishTurn(active, { type: 'done', turnId: active.turnId });
      return;
    }
    log.info('agent', 'dsh-exit', { backend: 'dsh-acp', code, signal });
    this.finishTurn(active, {
      type: 'error',
      message: `DSH ACP 进程已退出（code=${code ?? 'null'}, signal=${signal ?? 'null'}）`,
      willRetry: false,
    });
  }

  /**
   * Sandbox escalation is a DSH permission request. The bridge's project tiers
   * are enforced by the OS sandbox; auto-approving an escalation would defeat
   * them (verified: read-only + allow-once could write outside the workspace).
   * Always reject; a future Feishu approval card can replace this handler.
   */
  private answerPermission(request: AcpPermissionRequest): AcpPermissionOutcome {
    const options = request.options ?? [];
    const reject =
      options.find((option) => option.kind === 'reject_once') ??
      options.find((option) => option.kind === 'reject_always') ??
      options.find((option) => /reject/i.test(option.optionId));
    log.info('agent', 'dsh-permission-rejected', {
      backend: 'dsh-acp',
      toolCallId: request.toolCall?.toolCallId ?? null,
      options: options.length,
    });
    return reject
      ? { outcome: 'selected', optionId: reject.optionId }
      : { outcome: 'cancelled' };
  }

  private async sendTurn(active: ActiveTurn, input: AgentInput, turn?: TurnOptions): Promise<void> {
    try {
      await this.applyTurnOptions(turn);
      if (active.ended || this.closing) return;

      const text = this.buildPrompt(input);
      this.lastActivityAt = Date.now();
      await this.client.request('session/prompt', {
        sessionId: this.sessionId,
        prompt: [{ type: 'text', text }],
      });

      if (active.ended) return;
      // end_turn / max_tokens / refusal all settle the turn; the bridge renders
      // whatever text arrived. A cancellation is also a clean stop (⏹).
      this.finishTurn(active, { type: 'done', turnId: active.turnId });
    } catch (err) {
      if (active.ended) return;
      if (this.closing || active.cancelRequested) {
        this.finishTurn(active, { type: 'done', turnId: active.turnId });
        return;
      }
      log.fail('agent', err, { backend: 'dsh-acp', phase: 'session.prompt' });
      this.finishTurn(active, {
        type: 'error',
        message: errorMessage(err),
        willRetry: false,
      });
    }
  }

  private finishTurn(active: ActiveTurn, event?: AgentEvent): void {
    if (active.ended) return;
    active.ended = true;
    if (event) active.sink(event);
    active.sink('__end__');
    if (this.active === active) this.active = undefined;
  }

  private async applyTurnOptions(turn?: TurnOptions): Promise<void> {
    if (turn?.model && turn.model !== this.model) {
      if (await this.setConfig('model', encodeModelValue(turn.model), turn.model)) {
        this.model = turn.model;
      }
    }
    if (turn?.effort && turn.effort !== this.effort) {
      if (await this.setConfig('reasoning_effort', toDshEffort(turn.effort), turn.effort)) {
        this.effort = turn.effort;
      }
    }
  }

  private async setConfig(configId: string, value: string | undefined, label: string): Promise<boolean> {
    if (!value) {
      log.info('agent', 'dsh-config-skipped', { backend: 'dsh-acp', configId, label });
      return false;
    }
    try {
      await this.client.request(
        'session/set_config_option',
        { sessionId: this.sessionId, configId, value },
        20_000,
      );
      return true;
    } catch (err) {
      // A stale persisted model/effort must not brick a session: keep the
      // restored route and surface the rejection in the log. A fresh pick from
      // /model normally succeeds; if it does not, the next /model list shows it.
      log.fail('agent', err, { backend: 'dsh-acp', phase: 'set_config_option', configId });
      return false;
    }
  }

  private buildPrompt(input: AgentInput): string {
    let text = input.text ?? '';
    if (input.images?.length) {
      // ACP currently advertises promptCapabilities.image=false for this DSH
      // profile. Degrade to a text pointer instead of dropping the message; the
      // agent can still read the downloaded files with its fs tools.
      const imageList = input.images.join('\n');
      text +=
        `\n\n[用户随消息发送了图片，本地路径：\n${imageList}\n` +
        '当前 DSH ACP 会话不支持图片输入，请按需用工具读取这些文件分析。]';
    }
    if (!text.trim()) text = '（无文本内容）';

    if (this.injectInstructions && !this.instructionsSent) {
      this.instructionsSent = true;
      text = `${BRIDGE_DEVELOPER_INSTRUCTIONS}\n\n---\n\n${text}`;
    }
    return text;
  }

  private failedRun(turnId: string, message: string): AgentRun {
    const self = this;
    async function* gen(): AsyncGenerator<AgentEvent> {
      yield { type: 'system', threadId: self.sessionId };
      yield { type: 'turn_started', turnId };
      yield { type: 'error', message, willRetry: false };
    }
    return {
      events: gen(),
      turnId: () => turnId,
      lastActivity: () => self.lastActivity(),
    };
  }
}

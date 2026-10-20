import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { AcpClient } from '../src/agent/dsh-acp/client';
import { DshAcpThread } from '../src/agent/dsh-acp/thread';
import type { AgentEvent, AgentRun } from '../src/agent/types';

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-dsh-acp.mjs', import.meta.url));
const tempDirs: string[] = [];

function tempCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-acp-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function connect(cwd: string): Promise<{ client: AcpClient; sessionId: string }> {
  const client = new AcpClient({ bin: process.execPath, args: [FIXTURE], cwd });
  await client.start();
  await client.request('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: 'dsh-acp-test', version: '0.0.0' },
  });
  const session = await client.request<{ sessionId: string }>('session/new', {
    cwd,
    mcpServers: [],
  });
  client.setSessionId(session.sessionId);
  return { client, sessionId: session.sessionId };
}

async function collect(run: AgentRun): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of run.events) out.push(event);
  return out;
}

describe('AcpClient + DshAcpThread over a fake ACP agent', () => {
  it('streams text, thought, tool and context events, then done', async () => {
    const cwd = tempCwd();
    const { client, sessionId } = await connect(cwd);
    const thread = new DshAcpThread({ sessionId, cwd, client });

    const events = await collect(thread.runStreamed({ text: 'hello' }));

    expect(events[0]).toEqual({ type: 'system', threadId: sessionId });
    expect(events[1]).toEqual({ type: 'turn_started', turnId: 'dsh-1' });
    expect(events).toContainEqual({ type: 'text_delta', itemId: 'msg-1', delta: 'hello ' });
    expect(events).toContainEqual({ type: 'text_delta', itemId: 'msg-1', delta: 'world' });
    expect(events).toContainEqual({
      type: 'thinking_delta',
      itemId: 'thought-1',
      delta: 'thinking',
    });
    expect(events).toContainEqual({
      type: 'tool_use',
      itemId: 'tool-1',
      title: 'echo hi',
      detail: 'say hi',
      kind: 'command',
    });
    expect(events).toContainEqual({
      type: 'tool_result',
      itemId: 'tool-1',
      output: 'hi\n',
      exitCode: 0,
    });
    expect(events).toContainEqual({ type: 'context_usage', usedTokens: 123, contextWindow: 1000 });
    expect(events.at(-1)).toEqual({ type: 'done', turnId: 'dsh-1' });

    await thread.close();
    expect(thread.isAlive()).toBe(false);
  });

  it('rejects sandbox escalation permission requests by default', async () => {
    const cwd = tempCwd();
    const { client, sessionId } = await connect(cwd);
    const thread = new DshAcpThread({ sessionId, cwd, client });

    const events = await collect(thread.runStreamed({ text: 'please permission' }));

    // The fake agent echoes the option the client selected. The adapter must
    // never auto-allow; reject-once is the expected default.
    expect(events).toContainEqual({
      type: 'text_delta',
      itemId: 'permission',
      delta: 'permission:reject-once',
    });
    expect(events.at(-1)).toEqual({ type: 'done', turnId: 'dsh-1' });

    await thread.close();
  });

  it('maps ⏹ to session/cancel and settles with done', async () => {
    const cwd = tempCwd();
    const { client, sessionId } = await connect(cwd);
    const thread = new DshAcpThread({ sessionId, cwd, client });

    const run = thread.runStreamed({ text: 'slow work' });
    const events: AgentEvent[] = [];
    const consumed = (async () => {
      for await (const event of run.events) events.push(event);
    })();

    await new Promise((resolve) => setTimeout(resolve, 100));
    await thread.abort('dsh-1');
    await consumed;

    expect(events).toContainEqual({ type: 'text_delta', itemId: 'slow', delta: 'working' });
    expect(events.at(-1)).toEqual({ type: 'done', turnId: 'dsh-1' });
    expect(thread.isAlive()).toBe(true);

    await thread.close();
  });

  it('hard-guards unsupported goal/steer/compact surfaces', async () => {
    const cwd = tempCwd();
    const { client, sessionId } = await connect(cwd);
    const thread = new DshAcpThread({ sessionId, cwd, client });

    expect(thread.supportsSteer).toBe(false);
    expect(() => thread.runGoal('x')).toThrow(/不支持/);
    await expect(thread.steer({ text: 'x' }, 'dsh-1')).rejects.toThrow(/不支持/);
    await expect(thread.compact()).rejects.toThrow(/不支持/);
    await thread.clearGoal(); // best-effort no-op

    await thread.close();
  });
});

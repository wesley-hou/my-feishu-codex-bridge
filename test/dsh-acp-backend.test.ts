import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { paths } from '../src/config/paths';

vi.mock('../src/agent/dsh-acp/locate', () => ({
  resolveDshBin: () => `${process.cwd()}/test/fixtures/fake-dsh-acp.mjs`,
  dshVersionAsync: async () => '0.2.1-rc.2',
}));

import { DshAcpBackend, dshPermissionMode } from '../src/agent/dsh-acp/backend';
import { AcpClient } from '../src/agent/dsh-acp/client';
import type { AgentEvent } from '../src/agent/types';

const FIXTURE = `${process.cwd()}/test/fixtures/fake-dsh-acp.mjs`;
const tempDirs: string[] = [];

function makeBackend(): DshAcpBackend {
  // The locate mock supplies doctor/version; the factory makes the spawn
  // cross-platform (`node fixture.mjs` instead of a shebang executable).
  return new DshAcpBackend((opts) =>
    new AcpClient({ ...opts, bin: process.execPath, args: [FIXTURE] }),
  );
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-acp-backend-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe('DshAcpBackend', () => {
  it('maps bridge permission tiers to DSH sandbox modes and rejects qa', () => {
    expect(dshPermissionMode('write')).toBe('workspace-write');
    expect(dshPermissionMode('full')).toBe('danger-full-access');
    expect(dshPermissionMode(undefined)).toBe('workspace-write');
    expect(() => dshPermissionMode('qa')).toThrow(/只读/);
  });

  it('reports the mocked dsh CLI as installed', async () => {
    const backend = makeBackend();
    expect(backend.id).toBe('dsh-acp');
    expect(backend.supportedModes).toEqual(['write', 'full']);
    expect(backend.capabilities).toEqual({
      goal: false,
      steer: false,
      compact: false,
      resume: false,
      approvals: false,
    });
    const probe = await backend.doctor();
    expect(probe.ok).toBe(true);
    expect(probe.version).toBe('0.2.1-rc.2');
    expect(probe.depState).toBe('installed');
  });

  it('discovers models through a probe session and marks the account route default', async () => {
    const originalAppDir = paths.appDir;
    paths.appDir = tempDir();
    try {
      const backend = makeBackend();
      const models = await backend.listModels();
      expect(models.map((model) => model.id)).toEqual([
        'deepseek-official/deepseek-v4-flash',
        'deepseek-account/deepseek-flash',
        'deepseek-account/deepseek-v4-pro',
      ]);
      expect(models.find((model) => model.isDefault)?.id).toBe(
        'deepseek-account/deepseek-flash',
      );
    } finally {
      paths.appDir = originalAppDir;
    }
  });

  it('starts a thread and streams a turn', async () => {
    const backend = makeBackend();
    const cwd = tempDir();
    const thread = await backend.startThread({
      cwd,
      mode: 'write',
      model: 'deepseek-account/deepseek-flash',
      effort: 'high',
    });
    try {
      const events = await collect(thread.runStreamed({ text: 'hello' }).events);
      expect(events).toContainEqual({ type: 'text_delta', itemId: 'msg-1', delta: 'hello ' });
      expect(events.at(-1)).toEqual({ type: 'done', turnId: 'dsh-1' });
      expect(thread.sessionId).toBe('sess-fake-1');
    } finally {
      await thread.close();
    }
  });

  it('resumes a persisted ACP session by id', async () => {
    const backend = makeBackend();
    const cwd = tempDir();
    const thread = await backend.resumeThread({
      cwd,
      sessionId: 'sess-fake-1',
      mode: 'write',
      model: 'deepseek-account/deepseek-flash',
    });
    try {
      expect(thread.sessionId).toBe('sess-fake-1');
      const events = await collect(thread.runStreamed({ text: 'hello' }).events);
      expect(events.some((event) => event.type === 'done')).toBe(true);
    } finally {
      await thread.close();
    }
  });

  it('fails closed for the unsupported qa tier before spawning', async () => {
    const backend = makeBackend();
    await expect(
      backend.startThread({ cwd: tempDir(), mode: 'qa' }),
    ).rejects.toThrow(/只读/);
  });
});

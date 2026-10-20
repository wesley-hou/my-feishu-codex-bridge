import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DshAcpBackend } from '../src/agent/dsh-acp/backend';
import { effectiveDefaultBackend } from '../src/agent/detect';
import { catalogById, projectCreatableBackends } from '../src/agent/catalog';
import { isBackendEntryInstalled } from '../src/agent/backend-loader';
import type { AgentEvent } from '../src/agent/types';

const LIVE = process.env.DSH_LIVE === '1';

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

/**
 * Real end-to-end smoke against the machine's DeepSeek Harness install. Skipped
 * by default (CI has no DSH login). Run with:
 *   DSH_LIVE=1 npx vitest run test/dsh-acp.live.test.ts
 */
describe.skipIf(!LIVE)('DSH ACP live smoke', () => {
  it(
    'streams a real turn through dsh --profile acp',
    async () => {
      const backend = new DshAcpBackend();
      const probe = await backend.doctor({ force: true });
      expect(probe.ok, probe.hint).toBe(true);

      // On a machine without codex (this test's precondition), the smart default
      // must pick DSH rather than the codex placeholder.
      expect(await effectiveDefaultBackend({ force: true })).toBe('dsh-acp');

      // Same predicate the project picker uses: DSH must be selectable in the
      // supported tiers (write/full), and not offered in qa.
      expect(isBackendEntryInstalled(catalogById('dsh-acp')!)).toBe(true);
      expect(projectCreatableBackends('write', isBackendEntryInstalled).map((e) => e.id)).toContain(
        'dsh-acp',
      );
      expect(projectCreatableBackends('qa', isBackendEntryInstalled).map((e) => e.id)).not.toContain(
        'dsh-acp',
      );

      const models = await backend.listModels();
      const model =
        models.find((entry) => entry.id.startsWith('deepseek-account/'))?.id ?? models[0]?.id;
      expect(model, 'no DSH model advertised').toBeTruthy();

      const cwd = mkdtempSync(join(tmpdir(), 'dsh-acp-live-'));
      const thread = await backend.startThread({
        cwd,
        mode: 'write',
        model,
        effort: 'high',
      });
      const sessionId = thread.sessionId;
      try {
        const events: AgentEvent[] = [];
        for await (const event of thread.runStreamed({ text: 'Reply exactly: DSH_LIVE_OK' }).events) {
          events.push(event);
        }
        const text = events
          .filter((event): event is Extract<AgentEvent, { type: 'text_delta' }> => event.type === 'text_delta')
          .map((event) => event.delta)
          .join('');
        expect(text).toContain('DSH_LIVE_OK');
        expect(events.at(-1)).toMatchObject({ type: 'done' });

        // A second turn on the same process proves the ACP session remains live.
        const second = await collect(thread.runStreamed({ text: 'Reply exactly: SECOND_OK' }).events);
        expect(
          second
            .filter((event): event is Extract<AgentEvent, { type: 'text_delta' }> => event.type === 'text_delta')
            .map((event) => event.delta)
            .join(''),
        ).toContain('SECOND_OK');
      } finally {
        await thread.close();
      }

      // Restart recovery: a brand-new dsh process resumes the persisted session
      // and keeps its conversation context.
      const resumed = await backend.resumeThread({
        cwd,
        sessionId,
        mode: 'write',
        model,
        effort: 'high',
      });
      try {
        const events = await collect(
          resumed.runStreamed({
            text: 'Remember: the secret number is 42. Reply exactly: STORED',
          }).events,
        );
        expect(events.at(-1)).toMatchObject({ type: 'done' });
      } finally {
        await resumed.close();
      }

      const verification = await backend.resumeThread({
        cwd,
        sessionId,
        mode: 'write',
        model,
        effort: 'high',
      });
      try {
        const events = await collect(
          verification.runStreamed({
            text: 'What secret number did I just ask you to remember? Reply with just the number.',
          }).events,
        );
        const text = events
          .filter((event): event is Extract<AgentEvent, { type: 'text_delta' }> => event.type === 'text_delta')
          .map((event) => event.delta)
          .join('');
        expect(text).toContain('42');
      } finally {
        await verification.close();
        rmSync(cwd, { recursive: true, force: true });
      }
    },
    180_000,
  );
});

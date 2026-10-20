import { describe, expect, it } from 'vitest';
import { acpContentText, createUpdateMapper } from '../src/agent/dsh-acp/event-map';
import type { AcpUpdate } from '../src/agent/dsh-acp/protocol';

describe('ACP → bridge event mapping', () => {
  it('maps message and thought chunks to delta events with stable item ids', () => {
    const mapper = createUpdateMapper();
    expect(
      mapper.map({
        sessionUpdate: 'agent_message_chunk',
        messageId: 'm1',
        content: { type: 'text', text: 'hello ' },
      }),
    ).toEqual([{ type: 'text_delta', itemId: 'm1', delta: 'hello ' }]);
    expect(
      mapper.map({
        sessionUpdate: 'agent_thought_chunk',
        messageId: 't1',
        content: { type: 'text', text: 'thinking' },
      }),
    ).toEqual([{ type: 'thinking_delta', itemId: 't1', delta: 'thinking' }]);
  });

  it('keeps a synthetic id when the server omits messageId', () => {
    const mapper = createUpdateMapper();
    const first = mapper.map({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'a' },
    });
    const second = mapper.map({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'b' },
    });
    expect(first[0]?.type).toBe('text_delta');
    expect(second[0]?.type).toBe('text_delta');
    if (first[0]?.type === 'text_delta' && second[0]?.type === 'text_delta') {
      expect(second[0].itemId).toBe(first[0].itemId);
    }
  });

  it('maps tool_call + tool_call_update into tool_use + tool_result', () => {
    const mapper = createUpdateMapper();
    const start = mapper.map({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc1',
      title: 'bash',
      kind: 'other',
      status: 'in_progress',
      rawInput: { command: 'echo hi', description: 'say hi' },
    });
    expect(start).toEqual([
      { type: 'tool_use', itemId: 'tc1', title: 'echo hi', detail: 'say hi', kind: 'command' },
    ]);

    const done = mapper.map({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'hi\n' } }],
    });
    expect(done).toEqual([
      { type: 'tool_result', itemId: 'tc1', output: 'hi\n', exitCode: 0 },
    ]);
  });

  it('marks failed tool updates as an error result', () => {
    const mapper = createUpdateMapper();
    mapper.map({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc2',
      title: 'write',
      rawInput: { file_path: '/tmp/a.txt' },
      status: 'in_progress',
    });
    const failed = mapper.map({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc2',
      status: 'failed',
      content: [{ type: 'text', text: 'denied' }],
    });
    expect(failed.at(-1)).toMatchObject({
      type: 'tool_result',
      itemId: 'tc2',
      output: 'denied',
      exitCode: 1,
    });
  });

  it('maps usage_update to the context gauge and ignores unknown updates', () => {
    const mapper = createUpdateMapper();
    expect(mapper.map({ sessionUpdate: 'usage_update', used: 123, size: 1000 })).toEqual([
      { type: 'context_usage', usedTokens: 123, contextWindow: 1000 },
    ]);
    expect(mapper.map({ sessionUpdate: 'usage_update', used: 5 })).toEqual([
      { type: 'context_usage', usedTokens: 5, contextWindow: null },
    ]);
    expect(mapper.map({ sessionUpdate: 'plan', entries: [] } satisfies AcpUpdate)).toEqual([]);
  });

  it('flattens nested ACP content and diff blocks', () => {
    expect(
      acpContentText([
        { type: 'content', content: { type: 'text', text: 'one' } },
        { type: 'text', text: 'two' },
      ]),
    ).toBe('one\ntwo');
    expect(
      acpContentText({ type: 'diff', path: '/a.ts', oldText: 'old', newText: 'new' }),
    ).toContain('+ new');
  });
});

#!/usr/bin/env node
// Minimal ACP v1 agent used by the DSH adapter tests. It implements just enough
// of `dsh --profile acp` to exercise the client/thread/backend without model
// credentials or a real DeepSeek Harness install.
//
// Behaviour is driven by the prompt text:
//   "slow"       → hold the prompt until a session/cancel notification
//   "permission" → send session/request_permission before completing
//   otherwise    → stream text/thought/tool/usage updates and end_turn

import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin });

let sessionId = 'sess-fake-1';
let serverRequestId = 1000;
let pendingPrompt;
const permissionWaiters = new Map();

let config = {
  model: '["deepseek-official","deepseek-v4-flash"]',
  effort: 'high',
};

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function respondError(id, message) {
  send({ jsonrpc: '2.0', id, error: { code: -32603, message } });
}

function update(fields) {
  send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId, update: { sessionId, ...fields } },
  });
}

function configOptions() {
  return [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: config.model,
      options: [
        {
          group: 'deepseek-official',
          name: 'DeepSeek',
          options: [
            {
              value: '["deepseek-official","deepseek-v4-flash"]',
              name: 'deepseek-v4-flash',
            },
          ],
        },
        {
          group: 'deepseek-account',
          name: 'DeepSeek Account',
          options: [
            {
              value: '["deepseek-account","deepseek-flash"]',
              name: 'DeepSeek-V4.1-Flash',
            },
            {
              value: '["deepseek-account","deepseek-v4-pro"]',
              name: 'DeepSeek-V4-Pro',
              description: 'Stronger agentic coding',
            },
          ],
        },
      ],
    },
    {
      id: 'reasoning_effort',
      name: 'Reasoning effort',
      category: 'thought_level',
      type: 'select',
      currentValue: config.effort,
      options: [
        { value: 'off', name: 'Off' },
        { value: 'low', name: 'Low' },
        { value: 'high', name: 'High' },
        { value: 'max', name: 'Max' },
      ],
    },
  ];
}

function handlePrompt(message) {
  const text = Array.isArray(message.params?.prompt)
    ? message.params.prompt.map((part) => part?.text ?? '').join('\n')
    : '';

  if (text.includes('slow')) {
    pendingPrompt = { id: message.id, sessionId };
    update({
      sessionUpdate: 'agent_message_chunk',
      messageId: 'slow',
      content: { type: 'text', text: 'working' },
    });
    return;
  }

  update({
    sessionUpdate: 'agent_message_chunk',
    messageId: 'msg-1',
    content: { type: 'text', text: 'hello ' },
  });
  update({
    sessionUpdate: 'agent_message_chunk',
    messageId: 'msg-1',
    content: { type: 'text', text: 'world' },
  });
  update({
    sessionUpdate: 'agent_thought_chunk',
    messageId: 'thought-1',
    content: { type: 'text', text: 'thinking' },
  });
  update({
    sessionUpdate: 'tool_call',
    toolCallId: 'tool-1',
    title: 'bash',
    kind: 'other',
    status: 'in_progress',
    rawInput: { command: 'echo hi', description: 'say hi' },
  });
  update({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'tool-1',
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: 'hi\n' } }],
  });
  update({ sessionUpdate: 'usage_update', used: 123, size: 1000 });

  if (text.includes('permission')) {
    const requestId = ++serverRequestId;
    send({
      jsonrpc: '2.0',
      id: requestId,
      method: 'session/request_permission',
      params: {
        sessionId,
        toolCall: { toolCallId: 'tool-2' },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
        ],
      },
    });
    permissionWaiters.set(requestId, (result) => {
      const optionId = result?.outcome?.optionId ?? result?.outcome?.outcome ?? 'none';
      update({
        sessionUpdate: 'agent_message_chunk',
        messageId: 'permission',
        content: { type: 'text', text: `permission:${optionId}` },
      });
      respond(message.id, { stopReason: 'end_turn' });
    });
    return;
  }

  respond(message.id, { stopReason: 'end_turn' });
}

function handleCancel() {
  if (!pendingPrompt) return;
  const { id } = pendingPrompt;
  pendingPrompt = undefined;
  update({
    sessionUpdate: 'agent_message_chunk',
    messageId: 'cancel',
    content: { type: 'text', text: 'cancelled' },
  });
  respond(id, { stopReason: 'cancelled' });
}

rl.on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  // Response from the client to a server→client request (permission).
  if (message.method === undefined && message.id !== undefined) {
    const waiter = permissionWaiters.get(message.id);
    if (waiter) {
      permissionWaiters.delete(message.id);
      waiter(message.result);
    }
    return;
  }

  switch (message.method) {
    case 'initialize':
      respond(message.id, {
        protocolVersion: 1,
        agentInfo: { name: 'fake-dsh-acp', version: '0.0.0-test' },
        agentCapabilities: {
          mcpCapabilities: { http: true },
          promptCapabilities: { image: false, audio: false, embeddedContext: false },
          sessionCapabilities: { close: {}, list: {}, resume: {} },
        },
        authMethods: [],
      });
      return;
    case 'session/new':
      respond(message.id, { sessionId, configOptions: configOptions() });
      return;
    case 'session/resume':
      sessionId = message.params?.sessionId ?? sessionId;
      respond(message.id, { configOptions: configOptions() });
      return;
    case 'session/set_config_option': {
      const configId = message.params?.configId;
      if (configId === 'model' && typeof message.params?.value === 'string') {
        config.model = message.params.value;
      }
      if (configId === 'reasoning_effort' && typeof message.params?.value === 'string') {
        config.effort = message.params.value;
      }
      respond(message.id, { configOptions: configOptions() });
      return;
    }
    case 'session/prompt':
      handlePrompt(message);
      return;
    case 'session/cancel':
      handleCancel();
      return;
    case 'session/close':
      respond(message.id, {});
      return;
    case 'session/list':
      respond(message.id, { sessions: [{ sessionId, cwd: process.cwd() }] });
      return;
    default:
      if (message.id !== undefined) respondError(message.id, `unknown method ${message.method}`);
  }
});

rl.on('close', () => process.exit(0));

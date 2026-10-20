import type { AgentEvent, ToolKind } from '../types';
import type { AcpUpdate } from './protocol';

/** Cap on an inline tool-input preview; the card layer truncates again. */
const DETAIL_MAX = 2_000;

export interface DshMapContext {
  /** thread cwd; reserved for path shortening (titles stay absolute for now). */
  cwd?: string;
}

export interface DshUpdateMapper {
  /** Map one ACP `session/update` to zero or more normalized events. */
  map(update: AcpUpdate): AgentEvent[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** Flatten ACP tool content (text / nested content / diff blocks) to text. */
export function acpContentText(content: unknown): string {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => acpContentText(item))
      .filter((text) => text.length > 0)
      .join('\n');
  }
  const rec = asRecord(content);
  if (!rec) return '';
  if (typeof rec.text === 'string') return rec.text;
  if (rec.type === 'content') return acpContentText(rec.content);
  if (rec.type === 'diff') {
    // ACP diff content: { type:'diff', path, oldText?, newText? }. Render a
    // compact unified-ish view so the card's tool panel is readable.
    const path = asString(rec.path) ?? '';
    const oldText = asString(rec.oldText);
    const newText = asString(rec.newText);
    if (oldText !== undefined || newText !== undefined) {
      return [
        path ? `--- ${path}` : '',
        oldText === undefined ? '' : `- ${oldText}`,
        newText === undefined ? '' : `+ ${newText}`,
      ]
        .filter(Boolean)
        .join('\n');
    }
  }
  return '';
}

interface ToolView {
  title: string;
  detail?: string;
  kind: ToolKind;
}

function mapToolView(update: AcpUpdate): ToolView {
  const raw = asRecord(update.rawInput);
  const command = asString(raw?.command);
  const filePath =
    asString(raw?.file_path) ??
    asString(raw?.filePath) ??
    asString(raw?.path) ??
    asString(raw?.target_file);
  const description = asString(raw?.description);
  const acpKind = asString(update.kind);

  let kind: ToolKind = 'tool';
  if (acpKind === 'execute' || command) kind = 'command';
  else if (
    acpKind === 'read' ||
    acpKind === 'edit' ||
    acpKind === 'delete' ||
    acpKind === 'move' ||
    filePath
  ) {
    kind = 'file';
  } else if (acpKind === 'search' || acpKind === 'fetch') {
    kind = 'search';
  }

  const title = command ?? filePath ?? asString(update.title) ?? '工具';
  let detail = description;
  if (detail === undefined && kind === 'tool' && raw) {
    detail = truncate(JSON.stringify(raw, null, 2), DETAIL_MAX);
  }
  return { title, detail, kind };
}

function mapToolResult(update: AcpUpdate, itemId: string): AgentEvent {
  const status = asString(update.status);
  const output = acpContentText(update.content);
  const failed = status === 'failed' || status === 'cancelled';
  return {
    type: 'tool_result',
    itemId,
    ...(output ? { output } : {}),
    exitCode: failed ? 1 : 0,
  };
}

/**
 * Per-turn ACP update mapper.
 *
 * ACP's `tool_call` / `tool_call_update` pair is stateful (the first carries the
 * raw input, later ones carry status/output), so a parser instance tracks which
 * tool ids the card has already seen. Text/thinking chunks carry an optional
 * `messageId`; when absent we keep one synthetic id per stream so chunks append
 * to the same card block instead of creating one block per delta.
 */
export function createUpdateMapper(ctx: DshMapContext = {}): DshUpdateMapper {
  void ctx; // paths are emitted absolute today; kept for a future shortening pass
  const seenTools = new Set<string>();
  let textItemId: string | undefined;
  let thinkingItemId: string | undefined;
  let seq = 0;

  function map(update: AcpUpdate): AgentEvent[] {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const text = acpContentText(update.content);
        if (!text) return [];
        const itemId = asString(update.messageId) ?? (textItemId ??= `dsh-text-${++seq}`);
        return [{ type: 'text_delta', itemId, delta: text }];
      }

      case 'agent_thought_chunk': {
        const text = acpContentText(update.content);
        if (!text) return [];
        const itemId =
          asString(update.messageId) ?? (thinkingItemId ??= `dsh-thought-${++seq}`);
        return [{ type: 'thinking_delta', itemId, delta: text }];
      }

      case 'tool_call': {
        const itemId = asString(update.toolCallId) ?? asString(update.id) ?? `dsh-tool-${++seq}`;
        const first = !seenTools.has(itemId);
        seenTools.add(itemId);
        const view = mapToolView(update);
        const out: AgentEvent[] = [];
        // A repeated tool_call is an update; emitting tool_use again upserts the
        // card entry by itemId, so it is safe and keeps the title current.
        out.push({
          type: 'tool_use',
          itemId,
          title: view.title,
          ...(view.detail !== undefined ? { detail: view.detail } : {}),
          kind: view.kind,
        });
        const status = asString(update.status);
        if (first && (status === 'completed' || status === 'failed' || status === 'cancelled')) {
          out.push(mapToolResult(update, itemId));
        }
        return out;
      }

      case 'tool_call_update': {
        const itemId = asString(update.toolCallId) ?? asString(update.id) ?? `dsh-tool-${++seq}`;
        const out: AgentEvent[] = [];
        if (!seenTools.has(itemId)) {
          seenTools.add(itemId);
          const view = mapToolView(update);
          out.push({
            type: 'tool_use',
            itemId,
            title: view.title,
            ...(view.detail !== undefined ? { detail: view.detail } : {}),
            kind: view.kind,
          });
        } else if (update.title !== undefined || update.rawInput !== undefined) {
          const view = mapToolView(update);
          out.push({
            type: 'tool_use',
            itemId,
            title: view.title,
            ...(view.detail !== undefined ? { detail: view.detail } : {}),
            kind: view.kind,
          });
        }
        const status = asString(update.status);
        if (status === 'completed' || status === 'failed' || status === 'cancelled') {
          out.push(mapToolResult(update, itemId));
        }
        return out;
      }

      case 'usage_update': {
        const used = asNumber(update.used);
        if (used === undefined) return [];
        return [
          {
            type: 'context_usage',
            usedTokens: used,
            contextWindow: asNumber(update.size) ?? null,
          },
        ];
      }

      // plan / available_commands_update / current_mode_update / config_option_update
      // / user_message_chunk etc. have no bridge representation today.
      default:
        return [];
    }
  }

  return { map };
}

/**
 * Minimal ACP (Agent Client Protocol) v1 wire shapes used by the DSH backend.
 *
 * We deliberately do NOT depend on `@agentclientprotocol/sdk` here: the bridge
 * only needs a tiny slice of the protocol (initialize / session new|resume|
 * prompt|cancel|close / session/update / request_permission), and keeping the
 * shape local avoids pulling zod into the bridge's dependency tree.
 */

/** One selectable value in a session config option (e.g. a model). */
export interface AcpConfigChoice {
  value: string;
  name?: string;
  description?: string;
}

/** A provider/model group inside a select config option. */
export interface AcpConfigGroup {
  group: string;
  name?: string;
  options?: AcpConfigChoice[];
}

/** A `session/new` / `session/resume` configuration option. */
export interface AcpConfigOption {
  id: string;
  name?: string;
  category?: string;
  type?: string;
  currentValue?: string;
  options?: Array<AcpConfigChoice | AcpConfigGroup>;
}

export interface AcpInitializeResult {
  protocolVersion?: number;
  agentInfo?: { name?: string; version?: string };
  agentCapabilities?: {
    promptCapabilities?: { image?: boolean };
    sessionCapabilities?: { close?: unknown; list?: unknown; resume?: unknown };
  };
}

export interface AcpNewSessionResult {
  sessionId: string;
  configOptions?: AcpConfigOption[];
}

export interface AcpResumeSessionResult {
  configOptions?: AcpConfigOption[];
}

/**
 * One `session/update` payload. ACP's shape is a discriminated union; we keep
 * the fields we consume as optional so a protocol addition cannot crash the
 * notification pump.
 */
export interface AcpUpdate {
  sessionUpdate: string;
  messageId?: string;
  content?: unknown;
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
  rawInput?: unknown;
  /** usage_update */
  used?: number;
  size?: number;
  [key: string]: unknown;
}

export interface AcpPermissionOption {
  optionId: string;
  name?: string;
  kind?: string;
}

export interface AcpPermissionRequest {
  sessionId?: string;
  toolCall?: { toolCallId?: string; title?: string; kind?: string; rawInput?: unknown };
  options?: AcpPermissionOption[];
}

export type AcpPermissionOutcome =
  | { outcome: 'selected'; optionId: string }
  | { outcome: 'cancelled' };

export interface AcpClientOptions {
  /** dsh executable (app bundle CLI, PATH, or npm-installed shim). */
  bin: string;
  /** Session workspace. ACP requires an absolute path. */
  cwd: string;
  /** Full child environment (callers merge DSH_PERMISSION_MODE etc.). */
  env?: NodeJS.ProcessEnv;
  /**
   * Override the CLI arguments (default `['--profile','acp']`). The test fake
   * uses it to run `node fake-acp.mjs` on every platform, including Windows
   * where a shebang `.mjs` is not directly executable.
   */
  args?: readonly string[];
}

/** JSON-RPC request/response/notification envelopes (loose by design). */
export interface AcpMessage {
  jsonrpc?: '2.0';
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

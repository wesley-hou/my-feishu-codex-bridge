import type { ModelInfo, ReasoningEffort } from '../types';
import type { AcpConfigChoice, AcpConfigGroup, AcpConfigOption } from './protocol';

/**
 * DSH exposes `reasoning_effort` values off/low/high/max. The bridge's
 * ReasoningEffort vocabulary is larger; map at the boundary and advertise only
 * values DSH actually accepts, so `pickDefault` never chooses an unsupported
 * effort.
 */
const DSH_EFFORT_TO_BRIDGE: Record<string, ReasoningEffort> = {
  off: 'none',
  low: 'low',
  high: 'high',
  max: 'max',
};

const BRIDGE_EFFORT_TO_DSH: Record<ReasoningEffort, string> = {
  none: 'off',
  minimal: 'low',
  low: 'low',
  medium: 'high',
  high: 'high',
  xhigh: 'max',
  max: 'max',
  ultra: 'max',
};

const FALLBACK_EFFORTS: ReasoningEffort[] = ['none', 'low', 'high', 'max'];

export function toDshEffort(effort: ReasoningEffort | undefined): string | undefined {
  return effort ? BRIDGE_EFFORT_TO_DSH[effort] : undefined;
}

export function fromDshEffort(value: string | undefined): ReasoningEffort | undefined {
  return value ? DSH_EFFORT_TO_BRIDGE[value] : undefined;
}

/**
 * Encode a bridge model id (provider/model) as the ACP config value
 * (`["provider","model"]` JSON string). A value already in ACP's JSON form is
 * accepted for records written by an earlier adapter version.
 */
export function encodeModelValue(modelId: string | undefined): string | undefined {
  if (!modelId) return undefined;
  const trimmed = modelId.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (
        Array.isArray(parsed) &&
        parsed.length === 2 &&
        parsed.every((part) => typeof part === 'string' && part.length > 0)
      ) {
        return JSON.stringify(parsed);
      }
    } catch {
      /* fall through */
    }
    return undefined;
  }
  const slash = trimmed.indexOf('/');
  if (slash <= 0 || slash === trimmed.length - 1) return undefined;
  return JSON.stringify([trimmed.slice(0, slash), trimmed.slice(slash + 1)]);
}

/** Decode an ACP model config value into the bridge's stable `provider/model` id. */
export function modelIdFromValue(value: string): string | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === 'string' &&
      typeof parsed[1] === 'string'
    ) {
      return `${parsed[0]}/${parsed[1]}`;
    }
  } catch {
    /* a plain string is a valid opaque value */
  }
  return value.trim() || undefined;
}

function isGroup(item: AcpConfigChoice | AcpConfigGroup): item is AcpConfigGroup {
  return typeof (item as AcpConfigGroup).group === 'string' && Array.isArray((item as AcpConfigGroup).options);
}

function choicesOf(option: AcpConfigOption | undefined): AcpConfigChoice[] {
  if (!option?.options) return [];
  const out: AcpConfigChoice[] = [];
  for (const item of option.options) {
    if (isGroup(item)) {
      for (const choice of item.options ?? []) out.push(choice);
    } else {
      out.push(item);
    }
  }
  return out;
}

/** Find the first model select option (DSH advertises it as id "model"). */
function modelOptionOf(options: readonly AcpConfigOption[]): AcpConfigOption | undefined {
  return options.find((option) => option.id === 'model') ?? options.find((option) => option.category === 'model');
}

function effortOptionOf(options: readonly AcpConfigOption[]): AcpConfigOption | undefined {
  return (
    options.find((option) => option.id === 'reasoning_effort') ??
    options.find((option) => option.category === 'thought_level')
  );
}

/**
 * Pick the model the bridge should use when the caller did not specify one.
 * The desktop login route (deepseek-account) is the one that works without an
 * API key; the ACP profile's shipped default (deepseek-official) needs
 * DEEPSEEK_API_KEY. Prefer what will actually run, then fall back to the
 * profile's current selection.
 */
export function pickDefaultModel(models: readonly ModelInfo[]): string | undefined {
  return (
    models.find((model) => model.id.startsWith('deepseek-account/'))?.id ??
    (process.env.DEEPSEEK_API_KEY
      ? models.find((model) => model.id.startsWith('deepseek-official/'))?.id
      : undefined) ??
    models.find((model) => model.isDefault)?.id ??
    models[0]?.id
  );
}

/**
 * Map DSH's `session/new` configOptions to bridge ModelInfo entries.
 * Returns [] when the server advertises no model choices; callers then use
 * {@link STATIC_MODELS}.
 */
export function modelsFromConfigOptions(options: readonly AcpConfigOption[]): ModelInfo[] {
  const modelOption = modelOptionOf(options);
  const choices = choicesOf(modelOption);
  if (choices.length === 0) return [];

  const effortOption = effortOptionOf(options);
  const effortChoices = choicesOf(effortOption);
  const supportedEfforts = [
    ...new Set(
      effortChoices
        .map((choice) => fromDshEffort(choice.value))
        .filter((effort): effort is ReasoningEffort => effort !== undefined),
    ),
  ];
  const efforts = supportedEfforts.length > 0 ? supportedEfforts : FALLBACK_EFFORTS;
  const defaultEffort = fromDshEffort(effortOption?.currentValue) ?? 'high';

  // Group names are part of the human-readable description; choices themselves
  // are flattened (the bridge's model picker is a flat list).
  const groupByValue = new Map<string, string>();
  for (const item of modelOption?.options ?? []) {
    if (!isGroup(item)) continue;
    for (const choice of item.options ?? []) {
      groupByValue.set(choice.value, item.name ?? item.group);
    }
  }

  const seen = new Set<string>();
  const models: ModelInfo[] = [];
  for (const choice of choices) {
    const id = modelIdFromValue(choice.value);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const group = groupByValue.get(choice.value);
    const description = [group, choice.description].filter(Boolean).join(' · ');
    models.push({
      id,
      displayName: choice.name ?? id,
      description,
      supportedEfforts: efforts,
      defaultEffort,
      isDefault: false,
      hidden: false,
    });
  }

  const preferred = pickDefaultModel(models);
  return models.map((model) => ({ ...model, isDefault: model.id === preferred }));
}

/**
 * Failure-only fallback when discovery cannot spawn/initialize. Mirrors the
 * current DSH desktop routes so the model picker still has sensible choices.
 */
export const STATIC_MODELS: readonly ModelInfo[] = [
  {
    id: 'deepseek-account/deepseek-flash',
    displayName: 'DeepSeek-V4.1-Flash',
    description: 'DeepSeek Account · 桌面登录，日常编码',
    supportedEfforts: FALLBACK_EFFORTS,
    defaultEffort: 'high',
    isDefault: true,
    hidden: false,
  },
  {
    id: 'deepseek-account/deepseek-v4-pro',
    displayName: 'DeepSeek-V4-Pro',
    description: 'DeepSeek Account · 复杂推理 / 高质量任务',
    supportedEfforts: FALLBACK_EFFORTS,
    defaultEffort: 'high',
    isDefault: false,
    hidden: false,
  },
  {
    id: 'deepseek-official/deepseek-v4-flash',
    displayName: 'deepseek-v4-flash',
    description: 'DeepSeek Official · 需要 DEEPSEEK_API_KEY',
    supportedEfforts: FALLBACK_EFFORTS,
    defaultEffort: 'high',
    isDefault: false,
    hidden: false,
  },
];

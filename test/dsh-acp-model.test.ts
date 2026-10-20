import { describe, expect, it } from 'vitest';
import {
  STATIC_MODELS,
  encodeModelValue,
  fromDshEffort,
  modelIdFromValue,
  modelsFromConfigOptions,
  pickDefaultModel,
  toDshEffort,
} from '../src/agent/dsh-acp/model';
import type { AcpConfigOption } from '../src/agent/dsh-acp/protocol';

const CONFIG: AcpConfigOption[] = [
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: '["deepseek-official","deepseek-v4-flash"]',
    options: [
      {
        group: 'deepseek-official',
        name: 'DeepSeek',
        options: [{ value: '["deepseek-official","deepseek-v4-flash"]', name: 'deepseek-v4-flash' }],
      },
      {
        group: 'deepseek-account',
        name: 'DeepSeek Account',
        options: [
          { value: '["deepseek-account","deepseek-flash"]', name: 'DeepSeek-V4.1-Flash' },
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
    currentValue: 'high',
    options: [
      { value: 'off', name: 'Off' },
      { value: 'low', name: 'Low' },
      { value: 'high', name: 'High' },
      { value: 'max', name: 'Max' },
    ],
  },
];

describe('DSH model config mapping', () => {
  it('encodes provider/model ids as the ACP ["provider","model"] JSON value', () => {
    expect(encodeModelValue('deepseek-account/deepseek-flash')).toBe(
      '["deepseek-account","deepseek-flash"]',
    );
    // Already-encoded values are accepted for forward/backward compatibility.
    expect(encodeModelValue('["a","b"]')).toBe('["a","b"]');
    expect(encodeModelValue('no-slash')).toBeUndefined();
    expect(encodeModelValue('')).toBeUndefined();
    expect(encodeModelValue(undefined)).toBeUndefined();
  });

  it('decodes ACP model values, including opaque plain strings', () => {
    expect(modelIdFromValue('["deepseek-account","deepseek-v4-pro"]')).toBe(
      'deepseek-account/deepseek-v4-pro',
    );
    expect(modelIdFromValue('custom-model')).toBe('custom-model');
  });

  it('maps the DSH effort subset to the bridge vocabulary and back', () => {
    expect(toDshEffort('none')).toBe('off');
    expect(toDshEffort('medium')).toBe('high');
    expect(toDshEffort('xhigh')).toBe('max');
    expect(toDshEffort('ultra')).toBe('max');
    expect(fromDshEffort('off')).toBe('none');
    expect(fromDshEffort('max')).toBe('max');
    expect(fromDshEffort('unknown')).toBeUndefined();
  });

  it('flattens model groups and marks the working DeepSeek Account default', () => {
    const models = modelsFromConfigOptions(CONFIG);
    expect(models.map((model) => model.id)).toEqual([
      'deepseek-official/deepseek-v4-flash',
      'deepseek-account/deepseek-flash',
      'deepseek-account/deepseek-v4-pro',
    ]);
    expect(models.find((model) => model.isDefault)?.id).toBe(
      'deepseek-account/deepseek-flash',
    );
    // DSH only accepts off/low/high/max, so the advertised bridge efforts are
    // restricted to the mapped values (no medium/xhigh/ultra).
    for (const model of models) {
      expect(model.supportedEfforts).toEqual(['none', 'low', 'high', 'max']);
      expect(model.defaultEffort).toBe('high');
    }
    expect(models[2]?.description).toContain('DeepSeek Account');
  });

  it('falls back to static models when the server advertises no model choices', () => {
    expect(modelsFromConfigOptions([])).toEqual([]);
    expect(STATIC_MODELS.map((model) => model.id)).toContain(
      'deepseek-account/deepseek-flash',
    );
    expect(pickDefaultModel(STATIC_MODELS)).toBe('deepseek-account/deepseek-flash');
  });

  it('prefers account models over the API-key-only official route', () => {
    const models = modelsFromConfigOptions(CONFIG);
    expect(pickDefaultModel(models)).toBe('deepseek-account/deepseek-flash');
  });
});

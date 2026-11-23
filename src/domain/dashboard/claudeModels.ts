import type { DashboardCliModelOption } from './types';

export const CLAUDE_MODEL_PREFIX = 'claude-code/';
export function isClaudeModel(id: string | undefined): boolean { return !!id?.startsWith(CLAUDE_MODEL_PREFIX); }
export function nativeClaudeModel(id: string): string {
  if (!isClaudeModel(id) || !/^[a-z0-9][a-z0-9._:/-]{0,127}$/i.test(id.slice(CLAUDE_MODEL_PREFIX.length))) throw new Error('Choose a discovered Claude model.');
  return id.slice(CLAUDE_MODEL_PREFIX.length);
}

/** Keep native gateway labels and exact effort capabilities. */
export function createClaudeModelOptions(models: Array<{ value: string; displayName: string; description?: string; supportsEffort?: boolean; supportedEffortLevels?: string[] }>): DashboardCliModelOption[] {
  const seen = new Set<string>();
  return models.flatMap(model => {
    if (!/^[a-z0-9][a-z0-9._:/-]{0,127}$/i.test(model.value) || seen.has(model.value)) return [];
    seen.add(model.value);
    const reasoningEfforts = model.supportsEffort === false ? [] : [...new Set(model.supportedEffortLevels ?? [])].filter(level => ['low','medium','high','xhigh','max'].includes(level));
    return [{ id: CLAUDE_MODEL_PREFIX + model.value, label: model.displayName, description: model.description, provider: 'claude' as const,
      reasoningEfforts, defaultReasoningEffort: reasoningEfforts.includes('high') ? 'high' : reasoningEfforts[0] }];
  });
}

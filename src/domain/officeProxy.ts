import type { OfficeProfile } from './officeModels';

export const OFFICE_PROXY_DEFAULTS = {
  regular: 'regular', professional: 'professional', expert: 'expert',
  'claude-opus': 'expert', 'claude-sonnet': 'professional', 'claude-haiku': 'regular', 'claude-fable': 'expert'
} as const satisfies Record<string, OfficeProfile>;
export type OfficeProxyAlias = keyof typeof OFFICE_PROXY_DEFAULTS;
export type OfficeProxySettings = { revision: string; mappings: Partial<Record<OfficeProxyAlias, OfficeProfile>> };
export type OfficeProxyKey = { id: string; name: string; createdAt: number };
export type OfficeProxySnapshot = {
  enabled: boolean; keys: OfficeProxyKey[]; settings: OfficeProxySettings;
  profiles: Array<{ profile: OfficeProfile }>;
};

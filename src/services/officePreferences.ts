import { getSqliteStateStore } from '../storage/sqliteState';

export function readOfficeInstructions(owner: string): string {
  return getSqliteStateStore()?.get<string>(`office-preferences:${owner}`, 'instructions') ?? '';
}

export function saveOfficeInstructions(owner: string, instructions: unknown, expected: unknown): string {
  if (typeof instructions !== 'string' || instructions.length > 8000 || typeof expected !== 'string') throw new Error('Use up to 8,000 characters for workspace instructions.');
  const store = getSqliteStateStore();
  if (!store) throw new Error('Settings are unavailable. Please try again.');
  store.transaction(() => {
    if (readOfficeInstructions(owner) !== expected) throw new Error('Instructions changed in another window. Reload settings and review before saving.');
    store.set(`office-preferences:${owner}`, 'instructions', instructions);
  });
  return instructions;
}

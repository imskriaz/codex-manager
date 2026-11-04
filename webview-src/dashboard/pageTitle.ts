export function dashboardPageTitle(system: string | undefined, screen: string, item?: string, privacyMode = false): string {
  const clean = (value: string | undefined) => value?.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return [privacyMode ? 'Codex Manager' : clean(system) || 'Codex Manager', clean(screen) || 'Dashboard', privacyMode ? undefined : clean(item)].filter(Boolean).join(' - ');
}

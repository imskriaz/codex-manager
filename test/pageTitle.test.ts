import { describe, expect, it } from 'vitest';
import { dashboardPageTitle } from '../webview-src/dashboard/pageTitle';

describe('dashboard page titles', () => {
  it('identifies the selected system, screen and item', () => {
    expect(dashboardPageTitle('Office PC', 'Workspace', 'Fix uploads')).toBe('Office PC - Workspace - Fix uploads');
    expect(dashboardPageTitle('Other PC', 'Tasks', 'Release 1.6.6')).toBe('Other PC - Tasks - Release 1.6.6');
  });
  it('keeps loading and missing-item titles readable', () => {
    expect(dashboardPageTitle(undefined, 'Accounts')).toBe('Codex Manager - Accounts');
    expect(dashboardPageTitle('Office PC', 'Workspace', '   ')).toBe('Office PC - Workspace');
  });
  it('normalizes multiline item titles and hides private identities', () => {
    expect(dashboardPageTitle(' PC\t', 'Tasks', 'Fix\n  uploads\u0000')).toBe('PC - Tasks - Fix uploads');
    expect(dashboardPageTitle('Private system', 'Workspace', 'Private session', true)).toBe('Codex Manager - Workspace');
  });
});

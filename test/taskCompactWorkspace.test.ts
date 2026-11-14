import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { projectTaskActivity } from '../src/domain/projectTaskActivity';

it('shows newest activity without mutating conversation order, including undated events', () => {
  const messages = [{id:'one',text:'First'}, {id:'two',text:'Second'}];
  expect(projectTaskActivity(messages, []).reverse().map(item => item.id)).toEqual(['message:two','message:one']);
  expect(messages.map(item => item.id)).toEqual(['one','two']);
});
it('hides inactive task panes and keeps project totals separate from task edits', () => {
  const css = readFileSync('media/webview/quotaSummary.css', 'utf8');
  const source = readFileSync('webview-src/dashboard/taskBoard.tsx', 'utf8');
  expect(css).toContain('.task-detail-panel .task-detail-scroll[hidden] { display: none !important; }');
  expect(source).toContain('<TaskRecordedChanges');
  expect(source).toContain('<summary>Project changes</summary>');
  expect(source).toContain('details.environment ?');
  expect(source.indexOf('Older history</button>')).toBeGreaterThan(source.indexOf('<TaskActivityTimeline'));
});
it('keeps optional restore behind user interaction and scopes private agent preferences', () => {
  const position = readFileSync('webview-src/dashboard/taskViewPosition.ts', 'utf8');
  expect(position).toContain('!disposed && !touched');
  expect(position).toContain('Number.isFinite(value)');
  const source = readFileSync('webview-src/dashboard/taskBoard.tsx', 'utf8');
  expect(source).toContain('persistenceKey={!shared && mainKey');
});

it('keeps offline navigation available while server actions stay guarded', () => {
  const main = readFileSync('webview-src/dashboard/main.tsx', 'utf8');
  const workspace = readFileSync('webview-src/dashboard/cliSessionsModal.tsx', 'utf8');
  const actions = readFileSync('webview-src/dashboard/actionHooks.ts', 'utf8');
  expect(main).not.toContain('class="dashboard-offline-overlay"');
  expect(main).not.toContain('disabled={dashboardUnavailable}');
  expect(workspace).not.toContain('inert={props.connected === false');
  expect(actions).toContain("routedPayload.targetDeviceId !== 'local' && !peer");
  expect(actions).toContain('This operation was not sent or queued.');
});

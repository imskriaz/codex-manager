import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { VNode } from 'preact';
import type { DashboardCliSessionSummary } from '../src/domain/dashboard/types';
const fixture = vi.hoisted(() => ({ slots: [] as any[], cursor: 0, effects: [] as Array<() => void> }));
vi.mock('preact/hooks', async importOriginal => ({
  ...await importOriginal<typeof import('preact/hooks')>(),
  useContext: () => undefined,
  useState(initial: unknown) { const index = fixture.cursor++; fixture.slots[index] ??= { value: typeof initial === 'function' ? initial() : initial }; return [fixture.slots[index].value, (next: unknown) => { fixture.slots[index].value = typeof next === 'function' ? next(fixture.slots[index].value) : next; }]; },
  useEffect(setup: () => void | (() => void), deps: unknown[]) { const index = fixture.cursor++, previous = fixture.slots[index]; if (previous && deps.every((value, i) => Object.is(value, previous.deps[i]))) return; fixture.slots[index] = { deps }; fixture.effects.push(() => { previous?.cleanup?.(); fixture.slots[index].cleanup = setup(); }); }
}));
import { AgentWorkspace, SessionTranscript } from '../webview-src/dashboard/cliSessionsModal';
import { cliSessionTargetKey } from '../webview-src/dashboard/cliSessionRoute';
const alpha = { id: 'alpha', agentName: 'Alpha', title: 'Alpha work', status: 'running', subAgent: true } as DashboardCliSessionSummary;
const beta = { id: 'beta', agentName: 'Beta', title: 'Beta work', status: 'idle', subAgent: true } as DashboardCliSessionSummary;
let props: Parameters<typeof AgentWorkspace>[0];
function render(patch: Partial<typeof props> = {}) { props = { ...props, ...patch }; fixture.cursor = 0; const node = AgentWorkspace(props); fixture.effects.splice(0).forEach(effect => effect()); return node; }
function nodes(node: unknown): VNode<any>[] { if (Array.isArray(node)) return node.flatMap(nodes); if (!node || typeof node !== 'object' || !('props' in node)) return []; const value = node as VNode<any>; return [value, ...nodes(value.props.children)]; }
function text(node: unknown): string { if (Array.isArray(node)) return node.map(text).join(''); if (typeof node === 'string' || typeof node === 'number') return String(node); return node && typeof node === 'object' && 'props' in node ? text((node as VNode<any>).props.children) : ''; }
const button = (label: string) => nodes(render()).find(node => node.type === 'button' && (node.props['aria-label'] === label || node.props.title === label || text(node.props.children) === label))!;
const tabs = () => nodes(render()).filter(node => node.props.role === 'tab');
const transcript = () => nodes(render()).find(node => node.type === SessionTranscript)!;
beforeEach(() => { fixture.slots = []; fixture.cursor = 0; fixture.effects = []; vi.stubGlobal('navigator', { onLine: true }); vi.stubGlobal('document', { visibilityState: 'visible' }); props = { sessions: [alpha, beta], data: {}, onRefresh: vi.fn(), onFeedback: vi.fn() }; render(); });
afterEach(() => vi.unstubAllGlobals());
it('retains every opened agent tab until its close button is used', () => {
  button('Alpha work').props.onClick(); button('All agents 2').props.onClick(); button('Beta work').props.onClick();
  expect(tabs().map(node => text(node.props.children))).toEqual(['All agents 2', 'Alpha', 'Beta']);
  button('Alpha').props.onClick(); expect(tabs().find(node => text(node.props.children) === 'Alpha')?.props['aria-selected']).toBe(true);
  button('Close agent Beta').props.onClick(); expect(tabs().map(node => text(node.props.children))).toEqual(['All agents 2', 'Alpha']);
  button('Close agent Alpha').props.onClick(); expect(tabs().map(node => text(node.props.children))).toEqual(['All agents 2']);
});
it('preserves opened tabs and saved messages across roster and message refresh', () => {
  const saved = [{ id: 'saved', role: 'assistant', text: 'Existing answer' }] as any;
  button('Alpha work').props.onClick();
  render({ data: { [cliSessionTargetKey(alpha)]: { messages: saved, loading: true } } });
  expect(transcript().props.messages).toBe(saved);
  expect(text(render())).not.toContain('Refreshing agent messages');
  render({ sessions: [beta] }); expect(tabs().map(node => text(node.props.children))).toContain('Alpha');
  expect(transcript().props.messages).toBe(saved);
  render({ sessions: [{ ...alpha, agentName: 'Alpha renamed' }, beta], data: { [cliSessionTargetKey(alpha)]: { messages: [...saved, { id: 'incoming', role: 'assistant', text: 'Incoming answer' }] as any } } });
  expect(transcript().props.messages).toHaveLength(2); expect(tabs().map(node => text(node.props.children))).toContain('Alpha renamed');
});
it('does not automatically refresh or mount a conversation while its tool is hidden', () => {
  button('Alpha work').props.onClick(); render(); vi.mocked(props.onRefresh!).mockClear();
  const conversation = vi.fn(() => null);
  render({ active: false, renderConversation: conversation, sessions: [{ ...alpha, updatedAt: 'later' }, beta] });
  expect(props.onRefresh).not.toHaveBeenCalled(); expect(conversation).not.toHaveBeenCalled();
  render({ active: true }); expect(props.onRefresh).toHaveBeenCalledWith(expect.objectContaining({ id: 'alpha' }), true); expect(conversation).toHaveBeenCalled();
});
it('keeps saved messages when refresh fails and still reports the failure', () => {
  const saved = [{ id: 'saved', role: 'assistant', text: 'Existing answer' }] as any;
  button('Alpha work').props.onClick(); render({ data: { [cliSessionTargetKey(alpha)]: { messages: saved, error: 'Connection lost', loading: false } } });
  expect(transcript().props.messages).toBe(saved);
  expect(nodes(render()).find(node => node.props.role === 'alert')?.props.children).toBe('Connection lost');
});

it('keeps earlier tabs when conversation links select another agent', () => {
  render({ activeId: 'alpha' }); render({ activeId: 'beta' });
  expect(tabs().map(node => text(node.props.children))).toEqual(['All agents 2', 'Alpha', 'Beta']);
  expect(tabs().find(node => text(node.props.children) === 'Beta')?.props['aria-selected']).toBe(true);
});

it('shows model and effort in the tab without a separate refresh or model row', () => {
  render({ sessions: [{ ...alpha, model: 'gpt-6.1-Sol', reasoningEffort: 'high' }, beta] });
  button('Alpha work').props.onClick();
  expect(tabs().find(node => node.props['aria-selected'])?.props.children).toBe('Alpha (6.1-Sol · high)');
  expect(nodes(render()).some(node => node.type === 'header')).toBe(false);
  expect(nodes(render()).some(node => node.props['aria-label'] === 'Refresh')).toBe(false);
});

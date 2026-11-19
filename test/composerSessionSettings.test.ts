import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { ComposerSessionSettings } from '../webview-src/dashboard/cliSessionsModal';

const session = { id: 'session', title: 'Task', status: 'idle' as const, projectPath: 'D:/demo' };
function controls(patch: Partial<Parameters<typeof ComposerSessionSettings>[0]> = {}) {
  const props = { session, autoResume: true, disabled: false, running: false, onAutoResume: vi.fn(), onQueue: vi.fn(), ...patch };
  const [resume, queue, error] = ComposerSessionSettings(props).props.children;
  return { props, resume: resume.props.children[1].props.children[0].props, queue: queue.props.children[1].props, error };
}

describe('composer session settings', () => {
  it('uses the existing session actions and preserves custom queue priorities', () => {
    const { props, resume, queue } = controls({ session: { ...session, queueEnabled: true, queuePriority: 17 } });
    expect(resume.checked).toBe(false);
    expect(queue.value).toBe('17');
    expect(queue.children[1].map((option: { props: { value: string } }) => option.props.value)).toContain('17');
    resume.onChange({ currentTarget: { checked: true } });
    expect(props.onAutoResume).toHaveBeenCalledWith(props.session, true);
    queue.onChange({ currentTarget: { value: '2' } });
    expect(props.onQueue).toHaveBeenCalledWith(props.session, true, 2);
    queue.onChange({ currentTarget: { value: 'off' } });
    expect(props.onQueue).toHaveBeenLastCalledWith(props.session, false, undefined);
  });

  it('blocks unavailable actions and keeps queue failures visible', () => {
    expect(controls({ running: true }).queue.disabled).toBe(true);
    for (const patch of [{ disabled: true }, { session: { ...session, archived: true } }, { session: { ...session, subAgent: true } }, { session: { ...session, parentSessionId: 'parent' } }]) {
      const { resume, queue } = controls(patch);
      expect(resume.disabled).toBe(true);
      expect(queue.disabled).toBe(true);
    }
    const failed = controls({ autoResume: false, session: { ...session, queueError: 'Queue storage unavailable' } });
    expect(failed.resume.disabled).toBe(true);
    expect(failed.error.props.children).toBe('Queue storage unavailable');
  });

  it('removes the exhausted-usage banner from the shared dashboard', () => {
    const source = readFileSync('webview-src/dashboard/cliSessionsModal.tsx', 'utf8');
    expect(source).not.toContain('UsageBanner');
    expect(source).not.toContain('You’re out of Codex and Work usage');
  });
});

import { useEffect, useId, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import type { DashboardHostMessage } from '../../src/domain/dashboard/types';
import { createActionRequestId, postMessageToHost } from './host';

export type ComposerSkill = { name: string; description: string };
export function commandChoices(draft: string, skills: ComposerSkill[]) {
  const query = draft.slice(1).toLowerCase();
  if (!query) return [];
  const commands = [{ name: 'model', description: 'Choose the model and reasoning' }, { name: 'permissions', description: 'Choose access for this session' }, { name: 'skills', description: 'Browse available skills' }];
  return [...(query === 'skills' ? [] : commands.filter(command => command.name.startsWith(query))), ...skills.filter(skill => query === 'skills' || skill.name.toLowerCase().includes(query)).map(skill => ({ ...skill, skill: true }))].slice(0, 80);
}

export function useComposerCommands(props: { draft: string; projectPath?: string; deviceId?: string; onDraft: (value: string) => void; onSettings: () => void; onFocus: () => void }) {
  const [skills, setSkills] = useState<ComposerSkill[]>([]), [status, setStatus] = useState(''), [retry, setRetry] = useState(0), [selection, setSelection] = useState({ scope: '', index: 0 }), [dismissed, setDismissed] = useState<number>();
  const request = useRef<string>();
  const scope = JSON.stringify([props.deviceId, props.projectPath, props.draft]);
  const revision = useRef({ scope, value: 0 });
  if (revision.current.scope !== scope) revision.current = { scope, value: revision.current.value + 1 };
  const selected = selection.scope === scope ? selection.index : 0;
  const active = /^\/[\w:.-]+$/.test(props.draft) && dismissed !== revision.current.value;
  const choices = commandChoices(props.draft, skills), id = useId();
  const visible = active && (choices.length > 0 || props.draft.toLowerCase() === '/skills');
  useEffect(() => {
    if (!active) return;
    setSkills([]);
    if (!props.projectPath) { setStatus('Choose a project to discover skills.'); return; }
    const requestId = createActionRequestId(true); request.current = requestId;
    setStatus('Loading skills…');
    const receive = (event: MessageEvent<DashboardHostMessage>) => {
      const message = event.data;
      if (message?.type !== 'dashboard:action-result' || message.requestId !== requestId || request.current !== requestId) return;
      clearTimeout(timer); request.current = undefined;
      const values = message.payload?.cliSkills;
      if (message.status === 'completed' && Array.isArray(values)) { setSkills(values); setStatus(message.payload?.notice?.message ?? (values.length ? '' : 'No enabled skills found for this project.')); }
      else setStatus(message.error ?? 'Skills could not be loaded. Reconnect and retry.');
    };
    window.addEventListener('message', receive);
    const timer = setTimeout(() => { if (request.current === requestId) { request.current = undefined; setStatus('Skill discovery timed out. Reconnect and retry.'); } }, 20_000);
    try { postMessageToHost({ type: 'dashboard:action', action: 'getCodexSkills', requestId, payload: { projectPath: props.projectPath, targetDeviceId: props.deviceId } }); }
    catch { clearTimeout(timer); setStatus('Skills were not requested. Reconnect and retry.'); }
    return () => { clearTimeout(timer); request.current = undefined; window.removeEventListener('message', receive); };
  }, [active, props.projectPath, props.deviceId, retry]);
  const choose = (index: number) => {
    const choice = choices[index]; if (!choice) return;
    if ('skill' in choice) props.onDraft(`$${choice.name} `);
    else if (choice.name === 'skills') props.onDraft('/skills');
    else { props.onDraft(''); props.onSettings(); }
    props.onFocus();
  };
  const onKeyDown = (event: JSX.TargetedKeyboardEvent<HTMLTextAreaElement>) => {
    if (!visible || event.isComposing) return false;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setDismissed(revision.current.value); return true; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setSelection(current => ({ scope, index: choices.length ? ((current.scope === scope ? current.index : 0) + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length : 0 })); return true; }
    if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) { event.preventDefault(); if (choices.length) choose(Math.min(selected, choices.length - 1)); return true; }
    return false;
  };
  return { active: visible, id, selectedId: choices.length ? `${id}-${Math.min(selected, choices.length - 1)}` : undefined, onKeyDown, panel: visible ? <div class="cli-composer-commands" id={id} role="listbox" aria-label="Commands and skills">{choices.map((choice, index) => <button type="button" role="option" id={`${id}-${index}`} aria-selected={index === selected} key={`${'skill' in choice ? '$' : '/'}${choice.name}`} onClick={() => choose(index)}><strong>{'skill' in choice ? '$' : '/'}{choice.name}</strong><small>{choice.description}</small></button>)}{!choices.length && !status ? <div role="status">No matching commands or skills. Press Escape to keep typing.</div> : null}{status ? <div role="status">{status}{status !== 'Loading skills…' ? <button type="button" onClick={() => setRetry(value => value + 1)}>Retry skills</button> : null}</div> : null}</div> : null };
}

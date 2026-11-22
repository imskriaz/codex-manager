import {MobileSectionPicker} from './mobileSectionPicker';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { WorkspaceBrowserRequest, WorkspaceBrowserState } from '../../src/domain/workspaceBrowser';
import type { useWorkspaceRequest } from './workspaceRequest';
import { deferredPanel } from './deferredPanel';
import { WorkspaceMenu } from './workspaceMenu';

const WorkspaceCodeEditor = deferredPanel(() => import('./workspaceCodeEditor'), 'editor');

type InspectorProps = Parameters<typeof BrowserInspectorContent>[0];
export type BrowserConsoleState = {
  script: string; filter: string; clearedThrough: number; level: string;
  history: Array<{ script: string; outcome: { value?: unknown; message: string; failed: boolean } }>;
  submitted: string;
};
export const emptyBrowserConsole = (): BrowserConsoleState => ({ script: '', filter: '', clearedThrough: 0, level: 'all', history: [], submitted: '' });
export function consoleEventLevel(value: string): string { return value === 'info' ? 'log' : value === 'warn' ? 'warning' : value; }


export function BrowserResizeHandle(props: { label: string; value: number; onChange: (value: number) => void; axis: 'x' | 'y'; reverse?: boolean; responsive?: boolean }) {
  const start = useRef<{ point: number; value: number; extent: number; vertical: boolean }>();
  return <div class={`workspace-browser-resizer axis-${props.axis} ${props.responsive ? 'is-responsive' : ''}`} role="separator" tabindex={0} aria-label={props.label} aria-orientation={props.axis === 'x' ? 'vertical' : 'horizontal'} aria-valuenow={Math.round(props.value)} aria-valuemin={15} aria-valuemax={85}
    onPointerDown={event => {
      event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
      const vertical = props.axis === 'y' || !!props.responsive && getComputedStyle(event.currentTarget.parentElement!).flexDirection === 'column';
      const rect = event.currentTarget.parentElement!.getBoundingClientRect();
      start.current = { point: vertical ? event.clientY : event.clientX, value: props.value, extent: vertical ? rect.height : rect.width, vertical };
    }}
    onPointerMove={event => { if (start.current) { const drag = start.current; props.onChange(Math.max(15, Math.min(85, drag.value + ((drag.vertical ? event.clientY : event.clientX) - drag.point) / drag.extent * 100 * (props.reverse || drag.vertical ? -1 : 1)))); } }}
    onPointerUp={() => { start.current = undefined; }} onPointerCancel={() => { start.current = undefined; }}
    onKeyDown={event => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const delta = (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -5 : 5) * (props.reverse ? -1 : 1); props.onChange(event.key === 'Home' ? 15 : event.key === 'End' ? 85 : Math.max(15, Math.min(85, props.value + delta))); } }} />;
}

function useInspection(props: InspectorProps, operation: WorkspaceBrowserRequest['operation'], params?: Record<string, unknown>, selector?: string, enabled = true) {
  const [result, setResult] = useState<WorkspaceBrowserState>(), [error, setError] = useState(''), [loading, setLoading] = useState(false), [retry, setRetry] = useState(0);
  const encoded = JSON.stringify(params);
  const inFlight = useRef<Promise<unknown>>();
  useEffect(() => {
    let disposed = false;
    setResult(undefined); setError(''); setLoading(false);
    if (!props.pageId || !props.connected || !enabled || props.active === false) return;
    const read = () => {
      if (disposed || document.visibilityState !== 'visible' || inFlight.current) return;
      setLoading(true);
      const work = props.request('workspaceBrowser', { browserRequest: { operation, pageId: props.pageId, params, selector } }).then(response => {
        if (!disposed) { if (!response.workspaceBrowser) throw new Error('No inspection was returned.'); setResult(response.workspaceBrowser); setError(''); }
      }).catch(error => { if (!disposed) setError(error instanceof Error ? error.message : String(error)); }).finally(() => {
        if (inFlight.current === work) inFlight.current = undefined;
        if (!disposed) setLoading(false);
      });
      inFlight.current = work;
    };
    // A changed selector waits for the previous read, without starting an overlapping request.
    if (inFlight.current) void inFlight.current.then(read); else read();
    const timer = operation === 'events' ? setInterval(read, 1500) : undefined;
    return () => { disposed = true; clearInterval(timer); };
  }, [props.pageId, props.connected, props.revision, props.request, operation, encoded, selector, retry, enabled, props.active]);
  return { result, error, loading, refresh: () => setRetry(value => value + 1) };
}

function InspectionStatus(props: { error: string; loading: boolean; refresh: () => void }) {
  return props.error ? <span class="workspace-browser-inline-status" role="alert" title={props.error}><span aria-hidden="true">⚠</span><span>{props.error}</span><button type="button" aria-label="Retry inspection" title="Retry" onClick={props.refresh}>Retry</button></span> : null;
}

type PaneDock = 'left' | 'right' | 'bottom';
function PanePosition(props: { name: string; value: PaneDock; onChange: (value: PaneDock) => void }) {
  return <WorkspaceMenu label={`${props.name} position`} icon={<span aria-hidden="true">⋮</span>}>{(['left', 'right', 'bottom'] as const).map(value => <button type="button" role="menuitemradio" aria-checked={props.value === value} onClick={() => props.onChange(value)}>Dock {value}</button>)}</WorkspaceMenu>;
}

export function BrowserInspectorContent(props: {
  panel: "elements" | "console" | "sources" | "network" | "application" | "performance" | "memory";
  selector?: string; wrap?: boolean;
  onCommand: (request: Partial<WorkspaceBrowserRequest> & Pick<WorkspaceBrowserRequest, "operation">) => void;
  pageId: string; revision?: string; connected: boolean;
  request: ReturnType<typeof useWorkspaceRequest>;
  busy: boolean;
  consoleState?: BrowserConsoleState;
  onConsoleState?: (state: BrowserConsoleState) => void;
  active?: boolean;
  outcome?: { value?: unknown; message: string; failed: boolean };
  onClearConsole: () => void;
  onEvaluate: (text: string) => void;
  onInspectionApplied?: (state: WorkspaceBrowserState) => void;
}) {
  const inspection = useInspection(props, 'events', undefined, undefined, props.panel === 'console');
  const { result, error, loading } = inspection;
  const [localConsole, setLocalConsole] = useState(emptyBrowserConsole);
  const consoleState = props.consoleState ?? localConsole;
  const latestConsole = useRef(consoleState); latestConsole.current = consoleState;
  const changeConsole = (patch: Partial<BrowserConsoleState>) => {
    const next = { ...latestConsole.current, ...patch }; latestConsole.current = next;
    if (props.onConsoleState) props.onConsoleState(next); else setLocalConsole(next);
  };
  const { script, filter, clearedThrough, level, history } = consoleState;
  const setScript = (value: string | ((current: string) => string)) => changeConsole({ script: typeof value === 'function' ? value(latestConsole.current.script) : value });
  const setFilter = (filter: string) => changeConsole({ filter });
  const setClearedThrough = (clearedThrough: number) => changeConsole({ clearedThrough });
  const setLevel = (level: string) => changeConsole({ level });
  const setHistory = (value: BrowserConsoleState['history'] | ((current: BrowserConsoleState['history']) => BrowserConsoleState['history'])) => changeConsole({ history: typeof value === 'function' ? value(latestConsole.current.history) : value });
  const submitted = useRef(consoleState.submitted), previousOutcome = useRef(consoleState.submitted ? undefined : props.outcome), historyIndex = useRef(0);
  const submit = () => { if (script.trim() && !props.busy) { submitted.current = script; changeConsole({ submitted: script }); props.onEvaluate(script); } };
  useEffect(() => {
    if (props.outcome && props.outcome !== previousOutcome.current && submitted.current) {
      const completedScript = submitted.current;
      setHistory(previous => [...previous.slice(-49), { script: completedScript, outcome: props.outcome! }]);
      submitted.current = ''; changeConsole({ submitted: '' }); historyIndex.current = 0;
      if (!props.outcome.failed) setScript(current => current === completedScript ? '' : current);
    }
    previousOutcome.current = props.outcome;
  }, [props.outcome]);
  if (!props.pageId) return <p class="workspace-empty-inline">Open a page to inspect it.</p>;
  if (!props.connected) return <p role="status" class="workspace-empty-inline">Reconnect to inspect this page.</p>;
  if (props.panel === 'elements') return <BrowserElements {...props} />;
  if (props.panel === 'sources') return <BrowserSources {...props} />;
  if (props.panel === 'application') return <BrowserApplication {...props} />;
  if (props.panel === 'performance' || props.panel === 'memory') return <BrowserMetrics {...props} />;
  if (props.panel === 'network') return <BrowserNetwork {...props} />;
  if (error) return <InspectionStatus error={error} loading={loading} refresh={inspection.refresh} />;
  if (loading && props.panel !== 'console') return null;
  const events = result?.events ?? [];
  const rows = events.filter(event => ['Runtime.consoleAPICalled', 'Runtime.exceptionThrown', 'Log.entryAdded'].includes(event.method));
  if (props.panel === 'console') return <div class="workspace-browser-console">
    <div class="workspace-browser-console-toolbar">
      <span class="workspace-browser-console-context">top</span>
      <input aria-label="Filter console" placeholder="Filter" value={filter} onInput={event => setFilter(event.currentTarget.value)} />
      <select aria-label="Console levels" value={level} onChange={event => setLevel(event.currentTarget.value)}><option value="all">All levels</option><option value="error">Errors</option><option value="warning">Warnings</option><option value="log">Info</option></select>
      <select aria-label="Console starter script" value="" onChange={(event) => { if (event.currentTarget.value) setScript(event.currentTarget.value); }}>
        <option value="">Starter scripts</option>
        <option value="document.title">Read page title</option>
        <option value="document.body.innerText.slice(0, 2000)">Read visible text</option>
        <option value="Object.keys(localStorage)">List local storage keys</option>
      </select>
      <span class="workspace-browser-pane-actions"><button type="button" aria-label="Clear console" title="Clear console" onClick={() => { setClearedThrough(result?.eventSequence ?? Math.max(0, ...events.map(event => event.sequence))); setHistory([]); props.onClearConsole(); }}><svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="10" cy="10" r="6" /><path d="m6 14 8-8" /></svg></button></span>
    </div>
    <div class="workspace-browser-log-list" aria-label="Console messages">{rows.filter(event => event.sequence > clearedThrough && JSON.stringify(event.params).toLowerCase().includes(filter.toLowerCase())).map(event => {
      const params = event.params as { type?: string; args?: Array<{ value?: unknown; description?: string }>; exceptionDetails?: { text?: string; exception?: { description?: string } }; entry?: { level: string; text: string; url?: string; lineNumber?: number } };
      const eventLevel = consoleEventLevel(params.entry?.level ?? (params.exceptionDetails ? 'error' : params.type ?? 'log'));
      if (level !== 'all' && eventLevel !== level) return null;
      return <div class={eventLevel === 'error' ? 'is-error' : eventLevel === 'warning' ? 'is-warning' : ''} key={event.sequence}><span class="workspace-browser-event-type">{eventLevel === 'error' ? '⊗' : eventLevel === 'warning' ? '⚠' : ''}</span><span>{params.entry?.text ?? params.args?.map(arg => typeof arg.value === 'string' ? arg.value : JSON.stringify(arg.value) ?? arg.description ?? '').join(' ') ?? params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text}{params.entry?.url ? <small> {params.entry.url}:{(params.entry.lineNumber ?? 0) + 1}</small> : null}</span></div>;
    })}</div>
    {history.map((item, index) => <section key={index}><pre class="workspace-browser-console-command">› {item.script}</pre>{item.outcome.failed ? <div class="workspace-browser-console-error" role="alert">⊗ {item.outcome.message}</div> : <pre class="workspace-browser-console-result" aria-label="Console result">‹ {typeof item.outcome.value === 'string' ? item.outcome.value : JSON.stringify(item.outcome.value, null, 2) ?? 'undefined'}</pre>}</section>)}
    {!history.length && props.outcome?.failed ? <div class="workspace-browser-console-error" role="alert">⊗ {props.outcome.message}</div> : null}
    {!history.length && props.outcome && !props.outcome.failed ? <pre class="workspace-browser-console-result" aria-label="Console result">‹ {typeof props.outcome.value === 'string' ? props.outcome.value : JSON.stringify(props.outcome.value, null, 2) ?? 'undefined'}</pre> : null}
    <form class="workspace-browser-console-prompt" onSubmit={event => { event.preventDefault(); submit(); }}>
      <span aria-hidden="true">›</span><textarea rows={1} aria-label="Console JavaScript" spellcheck={false} maxLength={16000} value={script} onInput={event => setScript(event.currentTarget.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); submit(); } else if (event.key === 'ArrowUp' && !script.includes('\n') && history.length) { event.preventDefault(); historyIndex.current = Math.min(history.length, historyIndex.current + 1); setScript(history[history.length - historyIndex.current]!.script); } else if (event.key === 'ArrowDown' && historyIndex.current > 0) { event.preventDefault(); historyIndex.current--; setScript(historyIndex.current ? history[history.length - historyIndex.current]!.script : ''); } }} />
      <button type="submit" disabled={props.busy || !script.trim()} title="Run JavaScript">{props.busy ? 'Running…' : 'Run'}</button>
    </form>
  </div>;
  return null;
}


function BrowserElements(props: InspectorProps) {
  const [cssEdit, setCssEdit] = useState<string>(), [cssReplace, setCssReplace] = useState(false), [cssError, setCssError] = useState(''), [cssBusy, setCssBusy] = useState(false);
  const cssRevision = useRef(props.revision), lastCssPropRevision = useRef(props.revision);
  if (lastCssPropRevision.current !== props.revision) { lastCssPropRevision.current = props.revision; cssRevision.current = props.revision; }
  const html = useInspection(props, 'html');
  const [selector, setSelector] = useState(props.selector || 'body'), [tab, setTab] = useState('styles');
  const [filter, setFilter] = useState(''), [closed, setClosed] = useState(false), [panelSize, setPanelSize] = useState(48), [position, setPosition] = useState<PaneDock>('right');
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const [ancestors, setAncestors] = useState(true);
  useEffect(() => { setSelector(props.selector || 'body'); setClosed(false); }, [props.selector]);
  const inspection = useInspection(props, 'styles', { action: tab === 'listeners' ? 'listeners' : 'rules', ancestors }, selector);
  useEffect(() => { setCssEdit(undefined); setCssError(''); }, [props.pageId, selector]);
  const applyCss = async () => {
    if (cssEdit === undefined || cssBusy) return;
    setCssBusy(true); setCssError('');
    try {
      const validation = document.createElement('span').style;
      validation.cssText = cssEdit;
      if (cssEdit.trim() && !validation.length) throw new Error('Enter valid CSS declarations.');
      const response = await props.request('workspaceBrowser', { browserRequest: { operation:'evaluate',operationId:crypto.randomUUID(),pageId:props.pageId,revision:cssRevision.current,confirmed:true,text:`(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!(element instanceof HTMLElement || element instanceof SVGElement)) throw new Error('The selected element is unavailable.'); const text = ${JSON.stringify(cssEdit)}; const declarations = document.createElement('span').style; declarations.cssText = text; if (text.trim() && !declarations.length) throw new Error('Enter valid CSS declarations.'); if (${cssReplace}) element.style.cssText = text; else for (const name of declarations) element.style.setProperty(name, declarations.getPropertyValue(name), declarations.getPropertyPriority(name)); return true; })()` } });
      if (!response.workspaceBrowser) throw new Error('CSS outcome was not returned. Inspect the element before retrying.');
      cssRevision.current = response.workspaceBrowser.revision; props.onInspectionApplied?.(response.workspaceBrowser); setCssEdit(undefined); inspection.refresh();
    } catch (error) { setCssError(error instanceof Error ? error.message : String(error)); }
    finally { setCssBusy(false); }
  };
  const value = inspection.result?.value as { html?: string; styles?: Record<string, string>; rules?: Array<{ selector: string; declarations: string }>; listeners?: Array<{ type: string; handler?: string; useCapture: boolean; passive: boolean; once: boolean; lineNumber: number; scriptId: string }> } | undefined;
  const rows = useMemo(() => {
    const parsed = new DOMParser().parseFromString(typeof html.result?.value === 'string' ? html.result.value : '', 'text/html');
    const result: Array<{ element: Element; selector: string; depth: number; closing: boolean }> = [];
    const visit = (element: Element, depth: number, path: string) => {
      if (result.length >= 800 || depth > 20) return;
      result.push({ element, selector: path, depth, closing: false });
      if (!collapsed.has(path)) {
        for (const child of element.children) {
          const tag = child.tagName.toLowerCase();
          const index = [...element.children].filter(sibling => sibling.tagName === child.tagName).indexOf(child) + 1;
          visit(child, depth + 1, `${path} > ${tag}:nth-of-type(${index})`);
        }
        if (element.children.length) result.push({ element, selector: path, depth, closing: true });
      }
    };
    visit(parsed.documentElement, 0, 'html:nth-of-type(1)');
    return result;
  }, [html.result?.value, collapsed]);
  return <div class={`workspace-browser-elements pane-${position} ${position === 'bottom' ? 'is-stacked' : ''}`}>
    <div class="workspace-browser-dom" aria-label="Page elements" role="tree">
      <div class="workspace-browser-pane-toolbar"><span>&lt;!DOCTYPE html&gt;</span><span class="workspace-browser-pane-actions">{closed ? <button type="button" onClick={() => setClosed(false)}>Show Styles</button> : null}</span></div>
      <InspectionStatus {...html} />
      {rows.map((row, index) => <div key={index} class={`workspace-browser-dom-row ${row.selector === selector && !row.closing ? 'is-selected' : ''}`} style={{ paddingLeft: `${row.depth * 12}px` }}>
        <button type="button" class="workspace-browser-dom-expander" aria-label={`${collapsed.has(row.selector) ? 'Expand' : 'Collapse'} ${row.element.tagName.toLowerCase()}`} disabled={row.closing || !row.element.children.length} onClick={() => setCollapsed(previous => { const next = new Set(previous); if (next.has(row.selector)) next.delete(row.selector); else next.add(row.selector); return next; })}>{row.closing || !row.element.children.length ? '' : collapsed.has(row.selector) ? '▸' : '▾'}</button>
        <button type="button" role="treeitem" aria-selected={row.selector === selector && !row.closing} onClick={() => setSelector(row.selector)}><span class="workspace-browser-dom-tag">&lt;{row.closing ? '/' : ''}{row.element.tagName.toLowerCase()}</span>{!row.closing ? [...row.element.attributes].map(attribute => <span key={attribute.name}> <span class="workspace-browser-dom-attribute">{attribute.name}</span>=<span class="workspace-browser-dom-value">"{attribute.value}"</span></span>) : null}<span class="workspace-browser-dom-tag">&gt;</span>{!row.closing && !row.element.children.length ? <><span>{row.element.textContent?.slice(0, 160)}</span><span class="workspace-browser-dom-tag">&lt;/{row.element.tagName.toLowerCase()}&gt;</span></> : null}</button>
      </div>)}
      <footer class="workspace-browser-breadcrumb">{selector}</footer>
    </div>
    {!closed ? <><BrowserResizeHandle label="Resize Styles panel" value={panelSize} onChange={setPanelSize} axis={position === 'bottom' ? 'y' : 'x'} reverse={position !== 'left'} />
    <aside class="workspace-browser-styles" aria-label="Element styles" style={{ flexBasis: `${panelSize}%` }}>
      <nav role="tablist" aria-label="Element style views"><MobileSectionPicker label="Element style view" value={tab} options={['styles','computed','layout','listeners'].map(value=>({value,label:value==='listeners'?'Event Listeners':value.charAt(0).toUpperCase()+value.slice(1)}))} onChange={setTab}/><span class="workspace-browser-pane-tabs">{(['styles', 'computed', 'layout', 'listeners'] as const).map(name => <button type="button" role="tab" aria-selected={tab === name} class={tab === name ? 'is-active' : ''} onClick={() => setTab(name)}>{name === 'listeners' ? 'Event Listeners' : name.charAt(0).toUpperCase() + name.slice(1)}</button>)}</span><span class="workspace-browser-pane-actions"><PanePosition name="Styles" value={position} onChange={setPosition} /><button type="button" aria-label="Close Styles panel" onClick={() => setClosed(true)}>×</button></span></nav>
      <div class="workspace-browser-pane-toolbar"><input aria-label="Filter styles" placeholder="Filter" value={filter} onInput={event => setFilter(event.currentTarget.value)} />{tab === 'listeners' ? <label><input type="checkbox" checked={ancestors} onChange={event => setAncestors(event.currentTarget.checked)} />Ancestors</label> : null}</div>
      <InspectionStatus {...inspection} />
      {tab === 'styles' ? <>{cssEdit !== undefined ? <form class="workspace-browser-css-editor" onSubmit={event => { event.preventDefault(); void applyCss(); }}><textarea autoFocus aria-label="CSS declarations" value={cssEdit} disabled={cssBusy} onInput={event => setCssEdit(event.currentTarget.value)} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setCssEdit(undefined); setCssError(''); } else if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void applyCss(); } }} />{cssError ? <span role="alert">{cssError}</span> : null}<button type="submit" disabled={cssBusy}>Apply</button><button type="button" disabled={cssBusy} onClick={() => setCssEdit(undefined)}>Cancel</button></form> : null}{value?.rules?.filter(rule => `${rule.selector} ${rule.declarations}`.toLowerCase().includes(filter.toLowerCase())).map((rule, index) => <div class="workspace-browser-style-rule" key={index}><span>{rule.selector} {'{'}</span><pre tabindex={0} title="Double-click to edit declarations on this element" onDblClick={() => { setCssEdit(rule.declarations); setCssReplace(rule.selector === 'element.style'); setCssError(''); }} onKeyDown={event => { if (event.key === 'Enter') { setCssEdit(rule.declarations); setCssReplace(rule.selector === 'element.style'); setCssError(''); } }}>{rule.declarations || ' '}</pre><span>{'}'}</span></div>)}</> : tab === 'listeners' ? <div class="workspace-browser-listeners">{value?.listeners?.filter(listener => `${listener.type} ${listener.handler}`.toLowerCase().includes(filter.toLowerCase())).map((listener, index) => <details key={index}><summary>{listener.type} <small>{listener.scriptId}:{listener.lineNumber}</small></summary><pre>{listener.handler}</pre><p>Capture: {String(listener.useCapture)} · Passive: {String(listener.passive)} · Once: {String(listener.once)}</p></details>)}{value?.listeners?.length === 0 ? <p>No event listeners on this element.</p> : null}</div> : <dl>{Object.entries(value?.styles ?? {}).filter(([name, value]) => (tab !== 'layout' || /display|position|width|height|margin|padding|border|box|grid|flex|gap|align|justify/.test(name)) && `${name} ${value}`.toLowerCase().includes(filter.toLowerCase())).map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl>}
    </aside></> : null}
  </div>;
}

type Resource = { url: string; frameId: string; type: string };
type FrameTree = { frame: { id: string; url: string }; resources: Array<{ url: string; type: string }>; childFrames?: FrameTree[] };
function BrowserSources(props: InspectorProps) {
  const tree = useInspection(props, 'html', { action: 'resources' });
  const [navigator, setNavigator] = useState(true), [debuggerOpen, setDebuggerOpen] = useState(true), [size, setSize] = useState(27), [debugSize, setDebugSize] = useState(30);
  const [debugPosition, setDebugPosition] = useState<PaneDock>('right');
  const [position, setPosition] = useState<PaneDock>('left');
  const [filter, setFilter] = useState(''), [opened, setOpened] = useState<Resource[]>([]), [selected, setSelected] = useState<Resource>();
  const resources = useMemo(() => {
    const result: Resource[] = [];
    const visit = (frame?: FrameTree) => { if (!frame) return; result.push({ frameId: frame.frame.id, url: frame.frame.url, type: 'Document' }); frame.resources.forEach(resource => result.push({ ...resource, frameId: frame.frame.id })); frame.childFrames?.forEach(visit); };
    visit((tree.result?.value as { frameTree?: FrameTree } | undefined)?.frameTree); return result;
  }, [tree.result]);
  const content = useInspection(props, 'html', selected ? { action: 'resource', frameId: selected.frameId, url: selected.url } : undefined, undefined, !!selected);
  const value = content.result?.value as { content?: string; base64Encoded?: boolean } | string | undefined;
  const source = typeof value === 'string' ? value : value?.base64Encoded ? 'Binary resource (base64)\n' + value.content : value?.content ?? '';
  return <div class="workspace-browser-sources">
    <div class="workspace-browser-pane-toolbar"><span>Page</span><span class="workspace-browser-pane-actions"><button type="button" aria-label="Toggle source navigator" aria-pressed={navigator} onClick={() => setNavigator(value => !value)}>◧</button><PanePosition name="Sources" value={position} onChange={setPosition} /><button type="button" aria-label="Toggle source debugger" aria-pressed={debuggerOpen} onClick={() => setDebuggerOpen(value => !value)}>◨</button></span></div>
    <div class={`workspace-browser-source-layout details-${debugPosition}`}><div class={`workspace-browser-source-layout pane-${position}`} >
      {navigator ? <><aside class="workspace-browser-source-navigator" aria-label="Source navigator" style={{ flexBasis: `${size}%` }}><input aria-label="Filter sources" placeholder="Find file…" value={filter} onInput={event => setFilter(event.currentTarget.value)} /><InspectionStatus {...tree} />{[...new Set(resources.map(resource => { try { return new URL(resource.url).origin; } catch { return resource.url; } }))].map(origin => <details key={origin} open><summary>{origin}</summary>{resources.filter(resource => resource.url.startsWith(origin) && resource.url.toLowerCase().includes(filter.toLowerCase())).map(resource => <button type="button" key={resource.url} title={resource.url} class={selected?.url === resource.url ? 'is-active' : ''} onClick={() => { setSelected(resource); setOpened(previous => previous.some(item => item.url === resource.url) ? previous : [...previous, resource]); }}>{resource.type === 'Script' ? '◇ ' : resource.type === 'Stylesheet' ? '▧ ' : '▤ '}{resource.url.split('/').at(-1) || '(index)'}</button>)}</details>)}</aside><BrowserResizeHandle label="Resize source navigator" value={size} onChange={setSize} axis={position === 'bottom' ? 'y' : 'x'} reverse={position !== 'left'} /></> : null}
      <section class="workspace-browser-source-editor" aria-label="Source editor"><MobileSectionPicker label="Browser source file" value={selected?.url||''} options={opened.map(resource=>({value:resource.url,label:resource.url.split('/').at(-1)||'(index)'}))} onChange={value=>setSelected(opened.find(resource=>resource.url===value))}>{selected?<button type="button" aria-label="Close selected source file" onClick={()=>{setOpened(previous=>previous.filter(item=>item.url!==selected.url));setSelected(opened.filter(item=>item.url!==selected.url).at(-1));}}>?</button>:null}</MobileSectionPicker><nav class="workspace-browser-source-tabs mobile-desktop-tabs">{opened.map(resource => <span key={resource.url}><button type="button" class={selected?.url === resource.url ? 'is-active' : ''} onClick={() => setSelected(resource)}>{resource.url.split('/').at(-1) || '(index)'}</button><button type="button" aria-label={`Close source ${resource.url.split('/').at(-1) || '(index)'}`} onClick={() => { setOpened(previous => previous.filter(item => item.url !== resource.url)); if (selected?.url === resource.url) setSelected(opened.filter(item => item.url !== resource.url).at(-1)); }}>×</button></span>)}</nav>{selected ? <><InspectionStatus {...content} /><SourceText text={source} wrap={props.wrap} path={selected.url} /></> : <p class="workspace-browser-source-empty">Select a loaded file from the Page navigator.</p>}</section>
      </div>{debuggerOpen ? <><BrowserResizeHandle label="Resize source debugger" value={debugSize} onChange={setDebugSize} axis={debugPosition === 'bottom' ? 'y' : 'x'} reverse={debugPosition !== 'left'} /><SourceDebugger {...props} resource={selected} size={debugSize} position={debugPosition} onPosition={setDebugPosition} /></> : null}
    </div>
  </div>;
}

function SourceText(props: { text: string; wrap?: boolean; path?: string }) {
  const language = props.path?.split(/[?#]/)[0]?.split('.').at(-1) ?? (props.text.trim().startsWith('<') ? 'html' : props.text.trim().startsWith('{') ? 'json' : 'js');
  return <div class={`workspace-browser-source ${props.wrap ? 'is-wrapped' : ''}`} aria-label="Source code"><WorkspaceCodeEditor path={props.path || 'Page source'} language={language} value={props.text} wrap={props.wrap} disabled onChange={() => undefined} onSave={() => undefined} /></div>;
}

function SourceDebugger(props: InspectorProps & { resource?: Resource; size: number; position: PaneDock; onPosition: (position: PaneDock) => void }) {
  const [line, setLine] = useState(1);
  const events = useInspection(props, 'events');
  const pause = events.result?.events?.filter(event => event.method === 'Debugger.paused' || event.method === 'Debugger.resumed').at(-1);
  const paused = pause?.method === 'Debugger.paused';
  const command = (method: string, params?: Record<string, unknown>) => props.onCommand({ operation: 'cdp', confirmed: true, method, params });
  return <aside class="workspace-browser-source-debugger" aria-label="Source debugger" style={{ flexBasis: `${props.size}%` }}><div class="workspace-browser-pane-toolbar"><span class="workspace-browser-pane-actions"><button type="button" disabled={props.busy} onClick={() => command('Debugger.enable')}>Enable</button><button type="button" disabled={props.busy} onClick={() => command(paused ? 'Debugger.resume' : 'Debugger.pause')}>{paused ? 'Resume' : 'Pause'}</button><button type="button" disabled={props.busy || !paused} onClick={() => command('Debugger.stepOver')}>Step</button><PanePosition name="Debugger" value={props.position} onChange={props.onPosition} /></span></div><InspectionStatus {...events} /><details open><summary>Breakpoints</summary><form onSubmit={event => { event.preventDefault(); if (props.resource) command('Debugger.setBreakpointByUrl', { url: props.resource.url, lineNumber: line - 1 }); }}><input type="number" min={1} required aria-label="Breakpoint line" value={line} onInput={event => setLine(event.currentTarget.valueAsNumber)} /><button type="submit" disabled={!props.resource || props.busy}>Set breakpoint</button></form><button type="button" disabled={props.busy} onClick={() => command('Debugger.setBreakpointsActive', { active: false })}>Deactivate breakpoints</button><button type="button" disabled={props.busy} onClick={() => command('Debugger.setBreakpointsActive', { active: true })}>Activate breakpoints</button></details><details open><summary>Call Stack / Scope</summary>{paused ? <pre>{JSON.stringify(pause.params, null, 2)}</pre> : <p>Not paused</p>}</details><p>Paused pages automatically resume after 15 seconds to keep the shared browser usable.</p></aside>;
}

function BrowserApplication(props: InspectorProps) {
  const inspection = useInspection(props, 'storage');
  const [section, setSection] = useState('cookies'), [filter, setFilter] = useState(''), [size, setSize] = useState(28), [navigator, setNavigator] = useState(true);
  const [position, setPosition] = useState<PaneDock>('left');
  const [key, setKey] = useState(''), [entryValue, setEntryValue] = useState('');
  const [selectedKey, setSelectedKey] = useState(''), [detailSize, setDetailSize] = useState(30);
  useEffect(() => { setSelectedKey(''); setKey(''); setEntryValue(''); }, [section, props.pageId]);
  const value = inspection.result?.value as { origin?: string; cookies?: Array<Record<string, unknown>>; localStorage?: Record<string, string>; sessionStorage?: Record<string, string>; indexedDB?: unknown; cacheStorage?: unknown; serviceWorkers?: unknown } | undefined;
  const structured = section === 'indexedDB' || section === 'cacheStorage' || section === 'serviceWorkers';
  const entries: Array<Record<string, unknown>> = section === 'cookies' ? value?.cookies ?? [] : structured ? (Array.isArray(value?.[section as 'indexedDB']) ? value?.[section as 'indexedDB'] as unknown[] : []).map(row => typeof row === 'string' ? { name: row } : row as Record<string, unknown>) : Object.entries(section === 'localStorage' ? value?.localStorage ?? {} : value?.sessionStorage ?? {}).map(([name, value]) => ({ name, value }));
  const columns = section === 'cookies' ? ['name', 'value', 'domain', 'path', 'expires', 'httpOnly', 'secure', 'sameSite'] : section === 'indexedDB' ? ['name', 'version'] : section === 'cacheStorage' ? ['name'] : section === 'serviceWorkers' ? ['scope', 'scriptURL', 'state'] : ['name', 'value'];
  const rowKey = (row: Record<string, unknown>) => JSON.stringify([row['name'] ?? row['scope'], row['domain'], row['path']]);
  const selectedRow = entries.find(row => rowKey(row) === selectedKey);
  const names: Record<string, string> = { cookies: 'Cookies', localStorage: 'Local storage', sessionStorage: 'Session storage', indexedDB: 'IndexedDB', cacheStorage: 'Cache storage', serviceWorkers: 'Service workers' };
  return <div class="workspace-browser-application"><div class="workspace-browser-pane-toolbar"><strong>Application</strong><input aria-label="Filter storage" placeholder="Filter" value={filter} onInput={event => setFilter(event.currentTarget.value)} /><span class="workspace-browser-pane-actions"><button type="button" aria-label="Toggle application navigator" aria-pressed={navigator} onClick={() => setNavigator(value => !value)}>◧</button><PanePosition name="Storage navigator" value={position} onChange={setPosition} />{['cookies', 'localStorage', 'sessionStorage'].includes(section) ? <button type="button" disabled={props.busy} onClick={() => props.onCommand({ operation: 'storage', confirmed: true, params: { action: section === 'cookies' ? 'clearCookies' : section === 'localStorage' ? 'clearLocalStorage' : 'clearSessionStorage' } })}>Clear {names[section]}</button> : null}</span></div><MobileSectionPicker label="Application storage section" value={section} options={Object.entries(names).map(([value,label])=>({value,label}))} onChange={setSection}/><div class={`workspace-browser-source-layout pane-${position}`}>
    {navigator ? <><aside class="workspace-browser-source-navigator" aria-label="Application storage" style={{ flexBasis: `${size}%` }}><strong>Storage</strong>{Object.entries(names).map(([key, name]) => <button type="button" key={key} class={section === key ? 'is-active' : ''} onClick={() => setSection(key)}>{name}</button>)}</aside><BrowserResizeHandle label="Resize application navigator" value={size} onChange={setSize} axis={position === 'bottom' ? 'y' : 'x'} reverse={position !== 'left'} /></> : null}
    <section class="workspace-browser-storage-data" aria-label={names[section]}><header><strong>{names[section]}</strong><small>{value?.origin}</small></header><InspectionStatus {...inspection} />{['localStorage', 'sessionStorage'].includes(section) ? <form class="workspace-browser-storage-edit" onSubmit={event => { event.preventDefault(); props.onCommand({ operation: 'storage', confirmed: true, params: { action: section === 'localStorage' ? 'setLocalStorage' : 'setSessionStorage', key, value: entryValue } }); }}><input required aria-label="Storage key" placeholder="Key" value={key} onInput={event => setKey(event.currentTarget.value)} /><input aria-label="Storage value" placeholder="Value" value={entryValue} onInput={event => setEntryValue(event.currentTarget.value)} /><button type="submit" disabled={props.busy || !key}>Save entry</button><button type="button" disabled={props.busy || !key} onClick={() => props.onCommand({ operation: 'storage', confirmed: true, params: { action: section === 'localStorage' ? 'removeLocalStorage' : 'removeSessionStorage', key } })}>Delete entry</button></form> : null}<div class="workspace-browser-storage-table"><table><thead><tr>{columns.map(key => <th key={key}>{key}</th>)}</tr></thead><tbody>{entries.filter(row => JSON.stringify(row).toLowerCase().includes(filter.toLowerCase())).map((row, index) => <tr key={index} tabindex={0} aria-selected={rowKey(row) === selectedKey} class={rowKey(row) === selectedKey ? 'is-selected' : ''} onClick={() => { setSelectedKey(rowKey(row)); setKey(displayValue(row['name'])); setEntryValue(displayValue(row['value'])); }} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.currentTarget.click(); } }}>{columns.map(key => <td key={key} title={displayValue(row[key])}>{displayValue(row[key])}</td>)}</tr>)}</tbody></table></div>{selectedRow ? <><BrowserResizeHandle label="Resize storage details" value={detailSize} onChange={setDetailSize} axis="y" /><section class="workspace-browser-storage-details" aria-label="Storage entry details" style={{ flexBasis: `${detailSize}%` }}><div class="workspace-browser-pane-toolbar"><strong>{section === 'cookies' ? 'Cookie Value' : 'Entry details'}</strong><span class="workspace-browser-pane-actions"><button type="button" aria-label="Close storage details" onClick={() => setSelectedKey('')}>×</button></span></div>{'value' in selectedRow ? <pre>{displayValue(selectedRow['value'])}</pre> : null}<dl>{Object.entries(selectedRow).filter(([name]) => name !== 'value').map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{displayValue(value)}</dd></div>)}</dl></section></> : null}</section>
  </div></div>;
}

function BrowserMetrics(props: InspectorProps) {
  const inspection = useInspection(props, 'html', { action: props.panel === 'memory' ? 'heap' : 'metrics' });
  const value = inspection.result?.value as { metrics?: Array<{ name: string; value: number }> } | undefined;
  return <section class="workspace-browser-metrics"><div class="workspace-browser-pane-toolbar"><strong>{props.panel === 'memory' ? 'JavaScript heap' : 'Performance metrics'}</strong><span class="workspace-browser-pane-actions"><button type="button" disabled={inspection.loading} onClick={inspection.refresh}>Capture metrics</button></span></div><InspectionStatus {...inspection} /><dl>{(value?.metrics ?? Object.entries(value ?? {}).map(([name, value]) => ({ name, value }))).map(metric => <div key={displayValue(metric.name)}><dt>{displayValue(metric.name)}</dt><dd>{typeof metric.value === 'number' ? metric.value.toLocaleString() : displayValue(metric.value)}</dd></div>)}</dl><p>Current values reported by Chromium for this page.</p></section>;
}

type CapturedRequest = { requestId: string; timestamp?: number; type?: string; request?: { url: string; method: string; headers?: Record<string, string>; postData?: string }; response?: { url: string; status: number; mimeType?: string; headers?: Record<string, string>; timing?: unknown; encodedDataLength?: number }; errorText?: string; initiator?: unknown };
function BrowserNetwork(props: InspectorProps) {
  const inspection = useInspection(props, 'events');
  const [filter, setFilter] = useState(''), [type, setType] = useState('All'), [selected, setSelected] = useState(''), [tab, setTab] = useState('Headers'), [size, setSize] = useState(36), [cleared, setCleared] = useState(0);
  const [position, setPosition] = useState<PaneDock>('right');
  const rows = useMemo(() => {
    const result = new Map<string, CapturedRequest>();
    for (const event of inspection.result?.events ?? []) {
      if (!event.method.startsWith('Network.') || event.sequence <= cleared) continue;
      const params = event.params as CapturedRequest;
      if (!params.requestId) continue;
      result.set(params.requestId, { ...result.get(params.requestId), ...params });
    }
    return [...result.values()].filter(row => row.request || row.response || row.errorText);
  }, [inspection.result, cleared]);
  const row = rows.find(row => row.requestId === selected);
  const body = useInspection(props, 'html', { action: 'response', requestId: row?.requestId }, undefined, !!row && ['Preview', 'Response'].includes(tab));
  const bodyValue = body.result?.value as { body?: string; base64Encoded?: boolean } | undefined;
  const content = bodyValue?.base64Encoded ? 'Binary response (base64)\n' + bodyValue.body : bodyValue?.body ?? '';
  return <div class="workspace-browser-network"><div class="workspace-browser-pane-toolbar"><input aria-label="Filter network" placeholder="Filter" value={filter} onInput={event => setFilter(event.currentTarget.value)} /><span class="workspace-browser-pane-actions"><button type="button" aria-label="Clear network" onClick={() => { setCleared(inspection.result?.eventSequence ?? 0); setSelected(''); }}>⊘</button></span></div><MobileSectionPicker label="Network request type" value={type} options={['All','Fetch/XHR','Doc','CSS','JS','Img','Font','Media','Other'].map(value=>({value,label:value}))} onChange={setType}/><nav class="workspace-browser-network-types mobile-desktop-tabs">{['All', 'Fetch/XHR', 'Doc', 'CSS', 'JS', 'Img', 'Font', 'Media', 'Other'].map(value => <button type="button" aria-pressed={type === value} key={value} onClick={() => setType(value)}>{value}</button>)}</nav><InspectionStatus {...inspection} /><div class={`workspace-browser-source-layout details-${position}`}><section class="workspace-browser-network-requests" aria-label="Network requests" style={row ? { flexBasis: `${size}%`, flexGrow: 0 } : undefined}><table><thead><tr><th>Name</th><th>Status</th><th>Type</th><th>Size</th></tr></thead><tbody>{rows.filter(row => `${row.request?.url ?? row.response?.url} ${row.errorText ?? ''}`.toLowerCase().includes(filter.toLowerCase()) && (type === 'All' || (type === 'Fetch/XHR' ? ['Fetch', 'XHR'].includes(row.type ?? '') : ({ Doc: 'Document', CSS: 'Stylesheet', JS: 'Script', Img: 'Image', Font: 'Font', Media: 'Media', Other: 'Other' } as Record<string, string>)[type] === row.type))).map(row => <tr key={row.requestId} class={row.requestId === selected ? 'is-selected' : ''}><td><button type="button" title={row.request?.url ?? row.response?.url} onClick={() => setSelected(row.requestId)}>{(row.request?.url ?? row.response?.url)?.split('/').at(-1) || row.errorText || row.requestId}</button></td><td>{row.errorText || row.response?.status || 'Pending'}</td><td>{row.type}</td><td>{row.response?.encodedDataLength ?? ''}</td></tr>)}</tbody></table></section>{row ? <><BrowserResizeHandle label="Resize network details" value={size} onChange={setSize} axis={position === 'bottom' ? 'y' : 'x'} reverse={position === 'left'} /><section class="workspace-browser-network-details" aria-label="Request details"><nav><MobileSectionPicker label="Network request detail" value={tab} options={['Headers','Payload','Preview','Response','Initiator','Timing'].map(value=>({value,label:value}))} onChange={setTab}/><span class="workspace-browser-pane-tabs">{['Headers', 'Payload', 'Preview', 'Response', 'Initiator', 'Timing'].map(value => <button type="button" class={tab === value ? 'is-active' : ''} key={value} onClick={() => setTab(value)}>{value}</button>)}</span><span class="workspace-browser-pane-actions"><PanePosition name="Request details" value={position} onChange={setPosition} /><button type="button" aria-label="Close request details" onClick={() => setSelected('')}>×</button></span></nav>{tab === 'Headers' ? <><h4>General</h4><dl><dt>Request URL</dt><dd>{row.request?.url ?? row.response?.url}</dd><dt>Request Method</dt><dd>{row.request?.method ?? 'Not captured'}</dd><dt>Status Code</dt><dd>{row.response?.status ?? row.errorText ?? 'Pending'}</dd></dl>{[['Response headers', row.response?.headers], ['Request headers', row.request?.headers]].map(([name, headers]) => <section key={displayValue(name)}><h4>{displayValue(name)}</h4><dl>{Object.entries(headers ?? {}).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{displayValue(value)}</dd></div>)}</dl></section>)}</> : tab === 'Payload' ? <pre>{row.request?.postData ?? 'No captured request payload.'}</pre> : tab === 'Preview' || tab === 'Response' ? <><InspectionStatus {...body} />{!body.error ? <SourceText text={tab === 'Preview' ? prettyJson(content) : content} wrap={props.wrap} /> : null}</> : <pre>{JSON.stringify(tab === 'Timing' ? row.response?.timing ?? 'No response timing captured.' : row.initiator ?? 'Initiator was not captured.', null, 2)}</pre>}</section></> : null}</div><footer>{rows.length} captured requests · Latest 100 browser events</footer></div>;
}

function prettyJson(value: string): string { try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; } }
function displayValue(value: unknown): string { return typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' || value == null ? String(value ?? '') : JSON.stringify(value); }

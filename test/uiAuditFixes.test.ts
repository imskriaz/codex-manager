import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { handleTabKeyDown } from '../webview-src/dashboard/primitives';
it('leaves settings tab navigation to one handler', () => {
 const source = readFileSync('webview-src/dashboard/settingsOverlay.tsx','utf8').replace(/\r\n/g, '\n');
 expect(source).toContain('event.preventDefault();\n                event.stopPropagation();\n                const nextTab');
});
it('does not clear all file snapshots before a delete result', () => {
 const source = readFileSync('webview-src/dashboard/cliSessionsModal.tsx','utf8');
 expect(source).not.toContain('if (target.path === currentPath) props.onClearFile()');
});
it('provides an explicit terminal keyboard exit without changing shell Tab', () => {
 const source = readFileSync('webview-src/dashboard/workspaceTerminal.tsx','utf8');
 expect(source).toContain('event.key === "Escape" && event.shiftKey');
 expect(source).toContain('Press Shift+Escape to leave terminal input.');
 expect(source).toContain('if (domEvent.key === "Tab") domEvent.preventDefault()');
});
it('does not override verified workspace connectivity with navigator.onLine', () => {
 for (const file of ['workspaceRequest.ts','createProjectModal.tsx','editProjectModal.tsx']) expect(readFileSync(`webview-src/dashboard/${file}`,'utf8')).not.toContain('!navigator.onLine');
});
it('retains configurable CodeMirror wrapping', () => {
 const source = readFileSync('webview-src/dashboard/workspaceCodeEditor.tsx','utf8');
 expect(source).toContain('wrapping.current.reconfigure(props.wrap === false ? [] : EditorView.lineWrapping)');
 expect(readFileSync('webview-src/dashboard/workspaceBrowserInspector.tsx','utf8')).toContain('wrap={props.wrap}');
});
it('moves a shared tab list only one position', () => {
 const a = { focus: vi.fn(), click: vi.fn() }, b = { focus: vi.fn(), click: vi.fn() };
 vi.stubGlobal('document', { activeElement: a });
 handleTabKeyDown({ key:'ArrowRight', currentTarget:{ querySelectorAll: () => [a,b] }, preventDefault(){} } as any);
 expect(b.focus).toHaveBeenCalledOnce(); expect(b.click).toHaveBeenCalledOnce(); expect(a.click).not.toHaveBeenCalled(); vi.unstubAllGlobals();
});

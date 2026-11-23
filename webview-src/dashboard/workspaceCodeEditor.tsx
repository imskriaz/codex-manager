import { useEffect, useRef, useState } from "preact/hooks";
import { basicSetup } from "codemirror";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { indentUnit } from "@codemirror/language";

export default function WorkspaceCodeEditor(props: { path: string; language: string; value: string; disabled: boolean; wrap?: boolean; onChange: (value: string) => void; onSave: () => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView>();
  const editable = useRef(new Compartment());
  const wrapping = useRef(new Compartment());
  const syntax = useRef(new Compartment());
  const [syntaxWarning,setSyntaxWarning]=useState('');
  const onChangeRef = useRef(props.onChange);
  const onSaveRef = useRef(props.onSave);
  onChangeRef.current = props.onChange;
  onSaveRef.current = props.onSave;
  useEffect(() => {
    if (!containerRef.current) return;
    const view = new EditorView({
      parent: containerRef.current,
      state: EditorState.create({
        doc: props.value,
        extensions: [
          basicSetup,
          wrapping.current.of(props.wrap === false ? [] : EditorView.lineWrapping),
          indentUnit.of("  "),
          syntax.current.of([]),
          editable.current.of(EditorView.editable.of(!props.disabled)),
          keymap.of([indentWithTab, { key: "Mod-s", preventDefault: true, run: () => { onSaveRef.current(); return true; } }]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString());
          }),
          EditorView.theme({
            "&": { height: "100%", backgroundColor: "var(--bg-base)", color: "var(--text-primary)" },
            ".cm-scroller": { fontFamily: "var(--vscode-editor-font-family, Consolas, monospace)", fontSize: "11px", lineHeight: "1.55" },
            ".cm-gutters": { backgroundColor: "var(--bg-elevated)", color: "var(--text-muted)", borderRight: "1px solid var(--border-default)" },
            ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "var(--bg-hover)" },
            ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "var(--bg-selected) !important" },
            ".cm-cursor": { borderLeftColor: "var(--text-primary)" }
          }, { dark: true })
        ]
      })
    });
    viewRef.current = view;
    let active=true;setSyntaxWarning('');
    const warning='Syntax colours are unavailable. You can continue editing and saving.';
    const timer=setTimeout(()=>{if(active)setSyntaxWarning(warning);},12000);
    void editorLanguage(props.language).then(language=>{if(active){view.dispatch({effects:syntax.current.reconfigure(language)});setSyntaxWarning('');}},()=>{if(active)setSyntaxWarning(warning);}).finally(()=>clearTimeout(timer));
    return () => { active=false;clearTimeout(timer);view.destroy(); viewRef.current = undefined; };
  }, [props.path, props.language]);
  useEffect(() => {
    viewRef.current?.dispatch({ effects: editable.current.reconfigure(EditorView.editable.of(!props.disabled)) });
  }, [props.disabled]);
  useEffect(() => {
    viewRef.current?.dispatch({ effects: wrapping.current.reconfigure(props.wrap === false ? [] : EditorView.lineWrapping) });
  }, [props.wrap]);
  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === props.value) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: props.value } });
  }, [props.value]);
  return <>{syntaxWarning?<p role="status">{syntaxWarning}</p>:null}<div class="cli-code-editor" ref={containerRef} aria-label={`Edit ${props.path}`} /></>;
}

async function editorLanguage(language: string): Promise<Extension> {
  switch (language) {
    case "ts": case "typescript": return (await import('@codemirror/lang-javascript')).javascript({ typescript: true });
    case "tsx": case "typescriptreact": return (await import('@codemirror/lang-javascript')).javascript({ typescript: true, jsx: true });
    case "js": case "javascript": return (await import('@codemirror/lang-javascript')).javascript();
    case "jsx": case "javascriptreact": return (await import('@codemirror/lang-javascript')).javascript({ jsx: true });
    case "json": return (await import('@codemirror/lang-json')).json();
    case "css": case "scss": case "less": return (await import('@codemirror/lang-css')).css();
    case "html": case "htm": return (await import('@codemirror/lang-html')).html();
    case "md": case "markdown": return (await import('@codemirror/lang-markdown')).markdown();
    case "py": case "python": return (await import('@codemirror/lang-python')).python();
    case "java": return (await import('@codemirror/lang-java')).java();
    case "c": case "cc": case "cpp": case "cxx": case "h": case "hpp": return (await import('@codemirror/lang-cpp')).cpp();
    case "rs": case "rust": return (await import('@codemirror/lang-rust')).rust();
    case "sql": return (await import('@codemirror/lang-sql')).sql();
    case "xml": case "svg": return (await import('@codemirror/lang-xml')).xml();
    case "yaml": case "yml": return (await import('@codemirror/lang-yaml')).yaml();
    default: return [];
  }
}

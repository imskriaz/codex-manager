import { useEffect, useRef } from "preact/hooks";
import { basicSetup } from "codemirror";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { indentUnit } from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { java } from "@codemirror/lang-java";
import { cpp } from "@codemirror/lang-cpp";
import { rust } from "@codemirror/lang-rust";
import { sql } from "@codemirror/lang-sql";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";

export default function WorkspaceCodeEditor(props: { path: string; language: string; value: string; disabled: boolean; onChange: (value: string) => void; onSave: () => void; onCutReady?: (cut: (() => Promise<boolean>) | undefined) => void; onSelectionChange?: (canCut: boolean) => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView>();
  const editable = useRef(new Compartment());
  const onChangeRef = useRef(props.onChange);
  const onSaveRef = useRef(props.onSave);
  onChangeRef.current = props.onChange;
  onSaveRef.current = props.onSave;
  const cutSelection = async (): Promise<boolean> => {
    const view = viewRef.current;
    const selection = view?.state.selection.main;
    if (!view || !selection || selection.empty) return false;
    try {
      await navigator.clipboard.writeText(view.state.sliceDoc(selection.from, selection.to));
    } catch {
      return false;
    }
    view.dispatch({ changes: { from: selection.from, to: selection.to } });
    return true;
  };
  useEffect(() => {
    if (!containerRef.current) return;
    const view = new EditorView({
      parent: containerRef.current,
      state: EditorState.create({
        doc: props.value,
        extensions: [
          basicSetup,
          EditorView.lineWrapping,
          indentUnit.of("  "),
          editorLanguage(props.language),
          editable.current.of(EditorView.editable.of(!props.disabled)),
          keymap.of([indentWithTab, { key: "Mod-s", preventDefault: true, run: () => { onSaveRef.current(); return true; } }]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString());
            if (update.selectionSet || update.focusChanged) props.onSelectionChange?.(!update.state.selection.main.empty);
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
    props.onCutReady?.(cutSelection);
    return () => { view.destroy(); viewRef.current = undefined; props.onCutReady?.(undefined); props.onSelectionChange?.(false); };
  }, [props.path, props.language]);
  useEffect(() => {
    viewRef.current?.dispatch({ effects: editable.current.reconfigure(EditorView.editable.of(!props.disabled)) });
  }, [props.disabled]);
  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === props.value) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: props.value } });
  }, [props.value]);
  return <div class="cli-code-editor" ref={containerRef} aria-label={`Edit ${props.path}`} />;
}

function editorLanguage(language: string): Extension {
  switch (language) {
    case "ts": case "typescript": return javascript({ typescript: true });
    case "tsx": case "typescriptreact": return javascript({ typescript: true, jsx: true });
    case "js": case "javascript": return javascript();
    case "jsx": case "javascriptreact": return javascript({ jsx: true });
    case "json": return json();
    case "css": case "scss": case "less": return css();
    case "html": case "htm": return html();
    case "md": case "markdown": return markdown();
    case "py": case "python": return python();
    case "java": return java();
    case "c": case "cc": case "cpp": case "cxx": case "h": case "hpp": return cpp();
    case "rs": case "rust": return rust();
    case "sql": return sql();
    case "xml": case "svg": return xml();
    case "yaml": case "yml": return yaml();
    default: return [];
  }
}

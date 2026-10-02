import { useEffect, useState, useSyncExternalStore } from 'react';
import { CodeMirrorEditor, type CodeBlockEditorDescriptor, type CodeBlockEditorProps } from '@mdxeditor/editor';
import { message } from './document-session';
import { pageTheme, subscribeTheme, type PageTheme } from './page-theme';

let renders = 0;
let mermaid: Promise<typeof import('mermaid').default> | undefined;
let initialized: PageTheme | undefined;

/** Renders `code` as SVG; mermaid loads on first use. Strict security escapes
 * labels and sanitizes the SVG before the page inserts it. */
async function renderDiagram(code: string, theme: PageTheme): Promise<string> {
  const api = await (mermaid ??= import('mermaid').then(m => m.default));
  if (initialized !== theme) {
    initialized = theme;
    // Mermaid 12 defaults to ELK layouts, which this bundle leaves out (scripts/build.mjs).
    api.initialize({ startOnLoad: false, securityLevel: 'strict', theme: theme.dark ? 'dark' : 'default', fontFamily: theme.fontFamily,
      layout: 'dagre', state: { layout: 'dagre' } });
  }
  await api.parse(code);
  const id = `mermaid-${++renders}`;
  try { return (await api.render(id, code)).svg; }
  finally { document.getElementById(id)?.remove(); document.getElementById(`d${id}`)?.remove(); }
}

function MermaidBlock(props: CodeBlockEditorProps) {
  const [editing, setEditing] = useState(false);
  const [diagram, setDiagram] = useState<{ svg?: string; error?: string }>({});
  const theme = useSyncExternalStore(subscribeTheme, pageTheme);
  useEffect(() => {
    let current = true;
    // Typing re-renders after a pause rather than per keystroke.
    const timer = setTimeout(() => {
      if (!props.code.trim()) { setDiagram({ error: 'Empty diagram' }); return; }
      renderDiagram(props.code, theme).then(
        svg => { if (current) setDiagram({ svg }); },
        error => { if (current) setDiagram({ error: message(error) }); });
    }, diagram.svg || diagram.error ? 300 : 0);
    return () => { current = false; clearTimeout(timer); };
  }, [props.code, theme]);
  return (
    <div className="mermaid-block">
      <div className="mermaid-bar">
        <span>Mermaid</span>
        <button type="button" aria-pressed={editing} onClick={() => setEditing(!editing)}>{editing ? 'Done' : 'Edit source'}</button>
      </div>
      {editing && <CodeMirrorEditor {...props} />}
      {diagram.error !== undefined
        ? <pre className="mermaid-error" role="status">{diagram.error}</pre>
        : <div className="mermaid-diagram" onDoubleClick={() => setEditing(true)} dangerouslySetInnerHTML={{ __html: diagram.svg ?? '' }} />}
    </div>
  );
}

/** Fenced `mermaid` blocks render as diagrams, with their source a toggle away. */
export const mermaidDescriptor: CodeBlockEditorDescriptor = {
  priority: 10,
  match: language => language === 'mermaid',
  Editor: MermaidBlock,
};

import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import 'monaco-editor/esm/vs/editor/editor.all.js';
import 'monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/python/python.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/rust/rust.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/go/go.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/java/java.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/shell/shell.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/powershell/powershell.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/sql/sql.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/xml/xml.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/css/css.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/ini/ini.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/dockerfile/dockerfile.contribution.js';
import { documentSession } from './document-session';
import './editor.css';

monaco.languages.register({ id: 'json', extensions: ['.json', '.jsonl'] });
monaco.languages.setMonarchTokensProvider('json', { tokenizer: { root: [
  [/"(?:[^"\\]|\\.)*"(?=\s*:)/, 'key'], [/"(?:[^"\\]|\\.)*"/, 'string'],
  [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, 'number'], [/\b(?:true|false|null)\b/, 'keyword'],
  [/[{}\[\]]/, '@brackets'], [/[,:]/, 'delimiter'],
] } });

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const saveButton = el<HTMLButtonElement>('save');
const error = el('error');
let editor: monaco.editor.IStandaloneCodeEditor;
let model: monaco.editor.ITextModel;
let appliedTheme = '';

(self as typeof self & { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker: () => new Worker(new URL('./editor.worker.js', import.meta.url), { type: 'module' }),
};

const session = documentSession<number>({
  snapshot() {
    model.pushStackElement(); // Further typing must be undoable back to this save.
    return { text: model.getValue(), mark: model.getAlternativeVersionId() };
  },
  holds: mark => model.getAlternativeVersionId() === mark,
  apply(text, name) {
    const language = monaco.languages.getLanguages().find(l => l.filenames?.includes(name)
      || l.extensions?.some(ext => name.toLowerCase().endsWith(ext)))?.id ?? 'plaintext';
    if (!model) {
      model = monaco.editor.createModel(text, language);
      editor = monaco.editor.create(el('editor'), { model, automaticLayout: true, theme: 'workbench',
        minimap: { enabled: false }, scrollBeyondLastLine: false, fontSize: 13, lineNumbersMinChars: 3,
        padding: { top: 10, bottom: 10 }, renderLineHighlight: 'gutter', overviewRulerLanes: 0,
        fixedOverflowWidgets: true, accessibilitySupport: 'auto' });
      // Reload reports once after establishing the replacement's saved revision.
      model.onDidChangeContent(event => { if (!event.isFlush) session.changed(); });
      editor.onDidChangeCursorPosition(({ position }) => {
        el('position').textContent = `Ln ${position.lineNumber}, Col ${position.column}`;
      });
    } else model.setValue(text);
    el('language').textContent = language === 'plaintext' ? 'Plain Text' : language;
    el('encoding').textContent = `UTF-8 · ${model.getEOL() === '\r\n' ? 'CRLF' : 'LF'}`;
    applyTheme();
  },
}, {
  report({ loaded, dirty, saving }) {
    saveButton.disabled = !loaded || !dirty || saving;
    el('state').textContent = !loaded ? 'Loading…' : saving ? 'Saving…' : dirty ? 'Unsaved' : 'Saved';
  },
  fail(text) {
    error.textContent = text ?? '';
    error.hidden = text === null;
  },
});
function applyTheme() {
  const css = getComputedStyle(document.body);
  const light = document.body.classList.contains('vscode-light') || document.body.classList.contains('vscode-high-contrast-light')
    || (![...document.body.classList].some(c => c.startsWith('vscode-')) && matchMedia('(prefers-color-scheme: light)').matches);
  const colors: Record<string, string> = {};
  for (const key of ['editor.background', 'editor.foreground', 'editor.selectionBackground', 'editorWidget.background',
    'editorLineNumber.foreground', 'editorCursor.foreground', 'focusBorder', 'input.background', 'input.foreground', 'input.border',
    'list.activeSelectionBackground', 'list.activeSelectionForeground', 'list.hoverBackground', 'list.hoverForeground',
    'button.background', 'button.foreground', 'scrollbarSlider.background', 'scrollbarSlider.hoverBackground']) {
    const value = css.getPropertyValue('--vscode-' + key.replaceAll('.', '-')).trim();
    if (/^#[\da-f]{3,8}$/i.test(value)) colors[key] = value;
  }
  const base = light ? 'vs' : 'vs-dark';
  const fontFamily = css.getPropertyValue('--vscode-editor-font-family').trim() || undefined;
  const fontSize = parseFloat(css.getPropertyValue('--vscode-editor-font-size')) || 13;
  // Load delivers the same theme several times; each defineTheme rebuilds Monaco's styles.
  const key = JSON.stringify([base, colors, fontFamily, fontSize, !!editor]);
  if (key === appliedTheme) return;
  appliedTheme = key;
  monaco.editor.defineTheme('workbench', { base, inherit: true, rules: [], colors });
  monaco.editor.setTheme('workbench');
  editor?.updateOptions({ fontFamily, fontSize });
}
saveButton.addEventListener('click', () => { void session.save(); });
el('reload').addEventListener('click', () => void session.reload(async () => {
  const dialog = el<HTMLDialogElement>('confirm');
  dialog.returnValue = 'cancel';
  const answer = new Promise<string>(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true }));
  dialog.showModal();
  return await answer === 'discard';
}));
el('wrap').addEventListener('click', () => {
  const on = el('wrap').getAttribute('aria-pressed') !== 'true';
  el('wrap').setAttribute('aria-pressed', String(on));
  editor?.updateOptions({ wordWrap: on ? 'on' : 'off' });
});
window.addEventListener('dormouse:theme', applyTheme);
applyTheme();
void session.load();

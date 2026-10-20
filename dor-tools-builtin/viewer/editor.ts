import * as monaco from 'monaco-editor/editor';
import 'monaco-editor/features/register.all';
import 'monaco-editor/languages/definitions/typescript/register';
import 'monaco-editor/languages/definitions/javascript/register';
import 'monaco-editor/languages/definitions/python/register';
import 'monaco-editor/languages/definitions/rust/register';
import 'monaco-editor/languages/definitions/go/register';
import 'monaco-editor/languages/definitions/java/register';
import 'monaco-editor/languages/definitions/cpp/register';
import 'monaco-editor/languages/definitions/shell/register';
import 'monaco-editor/languages/definitions/powershell/register';
import 'monaco-editor/languages/definitions/sql/register';
import 'monaco-editor/languages/definitions/yaml/register';
import 'monaco-editor/languages/definitions/xml/register';
import 'monaco-editor/languages/definitions/css/register';
import 'monaco-editor/languages/definitions/markdown/register';
import 'monaco-editor/languages/definitions/ini/register';
import 'monaco-editor/languages/definitions/dockerfile/register';
import { documentSession, stateLabel, textSource } from './document-session';
import { pageTheme } from './page-theme';
import { installTooltips } from './tooltip';
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
    return { content: model.getValue(), mark: model.getAlternativeVersionId() };
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
  report(state) {
    saveButton.setAttribute('aria-disabled', String(!state.dirty || state.saving));
    el('state').textContent = stateLabel(state);
  },
  fail(text) {
    error.textContent = text ?? '';
    error.hidden = text === null;
  },
}, textSource);
function applyTheme() {
  const css = getComputedStyle(document.body);
  const colors: Record<string, string> = {};
  for (const key of ['editor.background', 'editor.foreground', 'editor.selectionBackground', 'editorWidget.background',
    'editorLineNumber.foreground', 'editorCursor.foreground', 'focusBorder', 'input.background', 'input.foreground', 'input.border',
    'list.activeSelectionBackground', 'list.activeSelectionForeground', 'list.hoverBackground', 'list.hoverForeground',
    'button.background', 'button.foreground', 'scrollbarSlider.background', 'scrollbarSlider.hoverBackground']) {
    const value = css.getPropertyValue('--vscode-' + key.replaceAll('.', '-')).trim();
    if (/^#[\da-f]{3,8}$/i.test(value)) colors[key] = value;
  }
  const base = pageTheme().dark ? 'vs-dark' : 'vs';
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
el('reload').addEventListener('click', () => void session.reload());
el('wrap').addEventListener('click', () => {
  const on = el('wrap').getAttribute('aria-pressed') !== 'true';
  el('wrap').setAttribute('aria-pressed', String(on));
  editor?.updateOptions({ wordWrap: on ? 'on' : 'off' });
});
window.addEventListener('dormouse:theme', applyTheme);
applyTheme();
installTooltips();
void session.load();

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
import './editor.css';

monaco.languages.register({ id: 'json', extensions: ['.json', '.jsonl'] });
monaco.languages.setMonarchTokensProvider('json', { tokenizer: { root: [
  [/"(?:[^"\\]|\\.)*"(?=\s*:)/, 'key'], [/"(?:[^"\\]|\\.)*"/, 'string'],
  [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, 'number'], [/\b(?:true|false|null)\b/, 'keyword'],
  [/[{}\[\]]/, '@brackets'], [/[,:]/, 'delimiter'],
] } });

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const saveButton = el<HTMLButtonElement>('save');
const reloadButton = el<HTMLButtonElement>('reload');
const error = el('error');
const state = el('state');
let editor: monaco.editor.IStandaloneCodeEditor;
let model: monaco.editor.ITextModel;
let savedRevision = 0;
let version = '';
let saving: Promise<void> | null = null;
let parentOrigin: string | null = null;
let connection = '';
let lastDirty: boolean | undefined;
let stateQueue = Promise.resolve();
let appliedTheme = '';

(self as typeof self & { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker: () => new Worker(new URL('./editor.worker.js', import.meta.url), { type: 'module' }),
};

async function request(path: string, body?: unknown) {
  const response = await fetch(path, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await response.text() || `Request failed (${response.status})`);
  return response.json();
}
function fail(reason: unknown) {
  error.textContent = reason instanceof Error ? reason.message : String(reason);
  error.hidden = false;
}
function post(data: Record<string, unknown>) {
  if (parentOrigin) window.parent.postMessage({ __dormouse: 'editor', connection, ...data }, parentOrigin);
}
function dirty() { return !!model && model.getAlternativeVersionId() !== savedRevision; }
function report() {
  const changed = dirty();
  saveButton.disabled = !model || !changed || saving !== null;
  state.textContent = saving ? 'Saving…' : changed ? 'Unsaved' : 'Saved';
  // Post immediately so the preview is pinned before a second selection can
  // replace it. The ordered OSC reports also cover automated browser renders.
  post({ kind: 'state', dirty: changed });
  if (changed !== lastDirty) {
    lastDirty = changed;
    stateQueue = stateQueue.then(() => request('state', { dirty: changed })).then(() => {}, fail);
  }
}
async function save() {
  if (saving) return saving;
  if (!dirty()) return;
  model.pushStackElement(); // Further typing must be undoable back to this save.
  const text = model.getValue();
  const revision = model.getAlternativeVersionId();
  error.hidden = true;
  saving = request('save', { text, version }).then(result => {
    version = result.version;
    savedRevision = revision; // Undo restores this revision; newer edits stay dirty.
  }).finally(() => { saving = null; report(); });
  report();
  return saving;
}
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
async function load() {
  const source = await request('source');
  version = source.version;
  const language = monaco.languages.getLanguages().find(l => l.filenames?.includes(source.name)
    || l.extensions?.some(ext => source.name.toLowerCase().endsWith(ext)))?.id ?? 'plaintext';
  if (!model) {
    model = monaco.editor.createModel(source.text, language);
    editor = monaco.editor.create(el('editor'), { model, automaticLayout: true, theme: 'workbench',
      minimap: { enabled: false }, scrollBeyondLastLine: false, fontSize: 13, lineNumbersMinChars: 3,
      padding: { top: 10, bottom: 10 }, renderLineHighlight: 'gutter', overviewRulerLanes: 0,
      fixedOverflowWidgets: true, accessibilitySupport: 'auto' });
    model.onDidChangeContent(report);
    editor.onDidChangeCursorPosition(({ position }) => {
      el('position').textContent = `Ln ${position.lineNumber}, Col ${position.column}`;
    });
  } else model.setValue(source.text);
  el('language').textContent = language === 'plaintext' ? 'Plain Text' : language;
  el('encoding').textContent = `UTF-8 · ${model.getEOL() === '\r\n' ? 'CRLF' : 'LF'}`;
  savedRevision = model.getAlternativeVersionId();
  applyTheme();
  report();
  post({ kind: 'ready', dirty: dirty() });
}
saveButton.addEventListener('click', () => { void save().catch(fail); });
// Capture phase: runs before Monaco, and outside it too.
window.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
    event.preventDefault(); void save().catch(fail);
  }
}, true);
reloadButton.addEventListener('click', async () => {
  if (saving) return;
  if (dirty()) {
    const dialog = el<HTMLDialogElement>('confirm');
    dialog.returnValue = 'cancel';
    const answer = new Promise<string>(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true }));
    dialog.showModal();
    if (await answer !== 'discard') return;
  }
  error.hidden = true;
  void load().catch(fail);
});
el('wrap').addEventListener('click', () => {
  const on = el('wrap').getAttribute('aria-pressed') !== 'true';
  el('wrap').setAttribute('aria-pressed', String(on));
  editor?.updateOptions({ wordWrap: on ? 'on' : 'off' });
});
window.addEventListener('dormouse:theme', applyTheme);
window.addEventListener('message', event => {
  const data = event.data;
  if (event.source !== window.parent || !data || data.__dormouse !== 'editor-command') return;
  if (data.kind === 'connect' && typeof data.connection === 'string') {
    parentOrigin = event.origin;
    connection = data.connection;
    if (model) post({ kind: 'ready', dirty: dirty() });
    return;
  }
  if (event.origin !== parentOrigin || data.connection !== connection || !model) return;
  if (data.kind === 'save' && typeof data.request === 'string') {
    void save().then(() => post({ kind: 'saved', request: data.request, dirty: dirty() }), reason => {
      fail(reason); post({ kind: 'saved', request: data.request, error: String(reason), dirty: dirty() });
    });
  }
});
window.addEventListener('beforeunload', event => {
  if (window.parent === window && dirty()) { event.preventDefault(); event.returnValue = ''; }
});
applyTheme();
void load().catch(fail);

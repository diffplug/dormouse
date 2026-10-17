/** The standalone image page (`dor open shot.png`): the editor over one PNG or
 * JPEG file, saved over it as the page's document
 * (docs/specs/dor-tools-builtin.md -> Image editor). */
import { createRef, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { documentPage, loadingState, stateLabel, type DocumentState } from '../document-session';
import { SaveButton } from '../save-button';
import { Signal } from '../signal';
import { editorDocument, ImageDocument, type ImageEditorHandle } from './editor';
import { imageSource, type ImageLoad } from './io';
import { installTooltips } from '../tooltip';
import './page.css';

let store: { doc: DocumentState; error: string | null } = { doc: loadingState, error: null };
const changes = new Signal();
const update = (change: Partial<typeof store>) => { store = { ...store, ...change }; changes.emit(); };
const useStore = <T,>(read: (s: typeof store) => T) => useSyncExternalStore(changes.subscribe, () => read(store));
const editor = createRef<ImageEditorHandle>();
let loads = 0;

// A reload mounts a fresh editor, so undo starts over.
const session = documentPage().open(editorDocument(editor, (load, name) => {
  const key = ++loads;
  root.render(<Page key={key} load={load} name={name} src={`source?v=${key}`} />);
}), {
  report(doc) { update({ doc }); },
  fail(error) { update({ error }); },
}, imageSource('source', 'save', document.title));

function Controls() {
  const doc = useStore(s => s.doc);
  return (
    <>
      <span className="page-state ie-optional" role="status">{stateLabel(doc)}</span>
      <button type="button" data-tip="Reload from disk" onClick={() => void session.reload()}>Reload</button>
      <SaveButton state={doc} onSave={() => void session.save()} />
    </>
  );
}

function Page({ load, name, src }: { load: ImageLoad; name: string; src: string }) {
  const error = useStore(s => s.error);
  return <ImageDocument ref={editor} load={load} src={src} name={name} error={error} onChange={session.changed} controls={<Controls />} />;
}

/** Before the first load lands: its progress, or why it failed. */
function Pending() {
  const error = useStore(s => s.error);
  return error ? <div className="page-error" role="alert">{error}</div> : <div className="page-state page-pending">Loading…</div>;
}

installTooltips();
const root = createRoot(document.getElementById('root')!);
root.render(<Pending />);
void session.load();

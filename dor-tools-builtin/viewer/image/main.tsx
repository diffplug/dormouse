/** The standalone image page (`dor open shot.png`): the editor over one PNG or
 * JPEG file, saved over it as the page's document
 * (docs/specs/dor-tools-builtin.md -> Image editor). */
import { createRef, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { documentPage, loadingState, stateLabel, type DocumentState } from '../document-session';
import { SaveButton } from '../save-button';
import { Signal } from '../signal';
import { editorDocument, ImageEditor, type ImageEditorHandle } from './editor';
import { imageSource, type LoadedImage } from './io';
import './page.css';

let store: { doc: DocumentState; error: string | null } = { doc: loadingState, error: null };
const changes = new Signal();
const update = (change: Partial<typeof store>) => { store = { ...store, ...change }; changes.emit(); };
const useStore = <T,>(read: (s: typeof store) => T) => useSyncExternalStore(changes.subscribe, () => read(store));
const editor = createRef<ImageEditorHandle>();
let loads = 0;

// A reload mounts a fresh editor, so undo starts over.
const session = documentPage().open(editorDocument(editor, (image, name) => root.render(<Page key={++loads} image={image} name={name} />)), {
  report(doc) { update({ doc }); },
  fail(error) { update({ error }); },
}, imageSource('source', 'save', document.title));

function Controls() {
  const doc = useStore(s => s.doc);
  return (
    <>
      <span className="page-state" role="status">{stateLabel(doc)}</span>
      <button type="button" title="Reload from disk" onClick={() => void session.reload()}>Reload</button>
      <SaveButton state={doc} onSave={() => void session.save()} />
    </>
  );
}

function Page({ image, name }: { image: LoadedImage; name: string }) {
  const error = useStore(s => s.error);
  return <ImageEditor ref={editor} image={image} name={name} error={error} onChange={session.changed} controls={<Controls />} />;
}

/** Before the first load lands: its progress, or why it failed. */
function Pending() {
  const error = useStore(s => s.error);
  return error ? <div className="page-error" role="alert">{error}</div> : <div className="page-state page-pending">Loading…</div>;
}

const root = createRoot(document.getElementById('root')!);
root.render(<Pending />);
void session.load();

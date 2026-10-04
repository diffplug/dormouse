/** The standalone image page (`dor open shot.png`): the editor over one PNG or
 * JPEG file, saved over it as the page's document
 * (docs/specs/dor-tools-builtin.md -> Image editor). */
import { createRef, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { documentPage, sameState, stateLabel, type DocumentState } from '../document-session';
import { editorDocument, ImageEditor, type ImageEditorHandle } from './editor';
import { imageSource, type LoadedImage } from './io';
import './page.css';

let store: { doc: DocumentState; error: string | null } = { doc: { loaded: false, dirty: false, saving: false }, error: null };
const listeners = new Set<() => void>();
const update = (change: Partial<typeof store>) => { store = { ...store, ...change }; for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const usePage = () => useSyncExternalStore(subscribe, () => store);
const editor = createRef<ImageEditorHandle>();
let loads = 0;

// A reload mounts a fresh editor, so undo starts over.
const session = documentPage().open(editorDocument(editor, (image, name) => flushSync(() => root.render(<Page key={++loads} image={image} name={name} />))), {
  report(doc) {
    if (!sameState(doc, store.doc)) update({ doc });
  },
  fail(error) { update({ error }); },
}, imageSource('source', 'save', document.title));

function Controls() {
  const { doc } = usePage();
  return (
    <>
      <span className="page-state" role="status">{stateLabel(doc)}</span>
      <button type="button" title="Reload from disk" onClick={() => void session.reload()}>Reload</button>
      <button type="button" className="ie-save" disabled={!doc.loaded || !doc.dirty || doc.saving} title="Save [Cmd/Ctrl+S]" onClick={() => void session.save()}>Save</button>
    </>
  );
}

function Page({ image, name }: { image: LoadedImage; name: string }) {
  const { error } = usePage();
  return <ImageEditor ref={editor} image={image.raster} mime={image.mime} name={name} error={error} onChange={session.changed} controls={<Controls />} />;
}

/** Before the first load lands: its progress, or why it failed. */
function Pending() {
  const { error } = usePage();
  return error ? <div className="page-error" role="alert">{error}</div> : <div className="page-state page-pending">Loading…</div>;
}

const root = createRoot(document.getElementById('root')!);
root.render(<Pending />);
void session.load();

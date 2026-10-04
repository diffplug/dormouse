/** The standalone image page (`dor open shot.png`): the editor over one PNG or
 * JPEG file, saved over it through the shared document session
 * (docs/specs/dor-tools-builtin.md -> Image editor). */
import { createRef, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { documentSession, stateLabel, type DocumentState } from '../document-session';
import { ImageEditor, type ImageEditorHandle, type Revision } from './editor';
import { decodeImage, fetchImage, saveImage, type EditableMime } from './io';
import type { Raster } from './pixels';
import './page.css';

let store: { doc: DocumentState; error: string | null } = { doc: { loaded: false, dirty: false, saving: false }, error: null };
const listeners = new Set<() => void>();
const update = (change: Partial<typeof store>) => { store = { ...store, ...change }; for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const usePage = () => useSyncExternalStore(subscribe, () => store);
const editor = createRef<ImageEditorHandle>();
let loads = 0;

const session = documentSession<Revision | null, Blob>({
  snapshot() {
    const { content, mark } = editor.current!.snapshot();
    return { content, mark };
  },
  mark: () => editor.current?.revision() ?? null,
  holds: mark => !!mark && !!editor.current?.holds(mark),
  async apply(blob, name) {
    const image = await decodeImage(blob);
    const mime: EditableMime = blob.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    // A reload mounts a fresh editor, so undo starts over.
    flushSync(() => root.render(<Page key={++loads} image={image} name={name} mime={mime} />));
  },
}, {
  report(doc) {
    if (doc.loaded !== store.doc.loaded || doc.dirty !== store.doc.dirty || doc.saving !== store.doc.saving) update({ doc });
  },
  fail(error) { update({ error }); },
}, {
  async load() {
    const { blob, version } = await fetchImage('source');
    return { content: blob, version, name: document.title };
  },
  save: (blob, version) => saveImage('save', blob, version),
});

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

function Page(props: { image: Raster; name: string; mime: EditableMime }) {
  const { error } = usePage();
  return (
    <>
      {error && <div className="page-error" role="alert">{error}</div>}
      <ImageEditor ref={editor} {...props} onChange={session.changed} controls={<Controls />} />
    </>
  );
}

/** Before the first load lands: its progress, or why it failed. */
function Pending() {
  const { error } = usePage();
  return error ? <div className="page-error" role="alert">{error}</div> : <div className="page-state page-pending">Loading…</div>;
}

const root = createRoot(document.getElementById('root')!);
root.render(<Pending />);
void session.load();

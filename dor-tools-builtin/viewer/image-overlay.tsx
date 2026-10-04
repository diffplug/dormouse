/** The image editor over the whole Markdown page, editing one PNG or JPEG at
 * or under the document's folder in place (docs/specs/dor-tools-builtin.md ->
 * Markdown editor). While open, it is the page's front document. */
import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { confirmDiscard, loadingState, type DocumentPage, type DocumentState, type OpenDocument } from './document-session';
import { editorDocument, ImageDocument, type ImageEditorHandle } from './image/editor';
import { Icon } from './image/icons';
import { imageSource, type ImageLoad } from './image/io';
import { EDIT_ROUTE, IMAGE_SAVE_ROUTE, IMAGES_ROUTE } from '../src/image-format';
import { pathRoute } from './images-panel';
import { SaveButton } from './save-button';
import { Signal } from './signal';

/** The image document's state, outside the overlay's React state: its Save
 * re-renders alone, not the editor. */
class SaveState extends Signal {
  state = loadingState;
  get = () => this.state;
  set(state: DocumentState) { this.state = state; this.emit(); }
}

export function ImageOverlay({ path, page, onSaved, onClose }: {
  /** The image, as `localImagePath` spells it. */
  path: string;
  page: DocumentPage;
  /** After the file on disk changes, with its new revision. */
  onSaved(path: string, version: string): void;
  onClose(): void;
}) {
  const name = path.slice(path.lastIndexOf('/') + 1);
  /** The file as last loaded, keyed so each load mounts a fresh editor. */
  const [shown, setShown] = useState<{ load: ImageLoad; key: number } | null>(null);
  const [saveState] = useState(() => new SaveState());
  const [error, setError] = useState<string | null>(null);
  const editor = useRef<ImageEditorHandle>(null);
  const confirm = useRef<HTMLDialogElement>(null);
  const doc = useRef<OpenDocument>(null);

  useEffect(() => {
    const route = pathRoute(path), source = imageSource(EDIT_ROUTE + route, IMAGE_SAVE_ROUTE + route, name);
    const show = (load: ImageLoad) => setShown(was => ({ load, key: (was?.key ?? 0) + 1 }));
    const opened = page.open(editorDocument(editor, show), { report: state => saveState.set(state), fail: setError }, {
      ...source,
      async save(blob, version) {
        const saved = await source.save(blob, version);
        onSaved(path, saved.version);
        return saved;
      },
    });
    doc.current = opened;
    void opened.load();
    return () => { doc.current = null; opened.close(); };
  }, [page, path, name, onSaved, saveState]);

  async function close() {
    if (doc.current?.dirty() && !await confirmDiscard(confirm.current!)) return;
    onClose();
  }
  function onKeyDown(event: KeyboardEvent) {
    // Esc the editor leaves, outside the discard prompt (which handles its own).
    if (event.key !== 'Escape' || event.defaultPrevented || confirm.current?.open) return;
    event.preventDefault();
    void close();
  }

  return (
    <div className="image-overlay" role="dialog" aria-modal="true" aria-label={`Edit ${name}`} onKeyDown={onKeyDown}>
      {shown
        ? <ImageDocument key={shown.key} ref={editor} load={shown.load} src={`${IMAGES_ROUTE}${pathRoute(path)}?v=${shown.key}`} name={name} error={error}
            onChange={() => doc.current?.changed()}
            controls={<>
              <span className="image-overlay-name ie-optional" title={path}>{name}</span>
              {'edit' in shown.load && <OverlaySave saveState={saveState} onSave={() => void doc.current?.save()} />}
              <button type="button" className="ie-icon" aria-label="Close" title="Close [Esc]" onClick={() => void close()}><Icon name="close" /></button>
            </>} />
        : <div className="image-overlay-pending">
            {error ? <span className="error" role="alert">{error}</span> : <span className="state">Loading {name}…</span>}
            <button type="button" autoFocus onClick={onClose}>Close</button>
          </div>}
      <dialog ref={confirm}>
        <form method="dialog">
          <h2>Discard image edits?</h2>
          <p>Closing the image editor loses your unsaved changes to {name}.</p>
          <div><button value="cancel">Keep editing</button><button value="discard">Discard</button></div>
        </form>
      </dialog>
    </div>
  );
}

function OverlaySave({ saveState, onSave }: { saveState: SaveState; onSave(): void }) {
  return <SaveButton state={useSyncExternalStore(saveState.subscribe, saveState.get)} onSave={onSave} />;
}

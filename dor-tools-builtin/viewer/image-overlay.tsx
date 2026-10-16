/** The image editor over the whole Markdown page, editing one PNG or JPEG at
 * or under the document's folder in place (docs/specs/dor-tools-builtin.md ->
 * Markdown editor). While open, it is the page's front document. */
import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { confirmDiscard, loadingState, type DocumentPage, type DocumentState, type OpenDocument } from './document-session';
import { editorDocument, ImageDocument, type ImageEditorHandle } from './image/editor';
import { Icon } from './image/icons';
import { imageSource, type ImageLoad } from './image/io';
import { jpegSize, pngSize } from '../src/image-editability';
import { EDIT_ROUTE, IMAGE_SAVE_ROUTE, IMAGES_ROUTE } from '../src/image-format';
import { pathRoute } from './images-panel';
import { SaveButton } from './save-button';
import { Signal } from './signal';
import type { Size } from './tip-layout';

/** How a save changed an image's upright pixel size. */
export interface Resize { from: Size; to: Size }

/** The pixel size of a PNG or JPEG the editor saved, upright as it writes them. */
async function savedSize(blob: Blob): Promise<Size | null> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return pngSize(bytes) ?? jpegSize(bytes);
}

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
  /** After the file on disk changes, with its new revision, and how its pixel size changed, if it did. */
  onSaved(path: string, version: string, resize: Resize | null): void;
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
  /** The pixel size of the file on disk, as last loaded or saved here. */
  const size = useRef<Size | null>(null);

  useEffect(() => {
    const route = pathRoute(path), source = imageSource(EDIT_ROUTE + route, IMAGE_SAVE_ROUTE + route, name);
    const show = (load: ImageLoad) => {
      size.current = 'edit' in load ? { width: load.edit.raster.width, height: load.edit.raster.height } : null;
      setShown(was => ({ load, key: (was?.key ?? 0) + 1 }));
    };
    const opened = page.open(editorDocument(editor, show), { report: state => saveState.set(state), fail: setError }, {
      ...source,
      async save(blob, version) {
        const [saved, to] = await Promise.all([source.save(blob, version), savedSize(blob)]);
        const from = size.current;
        size.current = to;
        const resized = from && to && (from.width !== to.width || from.height !== to.height);
        onSaved(path, saved.version, resized ? { from, to } : null);
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
              <span className="image-overlay-name ie-optional" data-tip-text={path}>{name}</span>
              {'edit' in shown.load && <OverlaySave saveState={saveState} onSave={() => void doc.current?.save()} />}
              <button type="button" className="ie-icon" aria-label="Close" data-tip="Close [Esc]" onClick={() => void close()}><Icon name="close" /></button>
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

/** The image editor over the whole Markdown page, editing one PNG or JPEG at
 * or under the document's folder in place (docs/specs/dor-tools-builtin.md ->
 * Markdown editor). While open, it is the page's front document. */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { flushSync } from 'react-dom';
import { confirmDiscard, sameState, type DocumentPage, type DocumentState, type OpenDocument } from './document-session';
import { editorDocument, ImageEditor, type ImageEditorHandle } from './image/editor';
import { Icon } from './image/icons';
import { imageSource, type LoadedImage } from './image/io';
import { EDIT_ROUTE, IMAGE_SAVE_ROUTE } from '../src/image-format';
import { pathRoute } from './images-panel';

export function ImageOverlay({ path, page, onSaved, onClose }: {
  /** The image, as `localImagePath` spells it. */
  path: string;
  page: DocumentPage;
  /** After the file on disk changes, with its new revision. */
  onSaved(path: string, version: string): void;
  onClose(): void;
}) {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const [image, setImage] = useState<LoadedImage | null>(null);
  const [state, setState] = useState<DocumentState>({ loaded: false, dirty: false, saving: false });
  const [error, setError] = useState<string | null>(null);
  const editor = useRef<ImageEditorHandle>(null);
  const confirm = useRef<HTMLDialogElement>(null);
  const doc = useRef<OpenDocument>(null);

  useEffect(() => {
    const route = pathRoute(path), source = imageSource(EDIT_ROUTE + route, IMAGE_SAVE_ROUTE + route, name);
    const opened = page.open(editorDocument(editor, loaded => flushSync(() => setImage(loaded))), { report: next => setState(prev => sameState(prev, next) ? prev : next), fail: setError }, {
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
  }, [page, path, name, onSaved]);

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
      {image
        ? <ImageEditor ref={editor} image={image.raster} mime={image.mime} name={name} error={error} onChange={() => doc.current?.changed()}
            controls={<>
              <span className="image-overlay-name" title={path}>{name}</span>
              <button type="button" className="ie-save" disabled={!state.dirty || state.saving} title="Save [Cmd/Ctrl+S]" onClick={() => void doc.current?.save()}>{state.saving ? 'Saving…' : 'Save'}</button>
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

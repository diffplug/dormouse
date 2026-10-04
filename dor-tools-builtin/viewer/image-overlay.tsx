/** The image editor over the whole Markdown page, editing one PNG or JPEG at
 * or under the document's folder in place (docs/specs/dor-tools-builtin.md ->
 * Markdown editor). It is the session's front document while open. */
import { useEffect, useRef, useState } from 'react';
import { confirmDiscard, message, type FrontDocument } from './document-session';
import { ImageEditor, type ImageEditorHandle } from './image/editor';
import { decodeImage, fetchImage, saveImage, type EditableMime } from './image/io';
import type { Raster } from './image/pixels';

export function ImageOverlay({ path, session, onSaved, onClose }: {
  /** The image, as `localImagePath` spells it. */
  path: string;
  session: { front(document: FrontDocument | null): void; changed(): void };
  /** After the file on disk changes. */
  onSaved(path: string): void;
  onClose(): void;
}) {
  const route = path.split('/').map(encodeURIComponent).join('/');
  const name = path.slice(path.lastIndexOf('/') + 1);
  const [image, setImage] = useState<{ raster: Raster; mime: EditableMime } | { error: string } | null>(null);
  const editor = useRef<ImageEditorHandle>(null);
  const confirm = useRef<HTMLDialogElement>(null);
  const version = useRef('');
  const dirty = useRef(false);
  const failure = useRef<unknown>(null);

  useEffect(() => {
    let live = true;
    fetchImage(`edit/${route}`).then(async ({ blob, version: current }) => {
      const raster = await decodeImage(blob);
      if (!live) return;
      version.current = current;
      setImage({ raster, mime: blob.type === 'image/jpeg' ? 'image/jpeg' : 'image/png' });
    }).catch(reason => { if (live) setImage({ error: message(reason) }); });
    return () => { live = false; };
  }, [route]);

  useEffect(() => {
    session.front({
      dirty: () => dirty.current,
      async save() {
        // The editor shows a failed save itself; the host's close prompt needs it thrown.
        failure.current = null;
        await editor.current?.save();
        if (failure.current) throw failure.current;
      },
    });
    return () => { dirty.current = false; session.front(null); };
  }, [session]);

  async function save(blob: Blob) {
    try {
      version.current = (await saveImage(`image-save/${route}`, blob, version.current)).version;
    } catch (reason) { failure.current = reason; throw reason; }
    onSaved(path);
  }

  async function close() {
    if (dirty.current && !await confirmDiscard(confirm.current!)) return;
    onClose();
  }

  return (
    <div className="image-overlay" role="dialog" aria-modal="true" aria-label={`Edit ${name}`}
      onKeyDown={event => { if (event.key === 'Escape' && !(image && 'raster' in image)) { event.preventDefault(); onClose(); } }}>
      {image && 'raster' in image
        ? <ImageEditor ref={editor} image={image.raster} name={name} mime={image.mime} onSave={save} onClose={() => void close()}
            onDirty={value => { dirty.current = value; session.changed(); }}
            controls={<span className="image-overlay-name" title={path}>{name}</span>} />
        : <div className="image-overlay-pending">
            {image ? <span className="error" role="alert">{image.error}</span> : <span className="state">Loading {name}…</span>}
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

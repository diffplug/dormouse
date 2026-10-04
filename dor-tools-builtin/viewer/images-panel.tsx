import { useState } from 'react';
import { $getRoot, $isElementNode, type LexicalEditor, type LexicalNode } from 'lexical';
import { $isImageNode, type ImageNode } from '@mdxeditor/editor';
import { editableImageType, IMAGES_ROUTE } from '../src/image-format';
import { message, request } from './document-session';

/** A relative image `src` as the `/`-separated path the viewer serves under
 * `file/`, or null for a URL, an absolute path, or one leaving the document's folder. */
export function localImagePath(src: string): string | null {
  if (/^[a-z][a-z\d+.-]*:/i.test(src) || src.startsWith('/') || src.startsWith('\\')) return null;
  let path: string;
  try { path = decodeURIComponent(src.split(/[?#]/, 1)[0]); } catch { return null; }
  const parts = path.split('/').filter(part => part !== '.');
  return parts.length && !parts.some(part => part === '..' || part === '') ? parts.join('/') : null;
}

/** Whether the image editor can open `path`, a `localImagePath`: PNG and JPEG. */
export const editableImage = (path: string | null): path is string => !!path && !!editableImageType(path);

/** `path`, a `localImagePath`, as it is spelled after a viewer route. */
export const pathRoute = (path: string) => path.split('/').map(encodeURIComponent).join('/');

/** The revision each local image was saved at from this page, by `localImagePath`. */
export type SavedImages = Readonly<Record<string, string>>;

/** The URL the page loads a document image from. One saved here carries its
 * revision, so every display loads the new pixels; the server ignores the query. */
export const imageUrl = (src: string, saved: SavedImages) => {
  const path = localImagePath(src);
  if (path === null) return src;
  const version = Object.hasOwn(saved, path) ? saved[path] : undefined;
  return `${IMAGES_ROUTE}${pathRoute(path)}${version ? `?v=${encodeURIComponent(version)}` : ''}`;
};

/** The document's image nodes; call within a read or update. */
function $imageNodes(): ImageNode[] {
  const found: ImageNode[] = [];
  const visit = (node: LexicalNode) => {
    if ($isImageNode(node)) found.push(node);
    else if ($isElementNode(node)) node.getChildren().forEach(visit);
  };
  visit($getRoot());
  return found;
}

/** The distinct image sources in the document, in order. */
export const imageSources = (editor: LexicalEditor) =>
  [...new Set(editor.getEditorState().read(() => $imageNodes().map(node => node.getSrc())))];

/** `src` with its file name replaced, keeping its folder and spelling style. */
function renamedSource(src: string, name: string): string {
  const base = src.split(/[?#]/, 1)[0];
  const folder = base.slice(0, base.lastIndexOf('/') + 1);
  return folder + (/%[\da-f]{2}/i.test(base.slice(folder.length)) ? encodeURIComponent(name) : name);
}

function ImageRow({ src, editor, saved, onEdit }: { src: string; editor: LexicalEditor; saved: SavedImages; onEdit(path: string): void }) {
  const path = localImagePath(src);
  const name = path?.split('/').pop() ?? src;
  const folder = path?.slice(0, -name.length) ?? '';
  const [draft, setDraft] = useState(name);
  const [state, setState] = useState<{ busy?: boolean; error?: string }>({});
  async function commit() {
    const next = draft.trim();
    if (!path || !next || next === name || state.busy) { setDraft(name); return; }
    setState({ busy: true });
    try {
      await request('rename', { from: path, to: folder + next });
      const replacement = renamedSource(src, next);
      editor.update(() => { for (const node of $imageNodes()) if (node.getSrc() === src) node.setSrc(replacement); });
      setState({});
    } catch (error) { setState({ error: message(error) }); }
  }
  return (
    <li>
      <img src={imageUrl(src, saved)} alt="" loading="lazy" />
      {path === null
        ? <span className="image-name" title={src}>{src}</span>
        : <input className="image-name" value={draft} disabled={state.busy} aria-label={`Rename ${name}`} spellCheck={false}
            onChange={event => { setDraft(event.target.value); setState({}); }}
            onBlur={() => void commit()}
            onKeyDown={event => {
              if (event.key === 'Enter') { event.preventDefault(); void commit(); }
              if (event.key === 'Escape') { event.preventDefault(); setDraft(name); setState({}); }
            }} />}
      {editableImage(path) && <button type="button" className="image-edit" title={`Edit ${name}`} onClick={() => onEdit(path)}>Edit</button>}
      {folder && <span className="image-folder" title={path!}>{folder}</span>}
      {state.error && <span className="image-error" role="alert">{state.error}</span>}
    </li>
  );
}

/** Every image the document shows; local ones rename on disk at once, and
 * their links in the document change with the next save. PNG and JPEG open
 * in the image editor through `onEdit`. */
export function ImagesPanel({ editor, sources, saved, onEdit, top }: { editor: LexicalEditor; sources: string[]; saved: SavedImages; onEdit(path: string): void; top?: number }) {
  return (
    <section className="images-panel" aria-label="Images" style={{ top }}>
      {sources.length
        ? <ul>{sources.map(src => <ImageRow key={src} src={src} editor={editor} saved={saved} onEdit={onEdit} />)}</ul>
        : <p>No images. Paste one to save it beside this file.</p>}
      <p className="hint">Renaming moves the file now; save to keep this document's links.</p>
    </section>
  );
}

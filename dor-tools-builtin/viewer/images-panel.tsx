import { useState } from 'react';
import { $getRoot, $isElementNode, getNearestEditorFromDOMNode, type LexicalEditor, type LexicalNode } from 'lexical';
import { $isImageNode, $isTableNode, ImageNode, NESTED_EDITOR_UPDATED_COMMAND, type TableNode } from '@mdxeditor/editor';
import { editableImageType } from '../src/file-viewer-format';
import { IMAGES_ROUTE } from '../src/image-format';
import { message, request } from './document-session';

/** A relative image `src` as the `/`-separated path, relative to the document's
 * folder, that the `images/`, `edit/`, and `image-save/` routes take, or null
 * for a URL, an absolute path, or one leaving the document's folder. */
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

/** The editors MDXEditor nests in `element`, an editor's root or a table's:
 * one per table cell. */
const nestedEditors = (element: HTMLElement | null): LexicalEditor[] =>
  Array.from(element?.querySelectorAll('[data-lexical-editor]') ?? []).flatMap(cell => {
    const editor = getNearestEditorFromDOMNode(cell);
    return editor?.getRootElement() === cell ? [editor] : [];
  });

/** The image and table nodes of the editor whose state is being read or
 * updated, in order; an image in a table is in its cell's own editor. */
function $imagesAndTables(): (ImageNode | TableNode)[] {
  const found: (ImageNode | TableNode)[] = [];
  const visit = (node: LexicalNode) => {
    if ($isImageNode(node) || $isTableNode(node)) found.push(node);
    else if ($isElementNode(node)) node.getChildren().forEach(visit);
  };
  visit($getRoot());
  return found;
}

/** Applies `change` to every image node of the document `root` edits, its
 * table cells' included, in discrete updates: a cell's change reaches the
 * document's Markdown before this returns (`handOffImageEdits`). */
export function updateImages(root: LexicalEditor, change: (node: ImageNode) => void): void {
  for (const editor of [root, ...nestedEditors(root.getRootElement())]) {
    editor.update(() => {
      for (const node of $imagesAndTables()) if ($isImageNode(node)) change(node);
    }, { discrete: true });
  }
}

/** Hands table cell `editor`'s contents to its table whenever its image node
 * `key` changes or goes (a resize, a rename or rescale, MDXEditor's image
 * dialog or delete), as the cell otherwise does only when it loses focus, so
 * the document's Markdown has the change at once: within a discrete update's
 * commit. Returns what stops it. */
export function handOffImageEdits(editor: LexicalEditor, key: string): () => void {
  return editor.registerMutationListener(ImageNode, mutations => {
    if (mutations.has(key)) editor.dispatchCommand(NESTED_EDITOR_UPDATED_COMMAND, undefined);
  }, { skipInitialization: true });
}

/** The distinct image sources in the document `root` edits, its table cells'
 * included, in order. */
export function imageSources(root: LexicalEditor): string[] {
  const found = new Set<string>();
  const read = (editor: LexicalEditor) => editor.getEditorState().read(() => {
    for (const node of $imagesAndTables()) {
      if ($isImageNode(node)) found.add(node.getSrc());
      else nestedEditors(editor.getElementByKey(node.getKey())).forEach(read);
    }
  });
  read(root);
  return [...found];
}

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
      updateImages(editor, node => { if (node.getSrc() === src) node.setSrc(replacement); });
      setState({});
    } catch (error) { setState({ error: message(error) }); }
  }
  return (
    <li>
      <img src={imageUrl(src, saved)} alt="" loading="lazy" />
      {path === null
        ? <span className="image-name" data-tip-text={src}>{src}</span>
        : <input className="image-name" value={draft} disabled={state.busy} aria-label={`Rename ${name}`} spellCheck={false}
            onChange={event => { setDraft(event.target.value); setState({}); }}
            onBlur={() => void commit()}
            onKeyDown={event => {
              if (event.key === 'Enter') { event.preventDefault(); void commit(); }
              if (event.key === 'Escape') { event.preventDefault(); setDraft(name); setState({}); }
            }} />}
      {editableImage(path) && <button type="button" className="image-edit" data-tip-text={`Edit ${name}`} onClick={() => onEdit(path)}>Edit</button>}
      {folder && <span className="image-folder" data-tip-text={path!}>{folder}</span>}
      {state.error && <span className="image-error" role="alert">{state.error}</span>}
    </li>
  );
}

/** Every image the document shows; local ones rename on disk at once, and
 * their links in the document change with the next save. PNG and JPEG open
 * in the image editor through `onEdit`. */
export function ImagesPanel({ editor, sources, saved, onEdit }: { editor: LexicalEditor; sources: string[]; saved: SavedImages; onEdit(path: string): void }) {
  return (
    <section className="images-panel" aria-label="Images">
      {sources.length
        ? <ul>{sources.map(src => <ImageRow key={src} src={src} editor={editor} saved={saved} onEdit={onEdit} />)}</ul>
        : <p>No images. Paste one to save it beside this file.</p>}
      <p className="hint">Renaming moves the file now; save to keep this document's links.</p>
    </section>
  );
}

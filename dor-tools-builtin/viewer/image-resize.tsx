/** Corner handles that resize an image in the Markdown editor
 * (docs/specs/dor-tools-builtin.md -> Markdown editor), drawn by its image
 * toolbar inside MDXEditor's image wrapper while the image is selected. A drag
 * keeps the image's aspect from the size it shows at, within the column, and
 * its release saves a width, and a height only when the document gave one, as
 * one undo step, when the width changed. Esc cancels it. */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { $getNodeByKey, $getSelection, $isNodeSelection, getNearestEditorFromDOMNode, type LexicalEditor } from 'lexical';
import { $isImageNode } from '@mdxeditor/editor';
import { dragSize, pastThreshold, savedSize, type Size } from './image-drag';

const CORNERS = ['nw', 'ne', 'sw', 'se'] as const;
/** The shortest side a drag leaves an image, in CSS pixels. */
const MIN_SIDE = 16;

/** The width of `block`'s content box: the column an image in it fills at most. */
function columnWidth(block: HTMLElement): number {
  const style = getComputedStyle(block);
  return block.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
}

/** Drags `img`, the image of node `key` in `editor`, by the corner handle
 * `down` pressed, showing each size on the element and saving the last on
 * release. Returns what cancels it, for when the handle unmounts mid-drag. */
function drag(editor: LexicalEditor, key: string, img: HTMLImageElement, keepHeight: boolean, down: PointerEvent): () => void {
  const handle = down.target as HTMLElement, corner = handle.dataset.corner!;
  const box = img.getBoundingClientRect(), start = { width: box.width, height: box.height }, ratio = box.height / box.width;
  const block = editor.getElementByKey(key)?.parentElement;
  const max = block ? columnWidth(block) : Infinity;
  const min = Math.min(max, Math.max(MIN_SIDE, MIN_SIDE / ratio));
  // The document's own size, which the element shows again when a drag is cancelled.
  const shown = { width: img.style.width, height: img.style.height };
  // Away from the opposite corner is larger.
  const sx = corner[1] === 'w' ? -1 : 1, sy = corner[0] === 'n' ? -1 : 1;
  // The size to save, null until the pointer passes the threshold and after Esc.
  let size: Size | null = null, resizing = false, cancelled = false;
  // Every listener goes with the drag, wherever it ends.
  const listening = new AbortController(), { signal } = listening;

  const move = (event: PointerEvent) => {
    if (cancelled || event.pointerId !== down.pointerId) return;
    const dx = (event.clientX - down.clientX) * sx, dy = (event.clientY - down.clientY) * sy;
    if (!resizing && !pastThreshold(dx, dy)) return;
    resizing = true;
    size = dragSize(start, dx, dy, min, max);
    img.style.width = `${size.width}px`;
    img.style.height = `${size.height}px`;
  };
  const end = (save: boolean) => {
    if (signal.aborted) return;
    listening.abort();
    if (handle.hasPointerCapture(down.pointerId)) handle.releasePointerCapture(down.pointerId);
    const saved = save ? savedSize(start, size) : null;
    if (!saved) { Object.assign(img.style, shown); return; }
    // The element keeps the new width, which the node's then matches.
    if (!keepHeight) img.style.height = shown.height;
    editor.update(() => {
      const node = $getNodeByKey(key);
      if ($isImageNode(node)) node.setWidthAndHeight(saved.width, keepHeight ? saved.height : 'inherit');
    });
  };
  const ends = (save: boolean) => (event: PointerEvent) => { if (event.pointerId === down.pointerId) end(save); };
  // Esc restores the size but holds the pointer until its release, whose click the frame then swallows.
  const escape = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    cancelled = true;
    size = null;
    Object.assign(img.style, shown);
  };
  handle.setPointerCapture(down.pointerId);
  handle.addEventListener('pointermove', move, { signal });
  handle.addEventListener('pointerup', ends(true), { signal });
  // A handle that leaves the page loses its capture to the document.
  for (const target of [handle, document]) {
    target.addEventListener('lostpointercapture', ends(false) as EventListener, { signal });
    target.addEventListener('pointercancel', ends(false) as EventListener, { signal });
  }
  window.addEventListener('keydown', escape, { capture: true, signal });
  return () => end(false);
}

/** The selection frame and corner handles of image node `nodeKey`, shown
 * while it alone is selected. `keepHeight` says the document gave it a height. */
export function ImageResizeHandles({ nodeKey, keepHeight }: { nodeKey: string; keepHeight: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  // The node's editor: the root's, or a table cell's.
  const [editor, setEditor] = useState<LexicalEditor | null>(null);
  useEffect(() => setEditor(getNearestEditorFromDOMNode(ref.current)), []);
  const subscribe = useCallback((changed: () => void) => editor?.registerUpdateListener(changed) ?? (() => {}), [editor]);
  const selected = useSyncExternalStore(subscribe, () => !!editor?.getEditorState().read(() => {
    const selection = $getSelection();
    return $isNodeSelection(selection) && selection.has(nodeKey);
  }));

  useEffect(() => {
    const frame = ref.current;
    if (!editor || !frame) return;
    // The drag under way, which ends with the frame: an undo or reload can remove it mid-drag.
    let dragging: (() => void) | undefined;
    // On the frame itself, ahead of the editor's own listeners on its root.
    const down = (event: PointerEvent) => {
      const img = frame.parentElement?.querySelector('img');
      if (!(event.target as HTMLElement).dataset.corner || !img || event.button !== 0 || !editor.isEditable()) return;
      event.preventDefault();
      event.stopPropagation();
      dragging?.();
      dragging = drag(editor, nodeKey, img, keepHeight, event);
    };
    const click = (event: MouseEvent) => event.stopPropagation();
    frame.addEventListener('pointerdown', down);
    frame.addEventListener('click', click);
    return () => {
      dragging?.();
      frame.removeEventListener('pointerdown', down);
      frame.removeEventListener('click', click);
    };
  }, [editor, nodeKey, keepHeight]);

  return (
    <span ref={ref} className="md-image-frame" hidden={!selected}>
      {CORNERS.map(corner => <span key={corner} className="md-image-handle" data-corner={corner} />)}
    </span>
  );
}

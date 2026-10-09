/** Corner handles that resize an image in the Markdown editor
 * (docs/specs/dor-tools-builtin.md -> Markdown editor), drawn by its image
 * toolbar inside MDXEditor's image wrapper while the image is selected. A drag
 * keeps the image's aspect from the size it shows at, within the column, and
 * its release saves a width, and a height only when the document gave one, as
 * one undo step. Esc cancels it. */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { $getNodeByKey, $getSelection, $isNodeSelection, getNearestEditorFromDOMNode, type LexicalEditor } from 'lexical';
import { $isImageNode } from '@mdxeditor/editor';

const CORNERS = ['nw', 'ne', 'sw', 'se'] as const;
/** The shortest side a drag leaves an image, in CSS pixels. */
const MIN_SIDE = 16;

/** The width of `block`'s content box: the column an image in it fills at most. */
function columnWidth(block: HTMLElement): number {
  const style = getComputedStyle(block);
  return block.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
}

/** Drags `img`, the image of node `key` in `editor`, by the corner handle
 * `down` pressed, showing each size on the element and saving the last on release. */
function drag(editor: LexicalEditor, key: string, img: HTMLImageElement, keepHeight: boolean, down: PointerEvent) {
  const handle = down.target as HTMLElement, corner = handle.dataset.corner!;
  const box = img.getBoundingClientRect(), ratio = box.height / box.width;
  const block = editor.getElementByKey(key)?.parentElement;
  const max = block ? columnWidth(block) : Infinity;
  const min = Math.min(max, Math.max(MIN_SIDE, MIN_SIDE / ratio));
  // The document's own size, which the element shows again when a drag is cancelled.
  const shown = { width: img.style.width, height: img.style.height };
  // Away from the opposite corner is larger.
  const sx = corner[1] === 'w' ? -1 : 1, sy = corner[0] === 'n' ? -1 : 1;
  // The size to save, null until the pointer moves and after Esc.
  let size: { width: number; height: number } | null = null, cancelled = false;

  const move = (event: PointerEvent) => {
    if (cancelled) return;
    const dx = (event.clientX - down.clientX) * sx, dy = (event.clientY - down.clientY) * sy;
    // The pointer's travel along the corner's diagonal, so the aspect holds.
    const width = Math.round(Math.min(max, Math.max(min, box.width + (dx * box.width + dy * box.height) * box.width / (box.width ** 2 + box.height ** 2))));
    size = { width, height: Math.round(width * ratio) };
    img.style.width = `${size.width}px`;
    img.style.height = `${size.height}px`;
  };
  const end = (save: boolean) => {
    handle.removeEventListener('pointermove', move);
    handle.removeEventListener('pointerup', release);
    handle.removeEventListener('lostpointercapture', cancel);
    window.removeEventListener('keydown', escape, true);
    if (handle.hasPointerCapture(down.pointerId)) handle.releasePointerCapture(down.pointerId);
    const saved = save ? size : null;
    if (!saved) { Object.assign(img.style, shown); return; }
    // The element keeps the new width, which the node's then matches.
    if (!keepHeight) img.style.height = shown.height;
    editor.update(() => {
      const node = $getNodeByKey(key);
      if ($isImageNode(node)) node.setWidthAndHeight(saved.width, keepHeight ? saved.height : 'inherit');
    });
  };
  const release = () => end(true);
  const cancel = () => end(false);
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
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', release);
  handle.addEventListener('lostpointercapture', cancel);
  window.addEventListener('keydown', escape, true);
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
    // On the frame itself, ahead of the editor's own listeners on its root.
    const down = (event: PointerEvent) => {
      const img = frame.parentElement?.querySelector('img');
      if (!(event.target as HTMLElement).dataset.corner || !img || event.button !== 0 || !editor.isEditable()) return;
      event.preventDefault();
      event.stopPropagation();
      drag(editor, nodeKey, img, keepHeight, event);
    };
    const click = (event: MouseEvent) => event.stopPropagation();
    frame.addEventListener('pointerdown', down);
    frame.addEventListener('click', click);
    return () => { frame.removeEventListener('pointerdown', down); frame.removeEventListener('click', click); };
  }, [editor, nodeKey, keepHeight]);

  return (
    <span ref={ref} className="md-image-frame" hidden={!selected}>
      {CORNERS.map(corner => <span key={corner} className="md-image-handle" data-corner={corner} />)}
    </span>
  );
}

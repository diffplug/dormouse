import { saveFileOperations, type SaveFileOperations } from './atomic-save.js';
import { readEditable, replaceEditable } from './editable-file.js';
import type { EditorStore } from './editor-routes.js';
import { createImage, editableImageFile, renameImage } from './markdown-images.js';

/** The local filesystem as the file viewer's `EditorStore`: the opened
 * document and the images under its folder `root`. */
export function editorStore(root: string, operations: SaveFileOperations = saveFileOperations): EditorStore {
  return {
    read: readEditable,
    replace: (file, version, bound, encode) => replaceEditable(file, version, bound, encode, operations),
    editableImage: segments => editableImageFile(root, segments),
    create: (name, bytes) => createImage(root, name, bytes),
    rename: (from, to) => renameImage(root, from, to),
  };
}

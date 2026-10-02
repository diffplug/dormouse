/** Formats supported by the built-in local viewer. Unknown files need a user
 * Tool association rather than being guessed to be text. */
const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon',
  css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  json: 'application/json', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
};
const TEXT = new Set(['txt', 'md', 'markdown', 'mdx', 'log', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'xml',
  'css', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rs', 'go', 'java', 'c', 'h', 'cpp', 'sh', 'ps1', 'sql', 'ini', 'conf']);

/** The private argv verb for the page a failed OSC 367 `open` shows in the
 * preview slot (docs/specs/dor-tools-builtin.md -> Error viewer); no handler
 * name selects it. */
export const VIEW_ERROR_ARGV = '__view-error';
/** An `open` rule whose pattern ends in this suffix (U+1F4C1) matches only
 * directories, tested as their names suffixed with it. */
export const FOLDER_MATCH_SUFFIX = '.📁';

export type FileFormat = { mime: string; text: boolean; markdown?: true };

/** One built-in handler. The lib host's `resolveOpenTool` and `dor`'s private
 * entries share this table through the `dor-tools-builtin/*` alias; this
 * module stays free of Node APIs. */
export interface BuiltinHandler {
  /** The name an `open` rule or `--tool` selects it by. */
  readonly tool: string;
  /** What it opens; it never opens the other kind (docs/specs/dor-tool.md -> Folders). */
  readonly opens: 'file' | 'folder';
  /** Its Tool's result `name`, which namespaces its key and persists. */
  readonly kind: string;
  /** The private `dor` argv verb that runs it on one path. */
  readonly argv: string;
  /** Its page can hold unsaved edits (docs/specs/dor-tools-builtin.md -> Editing files). */
  readonly editor: boolean;
  /** How it serves a file, or null when it cannot; folders need none. */
  format(path: string): FileFormat | null;
  /** Whether a person choosing a handler is offered it: where it supports the
   * file and shows something the default does not. */
  offered(path: string): boolean;
  /** What it shows for `path`. */
  describe(path: string): string;
}

/** `builtin:code` opens every format whose bytes are source, as plain text. */
function codeFormat(path: string): FileFormat | null {
  const format = fileViewerFormat(path);
  return format && (format.text || /^text\/|^image\/svg\+xml$/.test(format.mime)) ? { mime: 'text/plain; charset=utf-8', text: true } : null;
}

function describeFile(path: string): string {
  const format = fileViewerFormat(path);
  if (!format) return 'file viewer (unsupported format)';
  if (format.markdown) return 'Markdown editor';
  if (format.text) return 'code editor';
  if (format.mime.startsWith('text/html')) return 'HTML preview';
  if (format.mime.startsWith('image/')) return 'image viewer';
  if (/^(audio|video)\//.test(format.mime)) return 'media player';
  return 'file viewer';
}

/** Defaults first: `builtin:file` for files, `builtin:folder` for folders. */
export const BUILTIN_HANDLERS: readonly BuiltinHandler[] = [
  { tool: 'builtin:file', opens: 'file', kind: 'file', argv: '__view-file', editor: true,
    format: fileViewerFormat, offered: path => fileViewerFormat(path) !== null, describe: describeFile },
  // Markdown, HTML, and SVG as source (docs/specs/dor-tools-builtin.md -> Code
  // editor); every other text format already opens in Monaco under builtin:file.
  { tool: 'builtin:code', opens: 'file', kind: 'code', argv: '__view-code', editor: true,
    format: codeFormat, offered: path => { const format = fileViewerFormat(path); return codeFormat(path) !== null && !!(format?.markdown || !format?.text); },
    describe: () => 'code editor (source)' },
  { tool: 'builtin:folder', opens: 'folder', kind: 'folder', argv: '__view-folder', editor: false,
    format: () => null, offered: () => true, describe: () => 'folder viewer' },
];

/** The built-in whose handler name, result `name`, or argv verb is `value`. */
export function builtinHandler(by: 'tool' | 'kind' | 'argv', value: unknown): BuiltinHandler | undefined {
  return BUILTIN_HANDLERS.find(handler => handler[by] === value);
}

/** The built-in a folder or a file opens with when no rule matches. */
export function defaultBuiltin(folder: boolean): BuiltinHandler {
  return BUILTIN_HANDLERS.find(handler => handler.opens === (folder ? 'folder' : 'file'))!;
}

/** C0, DEL, and C1 controls. */
export const CONTROLS = /[\x00-\x1f\x7f-\x9f]/;

/** The title naming a viewer's canonical `target`, `/` or `\` separated: its
 * basename, or the whole path for a filesystem root. Controls are stripped,
 * since a file name can carry an OSC terminator; the terminal parser bounds its
 * length. A preview slot switch names its new target with it too. */
export function viewerTitle(target: string): string {
  const trimmed = target.replace(/[\\/]+$/, '');
  const root = /^([A-Za-z]:)?$/.test(trimmed);
  const title = root ? target : trimmed.slice(Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) + 1);
  return Array.from(title).filter(c => !CONTROLS.test(c)).join('');
}

/** Text the rich Markdown editor opens (docs/specs/dor-tools-builtin.md -> Markdown editor). */
const MARKDOWN = new Set(['md', 'markdown']);

export function fileViewerFormat(path: string): FileFormat | null {
  const name = path.replace(/\\/g, '/').split('/').pop()!.toLowerCase();
  const ext = name.includes('.') ? name.split('.').pop()! : '';
  // PDF plugins cannot run inside the viewer's iframe sandbox. Exclude PDFs
  // before source-name heuristics so README.pdf never becomes a text preview.
  if (ext === 'pdf') return null;
  const knownMime = Object.prototype.hasOwnProperty.call(MIME, ext) ? MIME[ext] : undefined;
  const text = TEXT.has(ext) || (!knownMime && /^(readme|license|licence|makefile|dockerfile|\.gitignore|\.env)(\..*)?$/.test(name));
  const mime = knownMime ?? (text ? 'text/plain; charset=utf-8' : null);
  if (!mime) return null;
  return MARKDOWN.has(ext) ? { mime, text, markdown: true } : { mime, text };
}

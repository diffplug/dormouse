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

/** The handler name an `open` rule or `--tool` uses to select the viewer, and
 * the private `dor` argv verb that runs it. The lib host's `resolveOpenTool`
 * shares both through the `dor-tools-builtin/*` alias; this module stays free of Node APIs. */
export const BUILTIN_FILE_TOOL = 'builtin:file';
export const VIEW_FILE_ARGV = '__view-file';
/** The same pair for the folder viewer (docs/specs/dor-tool.md -> Folders). */
export const BUILTIN_FOLDER_TOOL = 'builtin:folder';
export const VIEW_FOLDER_ARGV = '__view-folder';
/** The private argv verb for the page a failed OSC 367 `open` shows in the
 * preview slot (docs/specs/dor-tools-builtin.md -> Error viewer); no handler
 * name selects it. */
export const VIEW_ERROR_ARGV = '__view-error';
/** An `open` rule whose pattern ends in this suffix (U+1F4C1) matches only
 * directories, tested as their names suffixed with it. */
export const FOLDER_MATCH_SUFFIX = '.📁';

/** The built-in handler for a folder or a file (`own`), its result `name` and
 * argv verb, and the other kind's handler, which never opens it
 * (docs/specs/dor-tool.md -> Folders). */
export function builtinFor(folder: boolean) {
  return folder
    ? { kind: 'folder', argv: VIEW_FOLDER_ARGV, own: BUILTIN_FOLDER_TOOL, other: BUILTIN_FILE_TOOL } as const
    : { kind: 'file', argv: VIEW_FILE_ARGV, own: BUILTIN_FILE_TOOL, other: BUILTIN_FOLDER_TOOL } as const;
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

export function fileViewerFormat(path: string): { mime: string; text: boolean; markdown?: true } | null {
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

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
const TEXT = new Set(['txt', 'md', 'mdx', 'log', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'xml',
  'css', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rs', 'go', 'java', 'c', 'h', 'cpp', 'sh', 'ps1', 'sql', 'ini', 'conf']);

/** The handler name an `open` rule or `--tool` uses to select the viewer, and
 * the private `dor` argv verb that runs it. The lib host's `resolveOpenTool`
 * shares both through the `dor/*` alias; this module stays free of Node APIs. */
export const BUILTIN_FILE_TOOL = 'builtin:file';
export const VIEW_FILE_ARGV = '__view-file';

export function fileViewerFormat(path: string): { mime: string; text: boolean } | null {
  const name = path.replace(/\\/g, '/').split('/').pop()!.toLowerCase();
  const ext = name.includes('.') ? name.split('.').pop()! : '';
  // PDF plugins cannot run inside the viewer's iframe sandbox. Exclude PDFs
  // before source-name heuristics so README.pdf never becomes a text preview.
  if (ext === 'pdf') return null;
  const knownMime = Object.prototype.hasOwnProperty.call(MIME, ext) ? MIME[ext] : undefined;
  const text = TEXT.has(ext) || (!knownMime && /^(readme|license|licence|makefile|dockerfile|\.gitignore|\.env)(\..*)?$/.test(name));
  const mime = knownMime ?? (text ? 'text/plain; charset=utf-8' : null);
  return mime ? { mime, text } : null;
}

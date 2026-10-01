import { basename } from 'node:path';
import { announceViewer, escapeHtml, HttpError, reply, startCapabilityViewer } from './viewer-server.js';

const CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";
const STYLE = `
:root{color-scheme:light dark}
html,body{height:100%;margin:0}
body{display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;background:var(--vscode-editor-background,Canvas);color:var(--vscode-editor-foreground,CanvasText);font:var(--vscode-font-size,13px)/1.5 var(--vscode-font-family,system-ui,sans-serif)}
main{max-width:640px;min-width:0}
h1{margin:0 0 8px;font-size:inherit;font-weight:600;overflow-wrap:anywhere}
p{margin:0;opacity:.8;overflow-wrap:anywhere;white-space:pre-wrap}
`;

/** The page naming why `target` could not be shown: text only, no script. */
export function errorViewerPage(target: string, message: string): string {
  const name = escapeHtml(basename(target) || target);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${name}</title><style>${STYLE}</style></head>`
    + `<body><main><h1>Can't show ${name}</h1><p>${escapeHtml(message)}</p></main></body></html>`;
}

/** A listener serving only that page, for the preview slot to frame when an
 * OSC 367 `open` fails (docs/specs/dor-tools-builtin.md -> Error viewer). */
export async function startErrorViewer(target: string, message: string): Promise<{ port: number; path: string; close(): Promise<void> }> {
  const page = errorViewerPage(target, message);
  const viewer = await startCapabilityViewer({
    csp: CSP,
    unavailable: 'Error page unavailable',
    route: async (req, res, prefix) => {
      if (req.url !== prefix) throw new HttpError(404);
      reply(res, 200, page, 'text/html; charset=utf-8');
    },
  });
  return { port: viewer.port, path: viewer.prefix, close: viewer.close };
}

/** The `dor __view-error <target> <message>` entry: starts the viewer, which
 * outlives the call, and returns its title and OSC 367 announcement. */
export async function runErrorViewer(target: string, message: string): Promise<string> {
  const viewer = await startErrorViewer(target, message);
  return announceViewer(viewer, target);
}

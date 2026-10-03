import { viewerTitle } from './file-viewer-format.js';
import { escapeHtml } from './viewer-http.js';

export const ERROR_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";
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
  const name = escapeHtml(viewerTitle(target));
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${name}</title><style>${STYLE}</style></head>`
    + `<body><main><h1>Can't show ${name}</h1><p>${escapeHtml(message)}</p></main></body></html>`;
}

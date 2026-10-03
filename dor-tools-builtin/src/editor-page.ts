import { escapeHtml } from './html.js';

// The editor pages load only their own scripts, workers, fonts, and images;
// the Markdown page renders document HTML through its own allowlist.
export const EDITOR_CSP = "default-src 'none'; script-src 'self' 'unsafe-inline'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'none'; object-src 'none'; media-src 'none'; base-uri 'none'; form-action 'none'";

const CONFIRM = '<dialog id="confirm"><form method="dialog"><h2>Discard unsaved changes?</h2><p>Reloading replaces your edits with the file on disk.</p><div><button value="cancel">Cancel</button><button value="discard">Discard and reload</button></div></form></dialog>';

export function editorPage(name: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(name)}</title><link rel="stylesheet" href="assets/editor.css"></head><body>
<header><span id="filename" title="${escapeHtml(name)}">${escapeHtml(name)}</span><span id="state" role="status">Loading…</span><button id="wrap" title="Toggle word wrap" aria-pressed="false">Wrap</button><button id="reload" title="Reload from disk">Reload</button><button id="save" disabled title="Save [Cmd/Ctrl+S]">Save</button></header>
<div id="error" role="alert" hidden></div><main id="editor" aria-label="Code editor"></main><footer><span id="language"></span><span id="position"></span><span id="encoding">UTF-8</span></footer>
${CONFIRM}
<script type="module" src="assets/editor.js"></script></body></html>`;
}

/** The rich Markdown editor (docs/specs/dor-tools-builtin.md -> Markdown editor);
 * the document arrives from `source` as JSON, never in this markup. */
export function markdownPage(name: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(name)}</title><link rel="stylesheet" href="assets/markdown.css"></head><body>
<div id="root"></div>${CONFIRM}<script type="module" src="assets/markdown.js"></script></body></html>`;
}

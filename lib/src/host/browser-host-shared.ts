/** Policy both browser-provider hosts share (`agent-browser-host.ts`,
 *  `playwright-host.ts`): session checks, the fixed editing scripts, GUI
 *  session minting, and capture quality. See docs/specs/dor-browser.md. */
import { randomBytes } from 'crypto';
import { sessionForKey } from 'dor-lib-common';
import type { BrowserEditOp, BrowserOp } from '../lib/platform/browser-automation';

// The host owns the exact JS for each editing op — the webview only selects a
// name, so this never becomes an arbitrary-eval channel. copy/cut return the
// selected text; selectAll returns ''. Inputs/textareas use selection ranges;
// everything else falls back to the Selection API + execCommand.
const EDIT_SCRIPTS: Record<BrowserEditOp, string> = {
  selectAll: `(()=>{const el=document.activeElement;if(el&&'select'in el&&'value'in el){el.select();}else{document.execCommand('selectAll');}return'';})()`,
  copy: `(()=>{const el=document.activeElement;if(el&&'selectionStart'in el&&el.selectionStart!=null){return el.value.slice(el.selectionStart,el.selectionEnd);}return String(window.getSelection()||'');})()`,
  cut: `(()=>{const el=document.activeElement;if(el&&'selectionStart'in el&&el.selectionStart!=null){const s=el.selectionStart,e=el.selectionEnd,t=el.value.slice(s,e);el.setRangeText('',s,e,'end');el.dispatchEvent(new Event('input',{bubbles:true}));return t;}const sel=String(window.getSelection()||'');if(sel)document.execCommand('delete');return sel;})()`,
};

/** The fixed script for an editing op; undefined for any other name.
 *
 *  `op` is typed but arrives from webview IPC unvalidated, and a plain-object
 *  lookup answers for inherited keys too: `op: 'constructor'` yields `Object`,
 *  which is truthy and walks straight past a caller's rejection into the page.
 *  `hasOwnProperty.call` keeps the table's own three names the only ones that
 *  select a script, which is what the comment on `EDIT_SCRIPTS` claims. Same
 *  guard, same reason as `own()` in `RemoteControlSection.tsx`. */
export function editScript(op: unknown): string | undefined {
  return typeof op === 'string' && Object.prototype.hasOwnProperty.call(EDIT_SCRIPTS, op)
    ? EDIT_SCRIPTS[op as BrowserEditOp]
    : undefined;
}

// A fresh managed session for a surface spawned from the GUI (no `--key`),
// using dor ab's workspace-scoped sessionForKey namespacing so it can't collide
// with a user's own browser sessions.
export function generateGuiSession(): string {
  return sessionForKey(`gui-${randomBytes(6).toString('hex')}`);
}

/** A capture's image format: PNG when asked for, else JPEG. */
export function captureFormat(format: unknown): 'png' | 'jpeg' {
  return format === 'png' ? 'png' : 'jpeg';
}

/** A capture's JPEG quality: an integer in 1..100, defaulting to 85. */
export function jpegQuality(quality: unknown): number {
  if (typeof quality !== 'number' || !Number.isFinite(quality)) return 85;
  return Math.min(100, Math.max(1, Math.round(quality)));
}

/** An agent-browser session name. `dor ab --session` passes a user's raw name
 *  through, so anything goes but what agent-browser would read as an option or
 *  its socket directory as a path: the name lands after `--session` and in
 *  `<socket dir>/<session>.pid`, whose pid a relaunch signals. */
export function isAgentBrowserSession(value: unknown): value is string {
  return typeof value === 'string' && /^(?!-)[^/\\\x00-\x1f\x7f]{1,200}$/.test(value);
}

/** A Playwright session name: Dormouse mints these, and the host passes them
 *  as `--session=<name>`, so a strict charset costs nothing. */
export function isPlaywrightSession(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{1,200}$/.test(value);
}

/** An operation on a live browser that each provider maps to its own call:
 *  a fixed agent-browser argv, or a Playwright client call. */
export type BrowserAct = Extract<BrowserOp, { op: 'navigate' | 'history' | 'tab' | 'viewport' | 'device' | 'cdpUrl' | 'close' }>;

/** Policy both browser-provider hosts share (`agent-browser-host.ts`,
 *  `playwright-host.ts`): the webview command parser, session and URL checks,
 *  the fixed editing scripts, GUI session minting, and capture quality. See
 *  docs/specs/dor-browser.md. */
import { randomBytes } from 'crypto';
import { sessionForKey } from 'dor-lib-common';
import type { AgentBrowserEditOp } from '../lib/platform/types';
import { isBrowsableUrl } from '../lib/platform/browser-automation';

// The host owns the exact JS for each editing op — the webview only selects a
// name, so this never becomes an arbitrary-eval channel. copy/cut return the
// selected text; selectAll returns ''. Inputs/textareas use selection ranges;
// everything else falls back to the Selection API + execCommand.
const EDIT_SCRIPTS: Record<AgentBrowserEditOp, string> = {
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
    ? EDIT_SCRIPTS[op as AgentBrowserEditOp]
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

/** One command the webview may ask a provider host to run. */
export type WebviewCommand =
  | { kind: 'open'; url: string }
  | { kind: 'back' | 'forward' | 'reload' | 'close' }
  | { kind: 'cdp-url' }
  | { kind: 'tab-list' }
  | { kind: 'tab-select' | 'tab-close'; tab: string }
  | { kind: 'viewport'; width: number; height: number; dpr: number }
  | { kind: 'device'; name: string };

const TAB_REF = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DEVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ()._-]{0,63}$/;

function dimension(value: string, max: number): number | null {
  const n = /^\d{1,5}(\.\d{1,20})?$/.test(value) ? Number(value) : NaN;
  return n > 0 && n <= max ? n : null;
}

/**
 * The webview's command argv (the wire stays agent-browser's grammar), parsed
 * into the one shape its verb takes, or null. The security boundary for both
 * hosts: each renders its own argv or API call from the parsed value, so no
 * webview token reaches a CLI as it came — agent-browser reads launch options
 * anywhere on its command line (docs/specs/dor-browser.md → "Agent-Browser Host
 * Capabilities"). `args` is typed but arrives from webview IPC unvalidated.
 */
export function parseWebviewCommand(args: unknown): WebviewCommand | null {
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) return null;
  const [verb, ...rest] = args as string[];
  switch (verb) {
    case 'open':
      return rest.length === 1 && isBrowsableUrl(rest[0]) ? { kind: 'open', url: rest[0] } : null;
    case 'back':
    case 'forward':
    case 'reload':
    case 'close':
      return rest.length === 0 ? { kind: verb } : null;
    case 'get':
      return rest.length === 1 && rest[0] === 'cdp-url' ? { kind: 'cdp-url' } : null;
    case 'tab':
      if (rest.length === 1 && rest[0] === 'list') return { kind: 'tab-list' };
      // `tab <ref>` selects; the verb's own operation words are not refs.
      if (rest.length === 1 && TAB_REF.test(rest[0]) && !['new', 'close'].includes(rest[0])) return { kind: 'tab-select', tab: rest[0] };
      return rest.length === 2 && rest[0] === 'close' && TAB_REF.test(rest[1]) ? { kind: 'tab-close', tab: rest[1] } : null;
    case 'set': {
      if (rest[0] === 'device') return rest.length === 2 && DEVICE_NAME.test(rest[1]) ? { kind: 'device', name: rest[1] } : null;
      if (rest[0] !== 'viewport' || rest.length !== 4) return null;
      const [width, height, dpr] = [dimension(rest[1], 16384), dimension(rest[2], 16384), dimension(rest[3], 10)];
      return width && height && dpr ? { kind: 'viewport', width, height, dpr } : null;
    }
    default:
      return null;
  }
}

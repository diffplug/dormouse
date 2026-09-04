// Exporting a note to the system clipboard (docs/specs/notepad.md). The HTML
// flavor is generated here rather than by serializing rendered DOM, so the only
// thing that can reach the clipboard is escaped text plus the four attributes
// `RichTextRun` carries.
import { writeTextToClipboard } from '../clipboard';
import type { NoteContent, RichTextRun } from './types';

/** The archive is a file on disk a user can edit, so a color is re-checked on
 *  the way out and dropped unless it is exactly a normalized `#rrggbb`. */
const HEX_COLOR = /^#[0-9a-f]{6}$/;

export function noteToPlainText(content: NoteContent): string {
  if (content.kind === 'plain') return content.text;
  return content.runs.map((run) => run.text).join('');
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function runStyle(run: RichTextRun): string {
  const parts: string[] = [];
  if (run.bold) parts.push('font-weight:bold');
  if (run.italic) parts.push('font-style:italic');
  if (run.foreground && HEX_COLOR.test(run.foreground)) parts.push(`color:${run.foreground}`);
  if (run.background && HEX_COLOR.test(run.background)) parts.push(`background-color:${run.background}`);
  return parts.join(';');
}

/**
 * The `text/html` flavor: a whitespace-preserving container of escaped spans.
 * `pre-wrap` rather than `pre` because the receiving editor decides the width —
 * a captured excerpt should reflow there, not run off the page.
 */
export function noteToHtml(content: NoteContent): string {
  const body = content.kind === 'plain'
    ? escapeHtml(content.text)
    : content.runs.map((run) => {
      const text = escapeHtml(run.text);
      const style = runStyle(run);
      return style ? `<span style="${style}">${text}</span>` : text;
    }).join('');
  return `<pre style="white-space:pre-wrap">${body}</pre>`;
}

function canWriteRichClipboard(): boolean {
  return typeof ClipboardItem !== 'undefined'
    && typeof navigator !== 'undefined'
    && typeof navigator.clipboard?.write === 'function';
}

/**
 * Copy a note. `text/plain` is always written; a terminal note adds `text/html`
 * so the styling survives into a rich destination. Anything the async clipboard
 * refuses — no `ClipboardItem`, a webview without focus, a permission denial —
 * falls back to the plain-text write, which is best effort by contract.
 */
export async function copyNoteToClipboard(content: NoteContent): Promise<void> {
  const text = noteToPlainText(content);
  if (content.kind === 'terminal' && canWriteRichClipboard()) {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/plain': new Blob([text], { type: 'text/plain' }),
          'text/html': new Blob([noteToHtml(content)], { type: 'text/html' }),
        }),
      ]);
      return;
    } catch {
      // Fall through to the plain-text write below.
    }
  }
  await writeTextToClipboard(text);
}

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { CheckIcon, CopyIcon, PushPinIcon, TrashIcon } from '@phosphor-icons/react';
import { popupButton } from './design';
import { noteToPlainText } from '../lib/notepad/rich-clipboard';
import type { PinOutcome } from '../lib/notepad/pin';
import type { LiveNote, RichTextRun } from '../lib/notepad/types';

/** How long the Copy button shows its check, matching the terminal selection
 *  popup's copy confirmation (`flashCopy`). */
const COPY_FLASH_MS = 700;

/** What a note's row says about a pin that just refused to resolve
 *  (docs/specs/notepad.md → Source links). `alternate-buffer` is the one
 *  failure that keeps the pin, so its row invites a retry. */
export interface SourceNotice {
  noteId: string;
  kind: 'unavailable' | 'alternate-buffer';
}

const SOURCE_NOTICE_TEXT: Record<SourceNotice['kind'], string> = {
  unavailable: 'Source no longer available',
  'alternate-buffer': 'Exit the full-screen program to show this source',
};

/** The notice a pin's outcome earns, or `null` when it resolved and there is
 *  nothing to say. A kept pin is the retryable one, so the kind follows
 *  `outcome.kept` rather than the reason. */
export function sourceNoticeFor(noteId: string, outcome: PinOutcome): SourceNotice | null {
  if (outcome.ok) return null;
  return { noteId, kind: outcome.kept ? 'alternate-buffer' : 'unavailable' };
}

export interface NoteListProps {
  /** Creation order, top to bottom — the store's own order, never re-sorted. */
  notes: readonly LiveNote[];
  onCopy: (note: LiveNote) => void;
  onDelete: (note: LiveNote) => void;
  /** Absent ⇒ read-only, which is how the Archive view renders the same list. */
  onEdit?: (noteId: string, text: string) => void;
  /** Absent ⇒ no pins anywhere; present ⇒ one on every note still carrying a
   *  source (docs/specs/notepad.md → Source links). */
  onRevealSource?: (noteId: string) => void;
  /** The note whose pin just failed to resolve, and why; its row says so. */
  sourceNotice?: SourceNotice | null;
  /** A freshly added note to put the caret in (Add New). */
  autoFocusNoteId?: string | null;
  /** Fires when an editor loses focus, so the owner can prune an untouched
   *  empty note. */
  onNoteBlur?: (noteId: string) => void;
  /** Read-only: the editors refuse input and Delete and the pin are held, while
   *  a caller is mid-commit — the Archive view committing staged deletions, or a
   *  closure writing this Surface's notes (docs/specs/notepad.md → "Closure").
   *  Copy stays live since it changes nothing. */
  disabled?: boolean;
}

export function NoteList({
  notes,
  onCopy,
  onDelete,
  onEdit,
  onRevealSource,
  sourceNotice,
  autoFocusNoteId,
  onNoteBlur,
  disabled = false,
}: NoteListProps) {
  return (
    <ul>
      {notes.map((note) => (
        <NoteItem
          key={note.id}
          note={note}
          onCopy={onCopy}
          onDelete={onDelete}
          onEdit={onEdit}
          onRevealSource={onRevealSource}
          sourceNoticeKind={sourceNotice?.noteId === note.id ? sourceNotice.kind : null}
          autoFocus={autoFocusNoteId === note.id}
          onNoteBlur={onNoteBlur}
          disabled={disabled}
        />
      ))}
    </ul>
  );
}

// Memoized: a note is edited one keystroke at a time, and the store keeps every
// other note's identity across that edit, so the list re-renders only the row
// that changed rather than re-diffing a span per run of every rich note.
const NoteItem = memo(function NoteItem({
  note,
  onCopy,
  onDelete,
  onEdit,
  onRevealSource,
  sourceNoticeKind,
  autoFocus,
  onNoteBlur,
  disabled,
}: {
  note: LiveNote;
  onCopy: (note: LiveNote) => void;
  onDelete: (note: LiveNote) => void;
  onEdit?: (noteId: string, text: string) => void;
  onRevealSource?: (noteId: string) => void;
  sourceNoticeKind: SourceNotice['kind'] | null;
  autoFocus: boolean;
  onNoteBlur?: (noteId: string) => void;
  disabled: boolean;
}) {
  const [flashed, setFlashed] = useState(false);
  // Where the caret goes once a rich note's conversion has re-rendered it as
  // the plain editor. Held across that render, not applied to the rich DOM.
  const [pendingCaret, setPendingCaret] = useState<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const richRef = useRef<HTMLDivElement>(null);
  // Narrowed once, so every branch below reads the content it actually has.
  const plain = note.content.kind === 'plain' ? note.content : null;
  const rich = note.content.kind === 'terminal' ? note.content : null;
  const editable = !!onEdit;

  useEffect(() => {
    if (!flashed) return;
    const timer = window.setTimeout(() => setFlashed(false), COPY_FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [flashed]);

  // Grow to fit rather than scroll: a note is short, and an inner scrollbar
  // inside the panel's own scroller reads as two nested lists.
  const text = plain?.text ?? '';
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    // jsdom reports 0 for every scrollHeight; leaving `auto` there keeps the
    // `rows` fallback instead of collapsing the field to nothing.
    if (el.scrollHeight > 0) el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  useEffect(() => {
    if (!autoFocus) return;
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [autoFocus]);

  useLayoutEffect(() => {
    if (pendingCaret === null) return;
    const el = textareaRef.current;
    // Still rich (nothing converted it): wait for the plain editor rather than
    // dropping the caret on the floor.
    if (!el) return;
    el.focus();
    el.setSelectionRange(pendingCaret, pendingCaret);
    setPendingCaret(null);
  }, [pendingCaret, plain]);

  /**
   * A rich note's first content mutation. `beforeinput` is the one event that
   * names *what* the edit is (`inputType`) for typing, deletion, cut, and
   * paste alike, so the whole conversion hangs off it: cancel the DOM edit,
   * rebuild it against the note's plain text, and hand that to `onEdit`, which
   * converts the note atomically. Moving the caret or selecting never fires
   * here, so neither ever converts (docs/specs/notepad.md).
   *
   * Native rather than React's `onBeforeInput`, whose synthetic version is
   * built from composition/`textInput` events and carries no `inputType` — it
   * never fires for a deletion at all.
   */
  useEffect(() => {
    const el = richRef.current;
    if (!el || !onEdit || !rich) return;
    const before = rich.runs;
    const handle = (event: Event) => {
      const input = event as InputEvent;
      // Composition is the one edit not intercepted up front. An IME's
      // `insertCompositionText` is not cancelable, so `preventDefault()` is
      // ignored and the browser writes the composed text into the rich DOM
      // regardless; converting here would also swap the contentEditable for a
      // textarea mid-composition and orphan the IME. Let it run and convert
      // once at `compositionend`, with the composed text (`commitComposition`).
      if (input.isComposing || input.inputType === 'insertCompositionText') return;
      event.preventDefault();
      const plainText = runsToText(before);
      const edit = applyPlainEdit(plainText, targetOffsets(el, input), input.inputType, inputData(input));
      setPendingCaret(edit.caret);
      onEdit(note.id, edit.text);
    };
    el.addEventListener('beforeinput', handle);
    return () => el.removeEventListener('beforeinput', handle);
  }, [note.id, rich, onEdit]);

  /**
   * The end of a composition the `beforeinput` handler let through. The browser
   * has already written the composed text into the rich container, so the
   * container's own `textContent` *is* the note's new text — convert on that,
   * with the caret the composition left behind. React owns that DOM, and the
   * conversion re-render replaces it wholesale, which is the point.
   */
  const commitComposition = useCallback(() => {
    const el = richRef.current;
    if (!el || !onEdit) return;
    setPendingCaret(selectionOffsets(el).end);
    onEdit(note.id, el.textContent ?? '');
  }, [note.id, onEdit]);

  const copy = useCallback(() => {
    setFlashed(true);
    onCopy(note);
  }, [note, onCopy]);

  const showPin = !!onRevealSource && !!note.source;

  return (
    // A hairline between notes, not a card each: the panel is one list, and the
    // raised surface it sits on is already the container (DESIGN.md).
    <li className="border-t border-border px-2 py-1.5 first:border-t-0" data-note-id={note.id}>
      {plain ? (
        editable ? (
          <textarea
            ref={textareaRef}
            // A tab stop so the panel's focus trap reaches the editors, not
            // only the buttons.
            tabIndex={0}
            rows={1}
            aria-label="Note"
            value={text}
            readOnly={disabled}
            spellCheck={false}
            className="block w-full resize-none overflow-hidden border-0 bg-transparent p-0 font-mono text-sm leading-snug text-foreground outline-none"
            onChange={(e) => onEdit?.(note.id, e.target.value)}
            onBlur={() => onNoteBlur?.(note.id)}
          />
        ) : (
          <div className="whitespace-pre-wrap break-words font-mono text-sm leading-snug">{text}</div>
        )
      ) : (
        <div
          ref={richRef}
          // Escaped React spans, never `dangerouslySetInnerHTML`: captured
          // terminal output is untrusted text. Every mutation is cancelled in
          // the handler above, so React's tree and the DOM never diverge.
          contentEditable={editable && !disabled}
          suppressContentEditableWarning
          tabIndex={editable ? 0 : undefined}
          role={editable ? 'textbox' : undefined}
          aria-multiline={editable ? true : undefined}
          aria-readonly={editable && disabled ? true : undefined}
          aria-label={editable ? 'Note' : undefined}
          spellCheck={false}
          className="whitespace-pre-wrap break-words font-mono text-sm leading-snug outline-none"
          onBlur={() => onNoteBlur?.(note.id)}
          onCompositionEnd={editable ? commitComposition : undefined}
        >
          {rich?.runs.map((run, index) => (
            <span key={index} style={runStyle(run)}>{run.text}</span>
          ))}
        </div>
      )}
      {sourceNoticeKind && (
        <div className="mt-0.5 text-xs text-muted" role="status">
          {SOURCE_NOTICE_TEXT[sourceNoticeKind]}
        </div>
      )}
      <div className="mt-0.5 flex items-center gap-0.5 text-xs text-muted">
        <button
          type="button"
          className={clsx(popupButton({ flashed }), 'rounded')}
          aria-label={flashed ? 'Copied' : 'Copy note'}
          onClick={copy}
        >
          {flashed ? <CheckIcon size={12} weight="bold" /> : <CopyIcon size={12} />}
        </button>
        <button
          type="button"
          className={clsx(popupButton(), 'rounded hover:text-error')}
          aria-label="Delete note"
          disabled={disabled}
          onClick={() => onDelete(note)}
        >
          <TrashIcon size={12} />
        </button>
        {showPin && (
          <button
            type="button"
            className={clsx(popupButton(), 'rounded')}
            aria-label="Show source"
            title="Show where this came from"
            disabled={disabled}
            onClick={() => onRevealSource?.(note.id)}
          >
            <PushPinIcon size={12} />
          </button>
        )}
      </div>
    </li>
  );
});

/** The four attributes a run may carry, and nothing else — the colors are the
 *  note's own, the one place the app renders a color it did not pick. */
function runStyle(run: RichTextRun) {
  return {
    fontWeight: run.bold ? 'bold' : undefined,
    fontStyle: run.italic ? 'italic' : undefined,
    color: run.foreground,
    backgroundColor: run.background,
  };
}

function runsToText(runs: readonly RichTextRun[]): string {
  return noteToPlainText({ kind: 'terminal', runs: [...runs] });
}

/** `data` for a typed character; the plain flavor of the clipboard for a paste,
 *  which is all a note ever takes in (docs/specs/notepad.md). */
function inputData(event: InputEvent): string {
  if (event.data != null) return event.data;
  return event.dataTransfer?.getData('text/plain') ?? '';
}

/** The range a `beforeinput` acts on, as offsets into the container's text.
 *  `getTargetRanges()` is the only place a word or line deletion's extent
 *  appears — the document selection is still the bare caret — so it wins
 *  wherever the browser supplies one, and the live selection is the fallback
 *  for the browsers and input types that supply none. */
function targetOffsets(container: HTMLElement, event: InputEvent): { start: number; end: number } {
  const range = event.getTargetRanges?.()[0];
  if (!range || !container.contains(range.startContainer) || !container.contains(range.endContainer)) {
    return selectionOffsets(container);
  }
  return {
    start: textOffsetOf(container, range.startContainer, range.startOffset),
    end: textOffsetOf(container, range.endContainer, range.endOffset),
  };
}

/** The document selection as offsets into the container's text. Anything
 *  anchored outside the note (no selection at all, focus elsewhere) is treated
 *  as a caret at the end, so an edit still lands somewhere sane. */
function selectionOffsets(container: HTMLElement): { start: number; end: number } {
  const end = (container.textContent ?? '').length;
  const selection = window.getSelection?.();
  if (!selection || selection.rangeCount === 0) return { start: end, end };
  const range = selection.getRangeAt(0);
  if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) {
    return { start: end, end };
  }
  return {
    start: textOffsetOf(container, range.startContainer, range.startOffset),
    end: textOffsetOf(container, range.endContainer, range.endOffset),
  };
}

/** A DOM position as a text offset: the length of everything the container
 *  holds before it. The note's container is spans and text only, so the range's
 *  string is exactly the note's text. */
function textOffsetOf(container: HTMLElement, node: Node, offset: number): number {
  const range = document.createRange();
  range.selectNodeContents(container);
  range.setEnd(node, offset);
  return range.toString().length;
}

/**
 * One content mutation applied to a note's text, and where the caret lands.
 * Exported for its unit test: this is the whole semantics of "the first edit
 * converts the note", and every branch of it is one `inputType`.
 */
export function applyPlainEdit(
  text: string,
  { start, end }: { start: number; end: number },
  inputType: string,
  data: string,
): { text: string; caret: number } {
  const from = Math.min(start, end);
  const to = Math.max(start, end);
  const splice = (insert: string, cutFrom = from, cutTo = to) => ({
    text: text.slice(0, cutFrom) + insert + text.slice(cutTo),
    caret: cutFrom + insert.length,
  });

  switch (inputType) {
    case 'insertText':
    case 'insertFromPaste':
    case 'insertReplacementText':
      return splice(data);
    case 'insertParagraph':
    case 'insertLineBreak':
      return splice('\n');
    default:
      if (inputType.startsWith('delete')) {
        const cut = deleteRange(text, from, to, inputType);
        return splice('', cut.from, cut.to);
      }
      // Something we cannot reproduce (a formatting command): convert with the
      // text unchanged and let the plain editor take the next keystroke, rather
      // than guess at an edit.
      return { text, caret: to };
  }
}

/**
 * What a deletion covers. A non-collapsed range *is* the deletion — the browser
 * already resolved it, into `getTargetRanges()` or the selection. A collapsed
 * one is a keystroke whose extent only the input type names, so widen it here;
 * every delete type then goes through the one `splice('')` above. An extent we
 * do not know stays collapsed, which converts the note and edits nothing.
 */
function deleteRange(text: string, from: number, to: number, inputType: string): { from: number; to: number } {
  if (from !== to) return { from, to };
  switch (inputType) {
    case 'deleteContentBackward':
      return { from: previousBoundary(text, from), to };
    case 'deleteContentForward':
      return { from, to: nextBoundary(text, to) };
    case 'deleteWordBackward':
      return { from: wordStart(text, from), to };
    case 'deleteWordForward':
      return { from, to: wordEnd(text, to) };
    case 'deleteSoftLineBackward':
    case 'deleteHardLineBackward':
      return { from: lineStart(text, from), to };
    case 'deleteSoftLineForward':
    case 'deleteHardLineForward':
      return { from, to: lineEnd(text, to) };
    case 'deleteEntireSoftLine':
      return { from: lineStart(text, from), to: lineEnd(text, to) };
    default:
      return { from, to };
  }
}

/** Back over the whitespace before the caret, then over the word before that:
 *  Option/Ctrl+Backspace's extent. A word is never split mid-surrogate-pair
 *  because both halves are non-whitespace and go together. */
function wordStart(text: string, index: number): number {
  return text.slice(0, index).replace(/\s+$/, '').replace(/\S+$/, '').length;
}

/** The mirror after the caret: over the whitespace, then over the word. */
function wordEnd(text: string, index: number): number {
  const suffix = text.slice(index);
  return text.length - suffix.replace(/^\s+/, '').replace(/^\S+/, '').length;
}

/** The start of the caret's line — just past the previous newline, which the
 *  deletion keeps, or the start of the note. */
function lineStart(text: string, index: number): number {
  return index <= 0 ? 0 : text.lastIndexOf('\n', index - 1) + 1;
}

/** The end of the caret's line — the next newline, which the deletion keeps, or
 *  the end of the note. */
function lineEnd(text: string, index: number): number {
  const next = text.indexOf('\n', index);
  return next === -1 ? text.length : next;
}

function previousBoundary(text: string, index: number): number {
  if (index <= 0) return 0;
  const code = text.charCodeAt(index - 1);
  // Step over a whole surrogate pair; half of one is not a character.
  return index >= 2 && code >= 0xdc00 && code <= 0xdfff ? index - 2 : index - 1;
}

function nextBoundary(text: string, index: number): number {
  if (index >= text.length) return text.length;
  const code = text.charCodeAt(index);
  return code >= 0xd800 && code <= 0xdbff && index + 2 <= text.length ? index + 2 : index + 1;
}

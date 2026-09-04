import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { CheckIcon, CopyIcon, PushPinIcon, TrashIcon } from '@phosphor-icons/react';
import { popupButton } from './design';
import { noteToPlainText } from '../lib/notepad/rich-clipboard';
import type { LiveNote, RichTextRun } from '../lib/notepad/types';

/** How long the Copy button shows its check, matching the terminal selection
 *  popup's copy confirmation (`flashCopy`). */
const COPY_FLASH_MS = 700;

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
  /** The note whose pin just failed to resolve; its row says so. */
  sourceUnavailableNoteId?: string | null;
  /** A freshly added note to put the caret in (Add New). */
  autoFocusNoteId?: string | null;
  /** Fires when an editor loses focus, so the owner can prune an untouched
   *  empty note. */
  onNoteBlur?: (noteId: string) => void;
  /** Hold Delete and the pin while a caller is mid-commit (the Archive view
   *  committing staged deletions); Copy stays live since it changes nothing. */
  disabled?: boolean;
}

export function NoteList({
  notes,
  onCopy,
  onDelete,
  onEdit,
  onRevealSource,
  sourceUnavailableNoteId,
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
          sourceUnavailable={sourceUnavailableNoteId === note.id}
          autoFocus={autoFocusNoteId === note.id}
          onNoteBlur={onNoteBlur}
          disabled={disabled}
        />
      ))}
    </ul>
  );
}

function NoteItem({
  note,
  onCopy,
  onDelete,
  onEdit,
  onRevealSource,
  sourceUnavailable,
  autoFocus,
  onNoteBlur,
  disabled,
}: {
  note: LiveNote;
  onCopy: (note: LiveNote) => void;
  onDelete: (note: LiveNote) => void;
  onEdit?: (noteId: string, text: string) => void;
  onRevealSource?: (noteId: string) => void;
  sourceUnavailable: boolean;
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
      event.preventDefault();
      const plainText = runsToText(before);
      const edit = applyPlainEdit(plainText, selectionOffsets(el), input.inputType, inputData(input));
      setPendingCaret(edit.caret);
      onEdit(note.id, edit.text);
    };
    el.addEventListener('beforeinput', handle);
    return () => el.removeEventListener('beforeinput', handle);
  }, [note.id, rich, onEdit]);

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
          contentEditable={editable}
          suppressContentEditableWarning
          tabIndex={editable ? 0 : undefined}
          role={editable ? 'textbox' : undefined}
          aria-multiline={editable ? true : undefined}
          aria-label={editable ? 'Note' : undefined}
          spellCheck={false}
          className="whitespace-pre-wrap break-words font-mono text-sm leading-snug outline-none"
          onBlur={() => onNoteBlur?.(note.id)}
        >
          {rich?.runs.map((run, index) => (
            <span key={index} style={runStyle(run)}>{run.text}</span>
          ))}
        </div>
      )}
      {sourceUnavailable && (
        <div className="mt-0.5 text-xs text-muted" role="status">Source no longer available</div>
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
}

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
    case 'deleteContentBackward':
      return from === to ? splice('', previousBoundary(text, from), to) : splice('');
    case 'deleteContentForward':
      return from === to ? splice('', from, nextBoundary(text, to)) : splice('');
    case 'deleteByCut':
    case 'deleteByDrag':
    case 'deleteWordBackward':
    case 'deleteWordForward':
      return splice('');
    default:
      // Something we cannot reproduce (a composition, a formatting command):
      // convert with the text unchanged and let the plain editor take the next
      // keystroke, rather than guess at an edit.
      return { text, caret: to };
  }
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

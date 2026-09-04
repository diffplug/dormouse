/**
 * @vitest-environment jsdom
 */
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotepadPanel } from './NotepadPanel';
import { applyPlainEdit } from './NoteList';
import { DialogKeyboardContext } from './wall/wall-context';
import { FakePtyAdapter } from '../lib/platform/fake-adapter';
import { setPlatform } from '../lib/platform';
import { setNativeFieldValue } from '../lib/dom';
import {
  addPlainNote,
  addTerminalNote,
  clearAllNotepads,
  getNotes,
  getOpenNotepadId,
  setOpenNotepadId,
} from '../lib/notepad/notepad-store';
import type { RuntimeTerminalSource } from '../lib/notepad/types';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const SURFACE = 'term-1';

let container: HTMLDivElement;
let root: Root;
let platform: FakePtyAdapter;
let dialogKeyboard: ReturnType<typeof vi.fn>;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  platform = new FakePtyAdapter();
  setPlatform(platform);
  dialogKeyboard = vi.fn();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  clearAllNotepads();
  platform.reset();
});

/** Both panels a Wall would mount, so "one notepad per Wall" is observable. */
function renderPanels(ids: string[] = [SURFACE]): void {
  act(() => {
    root.render(
      <StrictMode>
        <DialogKeyboardContext.Provider value={dialogKeyboard}>
          {ids.map((id) => <NotepadPanel key={id} surfaceId={id} />)}
        </DialogKeyboardContext.Provider>
      </StrictMode>,
    );
  });
}

function panel(id = SURFACE): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-notepad-panel-for="${id}"]`);
}

function open(id = SURFACE): void {
  act(() => setOpenNotepadId(id));
}

function noteElements(): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-note-id]'));
}

function click(el: Element | null | undefined): void {
  expect(el).toBeTruthy();
  act(() => { (el as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

function buttonIn(note: HTMLElement, label: string): HTMLButtonElement {
  const button = note.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
  expect(button).not.toBeNull();
  return button!;
}

describe('NotepadPanel — open and close', () => {
  it('renders only for the Surface the store names', () => {
    addPlainNote(SURFACE, 'first');
    addPlainNote('term-2', 'other');
    renderPanels([SURFACE, 'term-2']);

    expect(panel()).toBeNull();
    open();
    expect(panel()).not.toBeNull();
    expect(panel('term-2')).toBeNull();

    // The store holds one open id, so opening the second closes the first.
    open('term-2');
    expect(panel()).toBeNull();
    expect(panel('term-2')).not.toBeNull();
  });

  it('stays hidden on a host with no notepad', () => {
    // Pocket ships no archive port; the whole affordance goes with it.
    setPlatform({ ...platform, notepadArchive: undefined } as unknown as FakePtyAdapter);
    addPlainNote(SURFACE, 'first');
    renderPanels();
    open();

    expect(panel()).toBeNull();
  });

  it('closes on Escape', () => {
    addPlainNote(SURFACE, 'first');
    renderPanels();
    open();

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(getOpenNotepadId()).toBeNull();
    expect(panel()).toBeNull();
  });

  it('closes on an outside mousedown but not on its own', () => {
    addPlainNote(SURFACE, 'first');
    renderPanels();
    open();

    act(() => {
      noteElements()[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(panel()).not.toBeNull();

    act(() => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(panel()).toBeNull();
  });

  it('closes on its close button', () => {
    renderPanels();
    open();

    click(container.querySelector('[aria-label="Close notepad"]'));

    expect(getOpenNotepadId()).toBeNull();
  });

  it('owns the keyboard while open, and hands it back on close', () => {
    renderPanels();
    open();
    expect(dialogKeyboard).toHaveBeenCalledWith(true);

    dialogKeyboard.mockClear();
    act(() => setOpenNotepadId(null));
    expect(dialogKeyboard).toHaveBeenCalledWith(false);
  });

  it('keeps its keystrokes out of the surface underneath', () => {
    // The Wall's own handler stands down via DialogKeyboardContext above; this
    // is the other half — a pane body's React key handling never sees them.
    const paneKeyDown = vi.fn();
    addPlainNote(SURFACE, 'first');
    act(() => {
      root.render(
        <DialogKeyboardContext.Provider value={dialogKeyboard}>
          <div onKeyDown={paneKeyDown}>
            <NotepadPanel surfaceId={SURFACE} />
          </div>
        </DialogKeyboardContext.Provider>,
      );
    });
    open();

    act(() => {
      noteElements()[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'k', bubbles: true }));
    });

    expect(paneKeyDown).not.toHaveBeenCalled();
  });
});

describe('NotepadPanel — notes', () => {
  it('lists notes in creation order and adds new ones at the bottom', () => {
    addPlainNote(SURFACE, 'first');
    addPlainNote(SURFACE, 'second');
    renderPanels();
    open();

    expect(noteElements().map((el) => el.querySelector('textarea')?.value)).toEqual(['first', 'second']);

    click(container.querySelector('[aria-label="Add new note"]'));

    expect(noteElements()).toHaveLength(3);
    expect(getNotes(SURFACE).map((note) => note.content)).toEqual([
      { kind: 'plain', text: 'first' },
      { kind: 'plain', text: 'second' },
      { kind: 'plain', text: '' },
    ]);
  });

  it('writes edits straight through to the store', () => {
    addPlainNote(SURFACE, 'first');
    renderPanels();
    open();

    const textarea = noteElements()[0].querySelector('textarea')!;
    act(() => setNativeFieldValue(textarea, 'first edited'));

    expect(getNotes(SURFACE)[0].content).toEqual({ kind: 'plain', text: 'first edited' });
  });

  it('copies a note to the clipboard and flashes a check', () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    addPlainNote(SURFACE, 'copy me');
    renderPanels();
    open();

    click(buttonIn(noteElements()[0], 'Copy note'));

    expect(writeText).toHaveBeenCalledWith('copy me');
    // The check replaces the copy glyph for the flash window, and the label
    // says so for a screen reader.
    expect(buttonIn(noteElements()[0], 'Copied').className).toContain('animate-copy-flash');
    vi.unstubAllGlobals();
  });

  it('deletes a note', () => {
    addPlainNote(SURFACE, 'first');
    addPlainNote(SURFACE, 'second');
    renderPanels();
    open();

    click(buttonIn(noteElements()[0], 'Delete note'));

    expect(getNotes(SURFACE).map((note) => note.content)).toEqual([{ kind: 'plain', text: 'second' }]);
  });

  it('prunes an untouched empty note on blur, and keeps one with text', () => {
    renderPanels();
    open();
    click(container.querySelector('[aria-label="Add new note"]'));

    act(() => {
      noteElements()[0].querySelector('textarea')!.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(getNotes(SURFACE)).toHaveLength(0);

    click(container.querySelector('[aria-label="Add new note"]'));
    const textarea = noteElements()[0].querySelector('textarea')!;
    act(() => setNativeFieldValue(textarea, 'typed'));
    act(() => { textarea.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });

    expect(getNotes(SURFACE).map((note) => note.content)).toEqual([{ kind: 'plain', text: 'typed' }]);
  });

  it('prunes an untouched empty note when the panel closes', () => {
    addPlainNote(SURFACE, 'kept');
    renderPanels();
    open();
    click(container.querySelector('[aria-label="Add new note"]'));
    expect(getNotes(SURFACE)).toHaveLength(2);

    act(() => setOpenNotepadId(null));

    expect(getNotes(SURFACE).map((note) => note.content)).toEqual([{ kind: 'plain', text: 'kept' }]);
  });
});

describe('NotepadPanel — rich notes', () => {
  const RUNS = [
    { text: 'ok ', bold: true as const, foreground: '#00ff00' },
    { text: 'done', italic: true as const },
  ];

  function richNote(): HTMLElement {
    const el = noteElements()[0].querySelector<HTMLElement>('[role="textbox"]');
    expect(el).not.toBeNull();
    return el!;
  }

  function caretAt(el: HTMLElement, offset: number): void {
    // Every run is one text node, so the caret is placed by walking them.
    let remaining = offset;
    for (const child of Array.from(el.childNodes)) {
      const length = child.textContent?.length ?? 0;
      if (remaining <= length) {
        const range = document.createRange();
        range.setStart(child.firstChild ?? child, remaining);
        range.collapse(true);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
        return;
      }
      remaining -= length;
    }
    throw new Error(`offset ${offset} is past the note`);
  }

  function beforeInput(el: HTMLElement, inputType: string, data: string | null = null): void {
    act(() => {
      el.dispatchEvent(new InputEvent('beforeinput', { inputType, data, bubbles: true, cancelable: true }));
    });
  }

  it('renders runs as styled spans, never as markup', () => {
    addTerminalNote(SURFACE, [{ text: '<script>', bold: true }]);
    renderPanels();
    open();

    const spans = richNote().querySelectorAll('span');
    expect(spans).toHaveLength(1);
    expect(spans[0].textContent).toBe('<script>');
    expect(spans[0].style.fontWeight).toBe('bold');
    expect(richNote().querySelector('script')).toBeNull();
  });

  it('does not convert when the caret only moves through it', () => {
    addTerminalNote(SURFACE, RUNS);
    renderPanels();
    open();

    const el = richNote();
    caretAt(el, 3);
    act(() => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      document.dispatchEvent(new Event('selectionchange'));
    });

    expect(getNotes(SURFACE)[0].content.kind).toBe('terminal');
  });

  it('converts to plain on the first typed character, at the caret', () => {
    addTerminalNote(SURFACE, RUNS);
    renderPanels();
    open();

    caretAt(richNote(), 3);
    beforeInput(richNote(), 'insertText', '!');

    expect(getNotes(SURFACE)[0].content).toEqual({ kind: 'plain', text: 'ok !done' });
    const textarea = noteElements()[0].querySelector('textarea')!;
    expect(textarea.selectionStart).toBe(4);
  });

  it('converts on a deletion, removing the character before the caret', () => {
    addTerminalNote(SURFACE, RUNS);
    renderPanels();
    open();

    caretAt(richNote(), 3);
    beforeInput(richNote(), 'deleteContentBackward');

    expect(getNotes(SURFACE)[0].content).toEqual({ kind: 'plain', text: 'okdone' });
    expect(noteElements()[0].querySelector('textarea')!.selectionStart).toBe(2);
  });

  it('pastes as plain text', () => {
    addTerminalNote(SURFACE, RUNS);
    renderPanels();
    open();

    caretAt(richNote(), 7);
    const event = new InputEvent('beforeinput', {
      inputType: 'insertFromPaste',
      bubbles: true,
      cancelable: true,
    });
    // jsdom's InputEvent takes no dataTransfer; the flavor is what matters.
    Object.defineProperty(event, 'dataTransfer', {
      value: { getData: (type: string) => (type === 'text/plain' ? '+pasted' : '') },
    });
    act(() => { richNote().dispatchEvent(event); });

    expect(getNotes(SURFACE)[0].content).toEqual({ kind: 'plain', text: 'ok done+pasted' });
  });
});

describe('NotepadPanel — source pins', () => {
  /** Markers from a terminal instance this test never registers, so the pin is
   *  guaranteed to fail — which is the path with UI of its own. */
  function deadSource(): RuntimeTerminalSource {
    const marker = { id: 0, line: 0, isDisposed: false, dispose() {}, onDispose: () => ({ dispose() {} }) };
    return {
      terminalId: SURFACE,
      startMarker: marker,
      endMarker: marker,
      startColumn: 0,
      endColumn: 4,
      shape: 'linewise',
      expectedRawText: 'gone',
    } as unknown as RuntimeTerminalSource;
  }

  it('shows the pin only on a note that has a source', () => {
    addPlainNote(SURFACE, 'no source here');
    addTerminalNote(SURFACE, [{ text: 'gone' }], deadSource());
    renderPanels();
    open();

    expect(container.querySelectorAll('[aria-label="Show source"]')).toHaveLength(1);
    expect(noteElements()[1].querySelector('[aria-label="Show source"]')).not.toBeNull();
  });

  it('reopens with a message when the source is gone', () => {
    addTerminalNote(SURFACE, [{ text: 'gone' }], deadSource());
    renderPanels();
    open();

    click(container.querySelector('[aria-label="Show source"]'));

    expect(getOpenNotepadId()).toBe(SURFACE);
    expect(panel()!.textContent).toContain('Source no longer available');
    // The failure is terminal for the pin, so the button goes with it.
    expect(container.querySelector('[aria-label="Show source"]')).toBeNull();

    // A message belongs to the panel that reported it.
    act(() => setOpenNotepadId(null));
    open();
    expect(panel()!.textContent).not.toContain('Source no longer available');
  });
});

describe('applyPlainEdit', () => {
  const at = (offset: number) => ({ start: offset, end: offset });

  it('replaces a selection with the typed text', () => {
    expect(applyPlainEdit('abcdef', { start: 4, end: 1 }, 'insertText', 'X')).toEqual({ text: 'aXef', caret: 2 });
  });

  it('turns a new paragraph into a newline', () => {
    expect(applyPlainEdit('ab', at(1), 'insertParagraph', '')).toEqual({ text: 'a\nb', caret: 2 });
  });

  it('deletes forward and backward one character', () => {
    expect(applyPlainEdit('abc', at(2), 'deleteContentBackward', '')).toEqual({ text: 'ac', caret: 1 });
    expect(applyPlainEdit('abc', at(2), 'deleteContentForward', '')).toEqual({ text: 'ab', caret: 2 });
  });

  it('never leaves half a surrogate pair behind', () => {
    const text = `a${'\u{1f600}'}b`;
    expect(applyPlainEdit(text, at(3), 'deleteContentBackward', '')).toEqual({ text: 'ab', caret: 1 });
    expect(applyPlainEdit(text, at(1), 'deleteContentForward', '')).toEqual({ text: 'ab', caret: 1 });
  });

  it('leaves the text alone for an edit it cannot reproduce', () => {
    // The note still converts — the plain editor takes whatever comes next.
    expect(applyPlainEdit('abc', at(1), 'formatBold', '')).toEqual({ text: 'abc', caret: 1 });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NoteContent } from './types';
import { copyNoteToClipboard, noteToHtml, noteToPlainText } from './rich-clipboard';

class FakeClipboardItem {
  constructor(readonly data: Record<string, Blob>) {}
}

const write = vi.fn<(items: unknown[]) => Promise<void>>();
const writeText = vi.fn<(text: string) => Promise<void>>();

/** The one ClipboardItem the last `write` call carried. */
function writtenItem(): FakeClipboardItem {
  expect(write).toHaveBeenCalledTimes(1);
  const [items] = write.mock.calls[0];
  expect(items).toHaveLength(1);
  return items[0] as FakeClipboardItem;
}

const RICH: NoteContent = {
  kind: 'terminal',
  runs: [
    { text: 'error: ', bold: true, foreground: '#ff0000' },
    { text: '<a & b>' },
  ],
};

beforeEach(() => {
  write.mockReset().mockResolvedValue(undefined);
  writeText.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal('ClipboardItem', FakeClipboardItem);
  vi.stubGlobal('navigator', { clipboard: { write, writeText } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('noteToPlainText', () => {
  it('returns a plain note verbatim', () => {
    expect(noteToPlainText({ kind: 'plain', text: 'a\nb' })).toBe('a\nb');
  });

  it('concatenates the runs of a terminal note', () => {
    expect(noteToPlainText(RICH)).toBe('error: <a & b>');
  });
});

describe('noteToHtml', () => {
  it('wraps everything in a whitespace-preserving container', () => {
    expect(noteToHtml({ kind: 'plain', text: 'x  y\nz' }))
      .toBe('<pre style="white-space:pre-wrap">x  y\nz</pre>');
  });

  it('escapes the four dangerous characters in every chunk', () => {
    const content: NoteContent = {
      kind: 'terminal',
      runs: [{ text: '<script>' }, { text: ' & "quoted"', bold: true }],
    };
    expect(noteToHtml(content)).toBe(
      '<pre style="white-space:pre-wrap">&lt;script&gt;'
      + '<span style="font-weight:bold"> &amp; &quot;quoted&quot;</span></pre>',
    );
  });

  it('escapes an ampersand once, not twice', () => {
    expect(noteToHtml({ kind: 'plain', text: '&lt;' }))
      .toBe('<pre style="white-space:pre-wrap">&amp;lt;</pre>');
  });

  it('emits only the four supported attributes, in a fixed order', () => {
    const content: NoteContent = {
      kind: 'terminal',
      runs: [{ text: 'x', bold: true, italic: true, foreground: '#0dbc79', background: '#1e1e1e' }],
    };
    expect(noteToHtml(content)).toBe(
      '<pre style="white-space:pre-wrap"><span style="font-weight:bold;font-style:italic;'
      + 'color:#0dbc79;background-color:#1e1e1e">x</span></pre>',
    );
  });

  it('leaves an unstyled run as bare escaped text', () => {
    expect(noteToHtml({ kind: 'terminal', runs: [{ text: 'plain' }] }))
      .toBe('<pre style="white-space:pre-wrap">plain</pre>');
  });

  it.each([
    'red',
    '#FF0000',
    '#f00',
    '#ff000',
    'rgb(255,0,0)',
    '#ff0000; --evil: 1',
    'url(javascript:alert(1))',
  ])('drops a color that is not exactly #rrggbb (%s)', (color) => {
    const html = noteToHtml({ kind: 'terminal', runs: [{ text: 'x', foreground: color }] });
    expect(html).toBe('<pre style="white-space:pre-wrap">x</pre>');
  });
});

describe('copyNoteToClipboard', () => {
  it('writes both flavors for a terminal note', async () => {
    await copyNoteToClipboard(RICH);

    const item = writtenItem();
    expect(Object.keys(item.data)).toEqual(['text/plain', 'text/html']);
    await expect(item.data['text/plain'].text()).resolves.toBe('error: <a & b>');
    await expect(item.data['text/html'].text()).resolves.toBe(noteToHtml(RICH));
    expect(item.data['text/html'].type).toBe('text/html');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('writes plain text only for a plain note', async () => {
    await copyNoteToClipboard({ kind: 'plain', text: 'just words' });
    expect(write).not.toHaveBeenCalled();
    expect(writeText).toHaveBeenCalledWith('just words');
  });

  it('falls back to plain text when ClipboardItem is unavailable', async () => {
    vi.stubGlobal('ClipboardItem', undefined);
    await copyNoteToClipboard(RICH);
    expect(write).not.toHaveBeenCalled();
    expect(writeText).toHaveBeenCalledWith('error: <a & b>');
  });

  it('falls back to plain text when the clipboard has no write()', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    await copyNoteToClipboard(RICH);
    expect(writeText).toHaveBeenCalledWith('error: <a & b>');
  });

  it('falls back to plain text when the rich write is rejected', async () => {
    write.mockRejectedValue(new Error('not allowed'));
    await copyNoteToClipboard(RICH);
    expect(write).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith('error: <a & b>');
  });

  it('swallows a failing fallback rather than throwing at the caller', async () => {
    vi.stubGlobal('ClipboardItem', undefined);
    writeText.mockRejectedValue(new Error('document not focused'));
    await expect(copyNoteToClipboard(RICH)).resolves.toBeUndefined();
  });
});

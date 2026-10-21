// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { openCopyEditor, setCopyFormat } from './copy-editor';
import { finalizedSelection } from './copy-text-fixtures';
import { __resetMouseSelectionForTests, getMouseSelectionState, offerProgramCopy, setSelection } from './mouse-selection';
import { watchSelection } from './selection-watch';

/** Cancel-on-change, compared on each render (docs/specs/mouse-and-clipboard.md
 *  §3.4); `terminal-lifecycle.selection.test.ts` covers the resize. */

const live: Terminal[] = [];
afterEach(() => {
  for (const terminal of live.splice(0)) terminal.dispose();
  __resetMouseSelectionForTests();
});

const write = (terminal: Terminal, data: string) => new Promise<void>((resolve) => terminal.write(data, resolve));

async function watched(id: string) {
  const terminal = new Terminal({ cols: 20, rows: 5, allowProposedApi: true });
  live.push(terminal);
  await write(terminal, 'abcd efgh\r\nother\r\n');
  const watch = watchSelection(id, terminal);
  setSelection(id, finalizedSelection({ endCol: 3 })); // `abcd`
  return { terminal, watch };
}

describe('watchSelection', () => {
  it('cancels a selection on the render that finds its cells changed', async () => {
    const { terminal, watch } = await watched('w-1');
    await write(terminal, '\x1b[2;1HOTHER');
    watch.onRender();
    expect(getMouseSelectionState('w-1').selection).not.toBeNull();
    await write(terminal, '\x1b[1;2HX');
    watch.onRender();
    expect(getMouseSelectionState('w-1').selection).toBeNull();
    watch.dispose();
  });

  it.each([
    ['linewise', {}],
    ['block', { shape: 'block' }],
    ['program', { owner: 'program' }],
  ] as const)('carries a %s selection when older scrollback is trimmed', async (kind, over) => {
    const id = 'trim-' + kind;
    const terminal = new Terminal({ cols: 20, rows: 3, scrollback: 3, allowProposedApi: true });
    live.push(terminal);
    await write(terminal, 'old0\r\nold1\r\nkeep A\r\nkeep B\r\ntail0\r\ntail1');
    const watch = watchSelection(id, terminal);
    setSelection(id, finalizedSelection({ startRow: 2, endRow: 3, endCol: 5, ...over }));
    openCopyEditor(id, terminal);
    if (kind === 'program') {
      offerProgramCopy(id, 'source text');
      setCopyFormat(id, 'program');
    }
    const markers = terminal.markers.map((m) => m.id);
    await write(terminal, '\r\ntail2');
    watch.onRender();
    expect(getMouseSelectionState(id).selection).toMatchObject({ startRow: 1, endRow: 2, endCol: 5 });
    // Following the trim reuses the markers that moved with it.
    expect(terminal.markers.map((m) => m.id)).toEqual(markers);
    expect(getMouseSelectionState(id).copyEditor).not.toBeNull();
    if (kind === 'program') {
      expect(getMouseSelectionState(id)).toMatchObject({ programCopy: 'source text', copyEditor: { format: 'program' } });
    }
    await write(terminal, '\r\ntail3\r\ntail4');
    watch.onRender();
    expect(getMouseSelectionState(id).selection).toBeNull();
    watch.dispose();
  });

  it('cancels trimmed selected rows even when their replacements have identical text', async () => {
    const terminal = new Terminal({ cols: 20, rows: 3, scrollback: 1, allowProposedApi: true });
    live.push(terminal);
    await write(terminal, 'same\r\nsame\r\nsame\r\nsame');
    const watch = watchSelection('trim-identical', terminal);
    setSelection('trim-identical', finalizedSelection({ endCol: 3 }));
    await write(terminal, '\r\nsame');
    watch.onRender();
    expect(getMouseSelectionState('trim-identical').selection).toBeNull();
    watch.dispose();
  });

  it('releases its anchor and stops watching once disposed', async () => {
    const { terminal, watch } = await watched('w-2');
    expect(terminal.markers).toHaveLength(3);
    watch.dispose();
    expect(terminal.markers).toHaveLength(0);
    setSelection('w-2', finalizedSelection({ endCol: 2 }));
    expect(terminal.markers).toHaveLength(0);
  });
});

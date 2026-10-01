// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { finalizedSelection } from './copy-text-fixtures';
import { __resetMouseSelectionForTests, getMouseSelectionState, setSelection } from './mouse-selection';
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

  it('releases its anchor and stops watching once disposed', async () => {
    const { terminal, watch } = await watched('w-2');
    expect(terminal.markers).toHaveLength(2);
    watch.dispose();
    expect(terminal.markers).toHaveLength(0);
    setSelection('w-2', finalizedSelection({ endCol: 2 }));
    expect(terminal.markers).toHaveLength(0);
  });
});

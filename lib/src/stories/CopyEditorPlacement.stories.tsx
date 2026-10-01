import type { Meta, StoryObj } from '@storybook/react';
import { expect, waitFor } from 'storybook/test';
import type { Terminal } from '@xterm/xterm';
import { Wall } from '../components/Wall';
import { openCopyEditor, setCopyFormat } from '../lib/copy-editor';
import { selectionBand, type CopyEditorSide } from '../lib/copy-editor-placement';
import { leaves, normalizeWeights, type LathNode } from '../lib/lath/model';
import type { LathPersistedLayout } from '../lib/lath/persistence';
import { setSelection } from '../lib/mouse-selection';
import { flattenScenario, SCENARIO_SHELL_PROMPT } from '../lib/platform';
import { getTerminalInstance, getTerminalOverlayDims, refitSession } from '../lib/terminal-registry';
import { requireElement, settleTerminals } from './settle-terminals';

// The copy editor placed in a real Wall filling the window
// (docs/specs/mouse-and-clipboard.md §4.5): each story selects rows of the
// source pane and checks the side the editor took.

const SOURCE = 'copy-placement-source';
type Layout = 'single' | 'source-over-peer' | 'peer-over-source' | 'two-columns' | 'three-columns' | 'narrow-source';
interface Props {
  layout: Layout;
  /** The selected rows of the source's grid, as fractions of its height. */
  from: number;
  to: number;
  /** Fill every row with text, rather than the few lines a short reply has. */
  fill: boolean;
  exact: boolean;
  expected: CopyEditorSide;
}

const leaf = (id: string): LathNode => ({ kind: 'leaf', id });
const split = (dir: 'row' | 'col', nodes: LathNode[], weights = nodes.map(() => 1)): LathNode => ({ kind: 'split', dir, children: normalizeWeights(nodes.map((node, i) => ({ node, weight: weights[i] }))) });
const LAYOUTS: Record<Layout, LathNode> = {
  single: leaf(SOURCE),
  'source-over-peer': split('col', [leaf(SOURCE), leaf('peer')]),
  'peer-over-source': split('col', [leaf('peer'), leaf(SOURCE)]),
  'two-columns': split('row', [leaf(SOURCE), leaf('peer')]),
  'three-columns': split('row', [leaf(SOURCE), leaf('peer'), leaf('peer-2')]),
  'narrow-source': split('row', [leaf(SOURCE), leaf('peer')], [1, 5]),
};
function boot(layout: Layout): LathPersistedLayout {
  const root = LAYOUTS[layout];
  return { version: 1, tree: { root }, leafMeta: Object.fromEntries(leaves({ root }).map((id) => [id, { component: 'terminal', tabComponent: 'terminal', title: id === SOURCE ? 'Source terminal' : 'Neighbor terminal' }])) };
}

function PlacementWall({ layout }: Props) {
  return (
    <div className="flex flex-col" style={{ width: '100vw', height: '100vh' }}>
      <Wall key={layout} restoredLathLayout={boot(layout)} initialMode="passthrough" />
    </div>
  );
}

function sourceTerminal(): Terminal {
  const term = getTerminalInstance(SOURCE);
  if (!term) throw new Error('the source terminal never mounted');
  return term;
}

const write = (term: Terminal, data: string) => new Promise<void>((resolve) => term.write(data, resolve));
const editor = () => document.querySelector<HTMLElement>(`[data-copy-editor-for="${SOURCE}"]`);
const sourcePane = () => document.querySelector<HTMLElement>(`[data-lath-leaf="${SOURCE}"]`)!;

async function place({ from, to, fill, exact, expected }: Props): Promise<{ box: DOMRect; pane: DOMRect }> {
  await settleTerminals();
  const term = sourceTerminal();
  refitSession(SOURCE);
  await waitFor(() => expect(term.rows).toBeGreaterThan(8));
  const reply = ['$ git log --oneline -3', '762a1a0 Count a portaled copy editor as part of its pane', '52941de Add the copy editor placement and eased motion', '58308d6 Simplify the reflow-following selection'];
  const lines = fill ? Array.from({ length: term.rows }, (_, i) => `${String(i + 1).padStart(2)}  the quick brown fox jumps over the lazy dog`) : reply;
  // Clear the screen and park the lines from its top row down.
  await write(term, `\x1b[2J\x1b[H${lines.join('\r\n')}`);
  const top = term.buffer.active.viewportY;
  const last = term.rows - 1;
  const startRow = top + Math.round(from * last);
  const endRow = top + Math.round(to * last);
  setSelection(SOURCE, { startRow, startCol: 0, endRow, endCol: term.cols - 1, shape: 'linewise', dragging: false, startedInScrollback: false });
  openCopyEditor(SOURCE, term);
  if (exact) setCopyFormat(SOURCE, 'exact');
  await requireElement(`[data-copy-editor-for="${SOURCE}"]`, 'copy editor');
  await waitFor(() => expect(editor()!.dataset.copyEditorSide).toBe(expected));

  const dims = getTerminalOverlayDims(SOURCE)!;
  const span = { start: { row: startRow, col: 0 }, end: { row: endRow, col: term.cols - 1 }, block: false };
  const band = selectionBand(dims, [span]);
  const box = editor()!.getBoundingClientRect();
  const pane = sourcePane().getBoundingClientRect();
  // Every spot but the overlay keeps clear of the text being copied.
  if (expected === 'overlay') expect(box.top).toBeLessThan(band.bottom);
  else expect(box.bottom <= band.top + 1 || box.top >= band.bottom - 1 || box.left >= pane.right - 1 || box.right <= pane.left + 1).toBe(true);
  if (expected === 'right' || expected === 'squish-right') expect(box.left).toBeGreaterThanOrEqual(pane.right);
  expect(box.width).toBeGreaterThan(0);
  expect(box.height).toBeGreaterThan(0);
  return { box, pane };
}

const passed = (canvasElement: HTMLElement) => {
  canvasElement.dataset.placementCheck = 'passed';
};

const meta = {
  title: 'App/Copy editor placement',
  component: PlacementWall,
  // The selection store outlives a story: a replay must open its own editor.
  beforeEach: () => {
    setSelection(SOURCE, null);
    return () => setSelection(SOURCE, null);
  },
  args: { layout: 'single', from: 0, to: 0, fill: false, exact: false, expected: 'below' },
  parameters: { layout: 'fullscreen', fakePty: { scenario: flattenScenario(SCENARIO_SHELL_PROMPT) } },
  play: async ({ args, canvasElement }) => {
    await place(args);
    passed(canvasElement);
  },
} satisfies Meta<typeof PlacementWall>;
export default meta;
type Story = StoryObj<typeof meta>;

/** A selection at the source's last rows: the editor hugs it from below,
 *  spilling over the neighbor under the source. */
export const BelowOverNeighbor: Story = {
  args: { layout: 'source-over-peer', from: 0, to: 1, expected: 'below' },
  play: async ({ args, canvasElement }) => {
    const { box, pane } = await place(args);
    expect(box.bottom).toBeGreaterThan(pane.bottom);
    passed(canvasElement);
  },
};

/** The same selection with the source at the window's bottom: no room below,
 *  so above. */
export const Above: Story = { args: { layout: 'peer-over-source', from: 0, to: 1, expected: 'above' } };

/** A selection as tall as the pane, between neighbors: beside the pane, on
 *  the roomier side. */
export const Side: Story = { args: { layout: 'three-columns', from: 0, to: 1, expected: 'right' } };

/** Every row of the left column, too many lines to hold whole anywhere: the
 *  side beside it has the most room, so it squishes there to the window's height. */
export const SquishedBeside: Story = {
  args: { layout: 'two-columns', from: 0, to: 1, fill: true, exact: true, expected: 'squish-right' },
  play: async ({ args, canvasElement }) => {
    const { box } = await place(args);
    expect(box.height).toBeGreaterThan(window.innerHeight / 2);
    passed(canvasElement);
  },
};

/** Too many lines for either side whole: squished into the roomier, above. */
export const Squished: Story = { args: { layout: 'single', from: 0.4, to: 0.8, fill: true, exact: true, expected: 'squish-above' } };

/** Every row selected, every line kept: no spot left but over the selection. */
export const Overlay: Story = { args: { layout: 'single', from: 0, to: 1, fill: true, exact: true, expected: 'overlay' } };

/** One short row of a pane narrower than the editor's header and footer: the
 *  editor widens past the pane and its line to show every control whole. */
export const NarrowPane: Story = {
  args: { layout: 'narrow-source', from: 0, to: 0, expected: 'below' },
  play: async ({ args, canvasElement }) => {
    const { box, pane } = await place(args);
    expect(box.width).toBeGreaterThan(pane.width);
    const shown = Array.from(editor()!.querySelectorAll('button')).filter((b) => !b.closest('[inert]'));
    const options = shown.filter((b) => b.hasAttribute('aria-pressed'));
    const copy = shown.find((b) => b.textContent === 'Copy');
    expect(copy).toBeDefined();
    for (const control of [...options, copy!]) {
      const r = control.getBoundingClientRect();
      expect(r.left).toBeGreaterThanOrEqual(box.left);
      expect(r.right).toBeLessThanOrEqual(box.right);
    }
    // No scope or format scrolled out of its segment.
    for (const segment of new Set(options.map((b) => b.parentElement!))) expect(segment.scrollWidth).toBeLessThanOrEqual(segment.clientWidth);
    passed(canvasElement);
  },
};

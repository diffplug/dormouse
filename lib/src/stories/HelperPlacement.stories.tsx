import type { Meta, StoryObj } from '@storybook/react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { Wall } from '../components/Wall';
import { disposeHelper, getHelper } from '../lib/helper-terminal';
import { getTerminalInstance, refitSession } from '../lib/terminal-registry';
import { flattenScenario, SCENARIO_SHELL_PROMPT } from '../lib/platform';
import { leaves, normalizeWeights, type LathNode } from '../lib/lath/model';
import type { LathPersistedLayout } from '../lib/lath/persistence';
import { requireElement, settleTerminals } from './settle-terminals';

const SOURCE = 'placement-source';
type Layout = 'single' | 'columns' | 'rows' | 'grid' | 'uneven';
type Props = { layout: Layout; width: number; height: number; sourceAtEnd: boolean; cursor: 'top' | 'bottom'; zoomed: boolean };
const leaf = (id: string): LathNode => ({ kind: 'leaf', id });
const split = (dir: 'row' | 'col', nodes: LathNode[], weights = nodes.map(() => 1)): LathNode => ({ kind: 'split', dir, children: normalizeWeights(nodes.map((node, i) => ({ node, weight: weights[i] }))) });
function boot({ layout, sourceAtEnd }: Props): LathPersistedLayout {
  const pair = sourceAtEnd ? [leaf('peer'), leaf(SOURCE)] : [leaf(SOURCE), leaf('peer')];
  const root = layout === 'single' ? leaf(SOURCE)
    : layout === 'rows' ? split('col', pair)
    : layout === 'grid' ? split('row', [split('col', pair), split('col', [leaf('peer-2'), leaf('peer-3')])])
    : split('row', pair, layout === 'uneven' ? [2, 1] : undefined);
  return { version: 1, tree: { root }, leafMeta: Object.fromEntries(leaves({ root }).map(id => [id, { component: 'terminal', tabComponent: 'terminal', title: id === SOURCE ? 'Source terminal' : 'Neighbor terminal' }])) };
}
function PlacementWall(props: Props) {
  return <div data-placement-frame className="flex shrink-0 flex-col" style={{ width: props.width, height: props.height }}>
    <Wall key={`${props.layout}-${props.sourceAtEnd}`} restoredLathLayout={boot(props)} initialMode="passthrough" />
  </div>;
}

function terminal(id: string) {
  const term = getTerminalInstance(id);
  if (!term) throw new Error(`Terminal ${id} never mounted`);
  return term;
}
const sourcePane = () => document.querySelector<HTMLElement>(`[data-lath-leaf="${SOURCE}"]`)!;
const context = () => document.querySelector<HTMLElement>('[data-terminal-context]')!;
const rect = (element: Element) => {
  const { x, y, width, height } = element.getBoundingClientRect();
  return { x, y, width, height };
};
function expectContained(element: Element, parent: Element) {
  const a = element.getBoundingClientRect();
  const b = parent.getBoundingClientRect();
  expect(a.width).toBeGreaterThan(0);
  expect(a.height).toBeGreaterThan(0);
  expect(a.left).toBeGreaterThanOrEqual(b.left - 1);
  expect(a.top).toBeGreaterThanOrEqual(b.top - 1);
  expect(a.right).toBeLessThanOrEqual(b.right + 1);
  expect(a.bottom).toBeLessThanOrEqual(b.bottom + 1);
}
async function rightClickSourceHeader() {
  const header = await requireElement(`[data-pane-header-for="${SOURCE}"]`, 'source header');
  header.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
  await requireElement('[data-helper-terminal] .xterm', 'helper terminal');
}
async function openContext() {
  await rightClickSourceHeader();
  await waitFor(() => expect(getHelper(SOURCE)?.status).toBe('completed'));
  await settleTerminals();
}
function expectedSide({ layout, zoomed, cursor, sourceAtEnd }: Props) {
  // Alone in the Wall, the helper avoids the cursor; beside a neighbor, it takes the neighbor's side.
  if (zoomed || layout === 'single') return cursor === 'top' ? 'bottom' : 'top';
  if (layout === 'grid') return 'right';
  if (layout === 'rows') return sourceAtEnd ? 'top' : 'bottom';
  return sourceAtEnd ? 'left' : 'right';
}
async function prepare(args: Props) {
  await settleTerminals();
  if (args.zoomed) {
    await userEvent.click(within(sourcePane()).getByRole('button', { name: 'Zoom' }));
    await waitFor(() => expect(sourcePane().getBoundingClientRect().width).toBeGreaterThan(args.width * 0.8));
  }
  const source = terminal(SOURCE);
  refitSession(SOURCE);
  await waitFor(() => expect(source.rows).toBeGreaterThan(4));
  // Real xterm cursor positioning, sampled by production code when context opens.
  const row = args.cursor === 'top' ? 2 : source.rows - 1;
  await new Promise<void>(resolve => source.write(`\x1b[${row};1Hsource cursor here`, resolve));
  const before = rect(sourcePane());
  const size = { cols: source.cols, rows: source.rows };
  const expectSourceUnchanged = () => {
    expect(rect(sourcePane())).toEqual(before);
    expect({ cols: source.cols, rows: source.rows }).toEqual(size);
  };
  await openContext();
  expectSourceUnchanged();
  await waitFor(() => expect(document.querySelector('[data-ring="outline"]')).toHaveAttribute('data-context-union', 'true'));
  const ring = document.querySelector('[data-ring="outline"]')!.closest('svg')!.parentElement!;
  expectContained(context(), ring);
  expectContained(sourcePane(), ring);
  // Keyboard focus on the container must not add a second browser-native ring.
  await userEvent.tab();
  context().focus();
  expect(getComputedStyle(context()).outlineStyle).toBe('none');
  const actions = context().querySelector('[data-context-header-actions]')!;
  const close = within(actions as HTMLElement).getByRole('button', { name: 'Close terminal context' }).getBoundingClientRect();
  for (const button of actions.querySelectorAll('button')) {
    expect(button.getBoundingClientRect().top).toBe(close.top);
    expectContained(button, context());
  }
  expectContained(context(), document.querySelector('.lath-host')!);
  expect(context().dataset.contextSide).toBe(expectedSide(args));
  if (args.layout === 'grid' && !args.zoomed) {
    expect(within(context()).getByRole('button', { name: 'Place helper at right' })).toBeVisible();
    expect(within(context()).getByRole('button', { name: 'Place helper at bottom' })).toBeVisible();
  }
  if (!args.zoomed && args.layout !== 'single') {
    const a = context().getBoundingClientRect();
    const b = sourcePane().getBoundingClientRect();
    const overlap = { right: b.right - a.left, left: a.right - b.left, bottom: b.bottom - a.top, top: a.bottom - b.top };
    expect(overlap[expectedSide(args)]).toBeCloseTo(16);
  } else {
    const a = context().getBoundingClientRect();
    const b = sourcePane().getBoundingClientRect();
    expect(a.left - b.left).toBeCloseTo(16);
    expect(b.right - a.right).toBeCloseTo(16);
    expect(a.top - b.top).toBeGreaterThanOrEqual(16);
    expect(b.bottom - a.bottom).toBeGreaterThanOrEqual(16);
    expect(expectedSide(args) === 'top' ? a.top - b.top : b.bottom - a.bottom).toBeCloseTo(16);
  }
  return { expectSourceUnchanged };
}

const meta = {
  title: 'App/Helper placement',
  component: PlacementWall,
  // Argos replays stories for capture; unfinished input from the preceding run
  // must not turn this run's fresh-helper fixture into a preserved helper.
  beforeEach: () => { disposeHelper(SOURCE); },
  args: { layout: 'single', width: 1100, height: 780, sourceAtEnd: false, cursor: 'bottom', zoomed: false },
  parameters: { layout: 'fullscreen', fakePty: { scenario: flattenScenario(SCENARIO_SHELL_PROMPT) }, primedTerminalState: { byId: { [SOURCE]: { cwd: { path: '/home/demo/projects/dormouse', pathKind: 'posix', isRemote: false, source: 'osc633', updatedAt: 0 } } } }, chromatic: { viewports: [1200] } },
  play: async ({ args, canvasElement }) => { await prepare(args); canvasElement.dataset.placementCheck = 'passed'; },
} satisfies Meta<typeof PlacementWall>;
export default meta;
type Story = StoryObj<typeof meta>;

export const TwoColumns: Story = { args: { layout: 'columns' } };
export const RightColumn: Story = { args: { layout: 'columns', sourceAtEnd: true } };
export const TwoRows: Story = { args: { layout: 'rows' } };
export const BottomRow: Story = { args: { layout: 'rows', sourceAtEnd: true } };
export const Grid: Story = { args: { layout: 'grid' } };
export const UnevenColumns: Story = { args: { layout: 'uneven' } };
export const CursorAtTop: Story = { args: { cursor: 'top' } };
export const CursorAtBottom: Story = {};
export const ZoomedPane: Story = { args: { layout: 'grid', zoomed: true } };
export const NarrowWindow: Story = { args: { width: 294, height: 620 } };
export const ShortWindow: Story = { args: { width: 580, height: 310 } };

/** Real xterm input and browser pointer focus, through the same controls as users. */
export const PreserveInputAndFocus: Story = {
  play: async ({ args, canvasElement, step }) => {
    const { expectSourceUnchanged } = await prepare(args);
    const helper = getHelper(SOURCE)!;
    const input = terminal(helper.id);
    const element = input.element!;
    const unfinished = 'echo keep-this-input';
    const bufferText = () => Array.from({ length: input.buffer.active.length }, (_, i) => input.buffer.active.getLine(i)?.translateToString(true) ?? '').join('\n');
    const checkInput = () => {
      expect(getHelper(SOURCE)?.id).toBe(helper.id);
      expect(terminal(helper.id)).toBe(input);
      expect(input.element).toBe(element);
      expect(bufferText()).toContain(unfinished);
      expectContained(context(), canvasElement.querySelector('.lath-host')!);
    };
    await step('Type unfinished input and switch sides without resizing the source', async () => {
      input.focus();
      await userEvent.keyboard(unfinished);
      await waitFor(() => expect(bufferText()).toContain(unfinished));
      const focused = document.activeElement;
      await userEvent.click(within(context()).getByRole('button', { name: 'Place helper at bottom' }));
      await waitFor(() => expect(context().dataset.contextSide).toBe('bottom'));
      expect(document.activeElement).toBe(focused);
      expectSourceUnchanged();
      checkInput();
    });
    await step('Resize the Wall without replacing the helper or dropping focus', async () => {
      const frame = canvasElement.querySelector<HTMLElement>('[data-placement-frame]')!;
      const focused = document.activeElement;
      const oldColumns = input.cols;
      frame.style.width = '840px';
      frame.style.height = '660px';
      await waitFor(() => expect(input.cols).toBeLessThan(oldColumns));
      expect(document.activeElement).toBe(focused);
      expect(context().dataset.contextSide).toBe('bottom');
      checkInput();
    });
    await step('Close and reopen the retained helper, then return to Auto', async () => {
      await userEvent.click(within(context()).getByRole('button', { name: 'Close terminal context' }));
      await waitFor(() => expect(document.querySelector('[data-terminal-context]')).toBeNull());
      const resizedSource = rect(sourcePane());
      await rightClickSourceHeader();
      expect(context().dataset.contextSide).toBe('bottom');
      expect(rect(sourcePane())).toEqual(resizedSource);
      checkInput();
      input.focus();
      const focused = document.activeElement;
      await userEvent.click(within(context()).getByRole('button', { name: 'Use automatic helper placement' }));
      await waitFor(() => expect(within(context()).getByRole('button', { name: 'Use automatic helper placement' })).toBeDisabled());
      expect(context().dataset.contextSide).toBe('top');
      expect(document.activeElement).toBe(focused);
      checkInput();
    });
    canvasElement.dataset.placementCheck = 'passed';
  },
};

export const TwoColumnsDark: Story = { args: { layout: 'columns' }, globals: { theme: 'Dark (Visual Studio)' } };

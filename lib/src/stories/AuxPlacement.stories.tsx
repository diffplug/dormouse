import type { Meta, StoryObj } from '@storybook/react';
import { surfaceIdFor } from 'dor/protocol';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { Wall } from '../components/Wall';
import { TERMINAL_CONTEXT_TEETH_PX } from '../components/design';
import { disposeAux, getAux } from '../lib/aux-terminal';
import { flushTerminal, getTerminalInstance, refitSession } from '../lib/terminal-registry';
import { FakePtyAdapter, getPlatform, SCENARIO_SHELL_PROMPT } from '../lib/platform';
import { flattenScenario } from './fake-scenarios';
import { leaves, normalizeWeights, type LathNode } from '../lib/lath/model';
import type { LathPersistedLayout } from '../lib/lath/persistence';
import type { ContextMode } from '../components/wall/wall-context';
import { requireElement, settleTerminalContext, settleTerminals } from './settle-terminals';

type Layout = 'single' | 'columns' | 'rows' | 'grid' | 'uneven' | 'wide-bottom';
/** `via`: a right-click on the source's header, or `!` in command mode. */
type Props = { layout: Layout; width: number; height: number; sourceAtEnd: boolean; cursor: 'top' | 'bottom'; zoomed: boolean; mode: ContextMode; via: 'click' | 'key' };
const SOURCE = 'source';
type Shape = Pick<Props, 'layout' | 'sourceAtEnd'>;
const split = (dir: 'row' | 'col', nodes: LathNode[], weights = nodes.map(() => 1)): LathNode => ({ kind: 'split', dir, children: normalizeWeights(nodes.map((node, i) => ({ node, weight: weights[i] }))) });
/** The layout's tree, each leaf built from its role by `leaf`. */
function shape({ layout, sourceAtEnd }: Shape, leaf: (role: string) => LathNode): LathNode {
  const pair = sourceAtEnd ? [leaf('peer'), leaf(SOURCE)] : [leaf(SOURCE), leaf('peer')];
  return layout === 'single' ? leaf(SOURCE)
    : layout === 'wide-bottom' ? split('col', [split('row', [leaf('peer'), leaf('peer-2')]), leaf(SOURCE)], [1.08, 1])
    : layout === 'rows' ? split('col', pair)
    : layout === 'grid' ? split('row', [split('col', pair), split('col', [leaf('peer-2'), leaf('peer-3')])])
    : split('row', pair, layout === 'uneven' ? [2, 1] : undefined);
}
/** The roles in tree order, which is how a restored Wall numbers its panes `surface:1` onward. */
const roles = (props: Shape) => leaves({ root: shape(props, role => ({ kind: 'leaf', id: role })) });
const idOf = (props: Shape, role: string) => surfaceIdFor(roles(props).indexOf(role) + 1);
const sourceId = (props: Shape) => idOf(props, SOURCE);
function boot(props: Props): LathPersistedLayout {
  const root = shape(props, role => ({ kind: 'leaf', id: idOf(props, role) }));
  const source = sourceId(props);
  return { version: 1, tree: { root }, leafMeta: Object.fromEntries(leaves({ root }).map(id => [id, { component: 'terminal', tabComponent: 'terminal', title: id === source ? 'Source terminal' : 'Neighbor terminal' }])) };
}
function PlacementWall(props: Props) {
  return <div data-placement-frame className="flex shrink-0 flex-col" style={{ width: props.width, height: props.height }}>
    <Wall key={`${props.layout}-${props.sourceAtEnd}-${props.via}`} restoredLathLayout={boot(props)} initialMode={props.via === 'key' ? 'command' : 'passthrough'} />
  </div>;
}

function terminal(id: string) {
  const term = getTerminalInstance(id);
  if (!term) throw new Error(`Terminal ${id} never mounted`);
  return term;
}
const sourcePane = (source: string) => document.querySelector<HTMLElement>(`[data-lath-leaf="${source}"]`)!;
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
/** Right-click opens properties, the aux terminal a switch away; `!` opens the aux terminal itself. */
async function rightClickSourceHeader(source: string, mode: ContextMode = 'aux', via: Props['via'] = 'click') {
  (getPlatform() as FakePtyAdapter).setProcessCwd(source, '/home/demo/projects/dormouse');
  const header = await requireElement(`[data-pane-header-for="${source}"]`, 'source header');
  if (via === 'key') await userEvent.keyboard('!');
  else {
    header.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
    await requireElement('[data-context-mode="properties"]', 'terminal context properties');
    if (mode === 'properties') return;
    await userEvent.click(within(context()).getByRole('button', { name: 'Show aux terminal' }));
  }
  await requireElement('[data-aux-terminal] .xterm', 'aux terminal');
  const aux = getAux(source)!;
  // Fitting after output changes wrapping and can clip xterm's current prompt
  // line, which no later wait repairs. Release the fake shell only once it has
  // its actual mounted grid (`fake-adapter-aux.test.ts` pins the deferral).
  refitSession(aux.id);
  (getPlatform() as FakePtyAdapter).resumeAuxStartup(aux.id);
}
async function openContext(source: string, mode: ContextMode, via: Props['via']) {
  await rightClickSourceHeader(source, mode, via);
  await settleTerminalContext();
  // Properties alone never start the aux terminal.
  if (mode === 'properties') { expect(getAux(source)).toBeUndefined(); return; }
  const aux = getAux(source)!;
  // Drain xterm's async parsing before the paint gate captures a wrapped narrow terminal.
  let written = false;
  void flushTerminal(aux.id).then(() => { written = true; });
  await waitFor(() => expect(written).toBe(true), { timeout: 4000 });
  await settleTerminals();
  const input = terminal(aux.id);
  const text = Array.from({ length: input.buffer.active.length }, (_, i) =>
    input.buffer.active.getLine(i)?.translateToString(true) ?? '').join('');
  // An aux terminal starts its shell and runs nothing: one prompt, wrapped cursor line included.
  expect(text.match(/\/home\/demo\/projects\/dormouse ❯/g)).toHaveLength(1);
  expect(input.buffer.active.viewportY).toBe(input.buffer.active.baseY);
}
/** Whether the context covers its source rather than sitting beside it: alone in the Wall, or
 *  opened on properties (a right-click) where its only room is below. */
const covers = ({ layout, zoomed, sourceAtEnd, via }: Props) => zoomed || layout === 'single' || (via === 'click' && layout === 'rows' && !sourceAtEnd);
function expectedSide(args: Props) {
  const { layout, cursor, sourceAtEnd, via } = args;
  // Covering, it takes the top half, but from `!` avoids the cursor; beside a neighbor, it takes the neighbor's side.
  if (covers(args)) return via === 'key' && cursor === 'top' ? 'bottom' : 'top';
  if (layout === 'grid') return 'right';
  if (layout === 'wide-bottom') return 'top';
  if (layout === 'rows') return sourceAtEnd ? 'top' : 'bottom';
  return sourceAtEnd ? 'left' : 'right';
}
async function prepare(args: Props) {
  const id = sourceId(args);
  await settleTerminals();
  if (args.zoomed) {
    await userEvent.click(within(sourcePane(id)).getByRole('button', { name: 'Zoom' }));
    await waitFor(() => expect(sourcePane(id).getBoundingClientRect().width).toBeGreaterThan(args.width * 0.8));
  }
  const source = terminal(id);
  refitSession(id);
  await waitFor(() => expect(source.rows).toBeGreaterThan(4));
  // Real xterm cursor positioning, sampled by production code when context opens.
  const row = args.cursor === 'top' ? 2 : source.rows - 1;
  await new Promise<void>(resolve => source.write(`\x1b[${row};1Hsource cursor here`, resolve));
  const before = rect(sourcePane(id));
  const size = { cols: source.cols, rows: source.rows };
  const expectSourceUnchanged = () => {
    expect(rect(sourcePane(id))).toEqual(before);
    expect({ cols: source.cols, rows: source.rows }).toEqual(size);
  };
  await openContext(id, args.mode, args.via);
  expectSourceUnchanged();
  await waitFor(() => expect(document.querySelector('[data-ring="outline"]')).toHaveAttribute('data-context-union', 'true'));
  const ring = document.querySelector('[data-ring="outline"]')!.closest('svg')!.parentElement!;
  expectContained(context(), ring);
  expectContained(sourcePane(id), ring);
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
  const side = expectedSide(args);
  expect(context().dataset.contextSide).toBe(side);
  if (args.layout === 'grid' && !args.zoomed) {
    expect(within(context()).getByRole('button', { name: 'Place context at right' })).toBeVisible();
    expect(within(context()).getByRole('button', { name: 'Place context at bottom' })).toBeVisible();
  }
  const a = context().getBoundingClientRect();
  const b = sourcePane(id).getBoundingClientRect();
  if (!covers(args)) {
    const overlap = { right: b.right - a.left, left: a.right - b.left, bottom: b.bottom - a.top, top: a.bottom - b.top };
    // Only the teeth reach over the source, and they face it.
    expect(overlap[side]).toBeCloseTo(TERMINAL_CONTEXT_TEETH_PX);
    expect(context().dataset.contextTeeth).toBe({ right: 'left', left: 'right', bottom: 'top', top: 'bottom' }[side]);
  } else {
    // A covering aux terminal lies flush on the source's edges, teeth toward the half it leaves visible.
    expect(a.left - b.left).toBeCloseTo(0);
    expect(b.right - a.right).toBeCloseTo(0);
    expect(side === 'top' ? a.top - b.top : b.bottom - a.bottom).toBeCloseTo(0);
    expect(context().dataset.contextTeeth).toBe(side === 'top' ? 'bottom' : 'top');
  }
  return { expectSourceUnchanged };
}

const meta = {
  title: 'App/Aux placement',
  component: PlacementWall,
  // Argos replays stories for capture; unfinished input from the preceding run
  // must not turn this run's fresh-aux-terminal fixture into a used aux terminal.
  beforeEach: ({ args }) => {
    for (const role of roles(args)) disposeAux(idOf(args, role));
    const platform = getPlatform() as FakePtyAdapter;
    platform.deferAuxStartup = true;
    return () => { platform.deferAuxStartup = false; };
  },
  args: { layout: 'single', width: 1100, height: 780, sourceAtEnd: false, cursor: 'bottom', zoomed: false, mode: 'aux', via: 'click' },
  parameters: { layout: 'fullscreen', fakePty: { scenario: flattenScenario(SCENARIO_SHELL_PROMPT) } },
  play: async ({ args }) => { await prepare(args); },
} satisfies Meta<typeof PlacementWall>;
export default meta;
type Story = StoryObj<typeof meta>;
/** A story whose source reports the demo shell's directory; which Surface that is depends on the layout. */
const story = ({ args = {}, parameters, ...rest }: Story = {}): Story => ({
  ...rest,
  args,
  parameters: { ...parameters, primedTerminalState: { byId: { [sourceId({ ...meta.args, ...args })]: { cwd: { path: '/home/demo/projects/dormouse', pathKind: 'posix', isRemote: false, source: 'osc633', updatedAt: 0 } } } } },
});

export const TwoColumns = story({ args: { layout: 'columns' } });
export const RightColumn = story({ args: { layout: 'columns', sourceAtEnd: true } });
export const TwoRows = story({ args: { layout: 'rows' } });
export const BottomRow = story({ args: { layout: 'rows', sourceAtEnd: true } });
export const WideBottomRow = story({ args: { layout: 'wide-bottom' }, globals: { theme: 'Dark (Visual Studio)' } });
export const Grid = story({ args: { layout: 'grid' } });
export const UnevenColumns = story({ args: { layout: 'uneven' } });
/** From `!`, a covering context keeps clear of the cursor. */
export const CursorAtTop = story({ args: { cursor: 'top', via: 'key' } });
export const CursorAtBottom = story({ args: { via: 'key' } });
/** From a click it covers the top half wherever the cursor is, under the header clicked. */
export const CoveringFromClick = story({ args: { cursor: 'top' } });
export const ZoomedPane = story({ args: { layout: 'grid', zoomed: true } });
export const NarrowWindow = story({ args: { width: 294, height: 620 } });
export const ShortWindow = story({ args: { width: 580, height: 310 } });

/** Real xterm input and browser pointer focus, through the same controls as users. */
export const PreserveInputAndFocus = story({
  play: async ({ args, canvasElement, step }) => {
    const source = sourceId(args);
    const { expectSourceUnchanged } = await prepare(args);
    const aux = getAux(source)!;
    const input = terminal(aux.id);
    const element = input.element!;
    const unfinished = 'echo keep-this-input';
    const bufferText = () => Array.from({ length: input.buffer.active.length }, (_, i) => input.buffer.active.getLine(i)?.translateToString(true) ?? '').join('\n');
    const checkInput = () => {
      expect(getAux(source)?.id).toBe(aux.id);
      expect(terminal(aux.id)).toBe(input);
      expect(input.element).toBe(element);
      expect(bufferText()).toContain(unfinished);
      expectContained(context(), canvasElement.querySelector('.lath-host')!);
    };
    await step('Type unfinished input and switch sides without resizing the source', async () => {
      input.focus();
      await userEvent.keyboard(unfinished);
      await waitFor(() => expect(bufferText()).toContain(unfinished));
      const focused = document.activeElement;
      await userEvent.click(within(context()).getByRole('button', { name: 'Place context at bottom' }));
      await waitFor(() => expect(context().dataset.contextSide).toBe('bottom'));
      expect(document.activeElement).toBe(focused);
      expectSourceUnchanged();
      checkInput();
    });
    await step('Resize the Wall without replacing the aux terminal or dropping focus', async () => {
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
    await step('Close and reopen the retained aux terminal above, as properties open, then select the bottom side', async () => {
      await userEvent.click(within(context()).getByRole('button', { name: 'Close terminal context' }));
      await waitFor(() => expect(document.querySelector('[data-terminal-context]')).toBeNull());
      const resizedSource = rect(sourcePane(source));
      await rightClickSourceHeader(source);
      // The right-click opened properties, which never go below, though below was chosen before.
      expect(context().dataset.contextSide).toBe('top');
      expect(rect(sourcePane(source))).toEqual(resizedSource);
      checkInput();
      input.focus();
      const focused = document.activeElement;
      await userEvent.click(within(context()).getByRole('button', { name: 'Place context at bottom' }));
      await waitFor(() => expect(within(context()).getByRole('button', { name: 'Place context at bottom' })).toHaveAttribute('aria-pressed', 'true'));
      expect(context().dataset.contextSide).toBe('bottom');
      expect(document.activeElement).toBe(focused);
      checkInput();
    });
  },
});

/** Properties are only as tall as their rows, held to the edge their teeth share with the source. */
export const PropertiesAbove = story({ args: { layout: 'wide-bottom', mode: 'properties' } });
export const PropertiesBeside = story({ args: { layout: 'columns', mode: 'properties' } });
/** Properties never go below on their own: with room only there, they cover the source's top half. */
export const PropertiesNeverBelow = story({ args: { layout: 'rows', mode: 'properties' } });
/** `!` opens the terminal below where that is the room; switching to properties keeps it there. */
export const AuxBelowFromKey = story({
  args: { layout: 'rows', via: 'key' },
  play: async ({ args }) => {
    await prepare(args);
    await userEvent.click(within(context()).getByRole('button', { name: 'Show properties' }));
    await waitFor(() => expect(context().dataset.contextMode).toBe('properties'));
    expect(context().dataset.contextSide).toBe('bottom');
  },
});
export const PropertiesCovering = story({ args: { cursor: 'top', mode: 'properties' } });

export const TwoColumnsDark = story({ args: { layout: 'columns' }, globals: { theme: 'Dark (Visual Studio)' } });

import type { Meta, StoryObj } from '@storybook/react';
import { surfaceIdFor } from 'dor/protocol';
import { Wall } from '../components/Wall';
import { SCENARIO_SHELL_PROMPT } from '../lib/platform';
import { flattenScenario, SCENARIO_LS_OUTPUT } from './fake-scenarios';
import { getTerminalInstance, type ActivityState } from '../lib/terminal-registry';
import { IFRAME_ALLOW, IFRAME_SANDBOX } from '../lib/iframe-policy';
import { requireElement, settleTerminalContext, settleTerminals, waitForCondition } from './settle-terminals';

const meta: Meta<typeof Wall> = {
  title: 'App/Wall',
  component: Wall,
  // Hold every snapshot until the terminals have written their scenario and painted.
  // Stories that define their own `play` override this and call `settleTerminals()`
  // themselves at the end.
  play: () => settleTerminals(),
};

export default meta;
type Story = StoryObj<typeof Wall>;

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const paneCount = () => document.querySelectorAll('[data-pane-header-for]').length;
const doorCount = () => document.querySelectorAll('[data-door-id]').length;

/**
 * Wait for a count to reach `want`, and throw if it never does.
 *
 * Every helper below drives the Wall through the UI a user would, and each step
 * lands asynchronously — a split re-lays out the tree, a minimize moves a pane to
 * the baseboard and the Baseboard then measures its Doors. Sleeping a fixed
 * number of milliseconds and continuing regardless is what made these snapshots
 * unstable: on a slow runner the next step drives the pre-update DOM, and the
 * story captures a layout it never meant to build. Counts are relative to what
 * was on screen when the step started, so the same helper serves stories that
 * begin with different shapes.
 */
async function expectCount(count: () => number, want: number, what: string) {
  await waitForCondition(() => count() === want, { message: () => `expected ${want} ${what}, saw ${count()}` });
}

/**
 * Return to command mode with the leader chord — left Shift then right Shift
 * within 500ms (`lib/dual-tap.ts`).
 *
 * Required between splits: a split is an intent to use the new terminal, so
 * `addSplitPanel` enters passthrough, and the wall ignores pane shortcuts there.
 * Without the chord the second split key is typed into the terminal instead, and
 * the story quietly builds one pane fewer than it means to.
 */
function enterCommandMode() {
  for (const location of [1, 2]) {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', location, bubbles: true }));
  }
}

function withPrimedActivity(byId: Record<string, Partial<ActivityState>>) {
  return {
    primedSessionState: {
      byId,
    },
  };
}

async function splitPanes() {
  // The Wall must be live before it can act on a keystroke; settling its terminals
  // is the readiness signal (it also covers the primed-state gate).
  await settleTerminals();
  const panesBefore = paneCount();
  window.dispatchEvent(new KeyboardEvent('keydown', { key: '"', bubbles: true }));
  await expectCount(paneCount, panesBefore + 1, 'panes after the vertical split');
  enterCommandMode();
  window.dispatchEvent(new KeyboardEvent('keydown', { key: '%', bubbles: true }));
  await expectCount(paneCount, panesBefore + 2, 'panes after the horizontal split');
  // No trailing Enter: the second split already left the wall in passthrough on
  // the pane it created, which is the resting state these stories capture.
}

async function minimizeSelectedPane() {
  await settleTerminals();
  const doorsBefore = doorCount();
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', bubbles: true }));
  await expectCount(doorCount, doorsBefore + 1, 'doors after minimizing');
}

async function minimizeFirstVisiblePane() {
  const doorsBefore = doorCount();
  const button = await requireElement<HTMLButtonElement>(
    'button[aria-label="Minimize"]',
    'pane Minimize button',
  );
  button.click();
  await expectCount(doorCount, doorsBefore + 1, 'doors after minimizing');
}

async function openAlertDialog() {
  const header = await requireElement<HTMLElement>('[data-pane-header-for]', 'pane header');
  header.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
  await settleTerminalContext();
}

export const Default: Story = {
  parameters: { fakePty: { scenario: flattenScenario(SCENARIO_SHELL_PROMPT) } },
};

export const MultiPane: Story = {
  parameters: { fakePty: { scenario: flattenScenario(SCENARIO_LS_OUTPUT) } },
  play: async () => {
    await splitPanes();
    await settleTerminals();
  },
};

export const WithDoors: Story = {
  parameters: { fakePty: { scenario: flattenScenario(SCENARIO_LS_OUTPUT) } },
  play: async () => {
    await splitPanes();
    await minimizeFirstVisiblePane();
    await minimizeFirstVisiblePane();
    await settleTerminals();
  },
};

/** `ls -la` typed in command mode: `l` raises the stray-key prompt, which
 *  swallows the rest, so the `-` never splits. */
export const StrayKeyPrompt: Story = {
  parameters: { fakePty: { scenario: flattenScenario(SCENARIO_SHELL_PROMPT) } },
  play: async () => {
    await settleTerminals();
    const panesBefore = paneCount();
    for (const key of 'ls -la') window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    await requireElement('[data-stray-key-prompt]', 'stray-key prompt');
    if (paneCount() !== panesBefore) throw new Error(`a stray word split the Wall: ${paneCount()} panes`);
    await settleTerminals();
  },
};

export const AlertRingingDoor: Story = {
  args: {
    initialPaneIds: ['surface:1'],
  },
  parameters: {
    fakePty: { scenario: flattenScenario(SCENARIO_SHELL_PROMPT) },
    ...withPrimedActivity({
      'surface:1': {
        status: 'ALERT_RINGING',
        todo: false,
      },
    }),
  },
  play: async () => {
    await minimizeSelectedPane();
    await wait(100);
    await settleTerminals();
  },
};

export const AlertModalOpen: Story = {
  args: {
    initialPaneIds: ['surface:1'],
  },
  parameters: {
    fakePty: { scenario: flattenScenario(SCENARIO_SHELL_PROMPT) },
    ...withPrimedActivity({
      'surface:1': {
        status: 'ALERT_RINGING',
        todo: false,
      },
    }),
  },
  play: async () => {
    // Settle first: the context reports the primed ALERT_RINGING status, so
    // opening it earlier would snapshot a wall whose alert rows are still cold.
    await settleTerminals();
    await openAlertDialog();
  },
};

export const MinimizedRingingSession: Story = {
  args: {
    initialPaneIds: ['surface:1'],
  },
  parameters: {
    fakePty: { scenario: flattenScenario(SCENARIO_SHELL_PROMPT) },
    ...withPrimedActivity({
      'surface:1': {
        status: 'ALERT_RINGING',
        todo: true,
      },
    }),
  },
  play: async () => {
    await minimizeSelectedPane();
    await wait(100);
    await settleTerminals();
  },
};

export const MultipleRingingSessions: Story = {
  args: {
    initialPaneIds: ['surface:1', 'surface:2', 'surface:3'],
  },
  parameters: {
    fakePty: { scenario: flattenScenario(SCENARIO_SHELL_PROMPT) },
    ...withPrimedActivity({
      'surface:1': {
        status: 'ALERT_RINGING',
        todo: false,
      },
      'surface:2': {
        status: 'ALERT_RINGING',
        todo: true,
      },
      'surface:3': {
        status: 'NOTHING_TO_SHOW',
        todo: false,
      },
    }),
  },
};

/** Real context and helper lifecycle, backed by the deterministic demo shell. */
export const TerminalContext: Story = {
  args: { initialPaneIds: ['surface:1'], initialMode: 'passthrough' },
  parameters: { fakePty: { scenario: SCENARIO_SHELL_PROMPT } },
  play: async () => {
    await settleTerminals();
    const header = await requireElement('[data-pane-header-for="surface:1"]', 'terminal header');
    header.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
    await settleTerminalContext();
  },
};

/** Same-direction splits remain one weighted row, independent of creation order. */
function flatRowArgs(count: number) {
  const ids = Array.from({ length: count }, (_, i) => surfaceIdFor(i + 1));
  return {
    initialPaneIds: ids,
    restoredLathLayout: {
      version: 1,
      tree: { root: { kind: 'split', dir: 'row', children: ids.map(id => ({ node: { kind: 'leaf', id }, weight: 1 / ids.length })) } },
      leafMeta: Object.fromEntries(ids.map(id => [id, { component: 'terminal', tabComponent: 'terminal', title: id }])),
    },
  };
}

export const ThreePaneSplits: Story = {
  args: flatRowArgs(3),
  parameters: {
    fakePty: { scenario: flattenScenario(SCENARIO_SHELL_PROMPT) },
    docs: { description: { story: 'Drag a header to a pane edge, pause, then slide along the edge to widen the drop from one pane to the whole row. Every two-plus-one arrangement is available from this flat three-pane row.' } },
  },
};

export const ContiguousGroupDrop: Story = {
  args: flatRowArgs(4),
  parameters: {
    fakePty: { scenario: flattenScenario(SCENARIO_SHELL_PROMPT) },
    docs: { description: { story: 'The dashed outline shows the chosen group; the solid area is the exact drop destination. Pause on an edge, then slide along it to widen or narrow the group.' } },
  },
  play: async () => {
    await settleTerminals();
    const source = await requireElement<HTMLElement>('[data-lath-leaf="surface:4"] .lath-leaf-header', 'drag source');
    const target = await requireElement<HTMLElement>('[data-lath-leaf="surface:2"]', 'drag target');
    const neighbor = await requireElement<HTMLElement>('[data-lath-leaf="surface:3"]', 'slide target');
    const from = source.getBoundingClientRect();
    const to = target.getBoundingClientRect();
    const across = neighbor.getBoundingClientRect();
    source.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: from.x + 20, clientY: from.y + 15 }));
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: to.x + to.width / 2, clientY: to.y + 5 }));
    // The pause anchors the slide; its badge invites widening.
    await waitForCondition(() => document.querySelector('[data-lath-drop-choice]')?.textContent?.includes('slide along the edge') === true);
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: across.x + across.width / 2, clientY: across.y + 5 }));
    await waitForCondition(() => document.querySelector('[data-lath-drop-choice]')?.textContent?.includes('2 panes') === true);
  },
};

/** The self-focusing fixture page under this server's other loopback name: a
 *  cross-site origin, as every Dormouse frame is to its webview. The server
 *  listens on one address family only, so ask which name reaches it. */
async function crossOriginPageUrl(): Promise<string> {
  const path = '/src/stories/fixtures/self-focusing-page.htm';
  for (const host of ['127.0.0.1', '[::1]', 'localhost'].filter((name) => name !== location.hostname)) {
    const url = `${location.protocol}//${host}:${location.port}${path}`;
    try {
      await fetch(url, { mode: 'no-cors', signal: AbortSignal.timeout(2000) });
      return url;
    } catch {
      // Not listening under this name.
    }
  }
  throw new Error(`no other loopback name reaches ${location.host}`);
}

function terminalBesidePage(url: string) {
  return {
    initialPaneIds: ['surface:1', 'surface:2'],
    initialMode: 'command' as const,
    restoredLathLayout: {
      version: 1,
      tree: { root: { kind: 'split', dir: 'row', children: [
        { node: { kind: 'leaf', id: 'surface:1' }, weight: 0.5 },
        { node: { kind: 'leaf', id: 'surface:2' }, weight: 0.5 },
      ] } },
      leafMeta: {
        'surface:1': { component: 'terminal', tabComponent: 'terminal', title: 'surface:1' },
        'surface:2': { component: 'browser', tabComponent: 'surface', title: 'Self-focusing page', params: { url } },
      },
    },
  };
}

/** The page's next steal as this window sees it (its `blur`), or 500 ms,
 *  whichever is first: a page that kept focus steals nothing more. The page
 *  steals every 200 ms, so the fallback only fires when it does keep focus. */
function nextSteal(): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      window.removeEventListener('blur', done);
      resolve();
    };
    const timer = setTimeout(done, 500);
    window.addEventListener('blur', done);
  });
}

/** What the framed page last reported: keys it received, times it took focus. */
function listenToPage(frame: HTMLIFrameElement) {
  const seen = { ready: false, keys: 0, focuses: 0 };
  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== frame.contentWindow || !event.data?.selfFocusingPage) return;
    seen.ready = true;
    seen.keys = event.data.keys;
    seen.focuses = event.data.focuses;
  });
  return seen;
}

/**
 * A minimized browser pane whose page focuses itself every 200 ms gets none of
 * the keys typed into the terminal. Real input throughout: the click into the page opens WebKit's
 * cross-origin focus gate, and the keys are routed by the browser, not
 * dispatched. Outside the Vitest runner there is no real input, so the play
 * stops after rendering.
 */
export const ParkedPageGetsNoKeys: Story = {
  loaders: [async () => ({ pageUrl: await crossOriginPageUrl() })],
  render: (args, { loaded }) => <Wall {...args} {...terminalBesidePage(loaded.pageUrl as string)} />,
  parameters: { fakePty: { scenario: flattenScenario(SCENARIO_SHELL_PROMPT) } },
  play: async () => {
    await settleTerminals();
    const browser = await import('vitest/browser').catch(() => null);
    if (!browser) return;
    const { userEvent } = browser;
    const leaf = await requireElement<HTMLElement>('[data-lath-leaf="surface:2"]', 'page leaf');
    const frame = await requireElement<HTMLIFrameElement>('[data-lath-leaf="surface:2"] iframe', 'page frame');
    if (frame.getAttribute('sandbox') !== IFRAME_SANDBOX || frame.getAttribute('allow') !== IFRAME_ALLOW) {
      throw new Error(`the page frame does not carry the product's sandbox and allow: ${frame.getAttribute('sandbox')} / ${frame.getAttribute('allow')}`);
    }
    const page = listenToPage(frame);
    await waitForCondition(() => page.ready, { message: () => 'the framed page never reported' });

    await userEvent.click(frame);
    await userEvent.click(leaf.querySelector<HTMLElement>('[aria-label="Minimize"]')!);
    await waitForCondition(() => leaf.hasAttribute('data-lath-parked'), { message: () => 'the page pane never parked' });
    const terminal = await requireElement<HTMLElement>('[data-lath-leaf="surface:1"] .xterm-screen', 'terminal pane');
    await userEvent.click(terminal);
    const focusesBefore = page.focuses;
    await waitForCondition(() => page.focuses > focusesBefore, { message: () => 'the parked page never took focus' });

    // Each key goes in just after one of the page's steals, never inside the
    // task the Wall waits before taking focus back: a key typed in that task
    // reaches the page, and the timing of that race is the browser's. The key's
    // RPC must also land before the next steal opens that task again, which the
    // page's 200 ms interval leaves ample room for.
    const typed = 'nothing-for-the-page';
    const focusesAtTyping = page.focuses;
    for (const char of typed) {
      await nextSteal();
      await wait(10);
      await userEvent.keyboard(char);
    }
    const line = () => {
      const buffer = getTerminalInstance('surface:1')?.buffer.active;
      return buffer?.getLine(buffer.cursorY)?.translateToString(true) ?? '';
    };
    await waitForCondition(() => line().includes(typed), { message: () => `the terminal shows "${line()}"; the page received ${page.keys} keys` });
    await wait(200);
    if (page.keys !== 0) throw new Error(`the parked page received ${page.keys} of ${typed.length} keys`);
    if (page.focuses <= focusesAtTyping) throw new Error('the parked page stopped taking focus while the keys were typed');
    // The page keeps stealing focus during capture. Disabling cursor blink alone
    // cannot freeze the resulting block/outline changes; keep both states solid.
    getTerminalInstance('surface:1')!.options.cursorInactiveStyle = 'block';
    await settleTerminals();
  },
};

// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolPanel } from './ToolPanel';

vi.mock('./TerminalPanel', () => ({
  TerminalPanel: () => <div data-testid="terminal">terminal</div>,
}));
vi.mock('./BrowserPanel', () => ({
  BrowserPanel: ({ parked }: { parked?: boolean }) => (
    <div data-testid="browser" data-parked={String(parked === true)}>browser</div>
  ),
}));

const booting = { surfaceType: 'tool', command: 'pnpm storybook', cwd: '/repo' };
const serving = { ...booting, url: 'http://localhost:6006/', renderMode: 'iframe' };

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function show(params: Record<string, unknown>) {
  act(() => {
    root.render(<ToolPanel id="p1" title="t" params={params} />);
  });
}

/** The wrapper the visibility is applied to. */
function half(testId: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (!el?.parentElement) throw new Error(`no ${testId}`);
  return el.parentElement;
}

describe('ToolPanel', () => {
  it('keeps both halves mounted, whichever is forward', () => {
    show(booting);
    expect(container.querySelector('[data-testid="terminal"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="browser"]')).not.toBeNull();
    show(serving);
    expect(container.querySelector('[data-testid="terminal"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="browser"]')).not.toBeNull();
  });

  it('hides with visibility, never display', () => {
    // A display:none container measures zero, so the fit addon would resize the
    // PTY to a degenerate size and reflow the output of the command still
    // running behind the browser.
    show(serving);
    const terminal = half('terminal');
    expect(terminal.style.visibility).toBe('hidden');
    expect(terminal.style.display).not.toBe('none');
    expect(terminal.hasAttribute('hidden')).toBe(false);
  });

  it('shows the terminal and hides the browser before the tool serves', () => {
    show(booting);
    expect(half('terminal').style.visibility).toBe('visible');
    expect(half('browser').style.visibility).toBe('hidden');
  });

  it('flips once it serves, and back when the header pins the terminal', () => {
    show(serving);
    expect(half('browser').style.visibility).toBe('visible');
    show({ ...serving, showTerminal: true });
    expect(half('terminal').style.visibility).toBe('visible');
    expect(half('browser').style.visibility).toBe('hidden');
  });

  it('parks the browser while it is hidden, so a screencast stops decoding', () => {
    show(booting);
    expect(container.querySelector<HTMLElement>('[data-testid="browser"]')?.dataset.parked).toBe('true');
    show(serving);
    expect(container.querySelector<HTMLElement>('[data-testid="browser"]')?.dataset.parked).toBe('false');
  });

  it('keeps the hidden half out of the accessibility tree', () => {
    show(serving);
    expect(half('terminal').getAttribute('aria-hidden')).toBe('true');
    expect(half('browser').getAttribute('aria-hidden')).toBe('false');
  });
});

describe('the port-conflict face', () => {
  const conflicted = { surfaceType: 'tool', command: 'x', cwd: '/repo', toolPortConflict: [6006, 6007] };

  it('shows the conflict where the browser would have gone', () => {
    // With several ports there is nothing to frame, so the second half explains
    // why rather than sitting empty or framing a guess.
    show(conflicted);
    expect(half('terminal').style.visibility).toBe('hidden');
    expect(container.textContent).toContain('opened 2 ports');
    expect(container.textContent).toContain('localhost:6006');
    expect(container.textContent).toContain('localhost:6007');
  });

  it('mounts no browser for a conflict', () => {
    show(conflicted);
    expect(container.querySelector('[data-testid="browser"]')).toBeNull();
  });

  it('flips back to the terminal when the chip pins it', () => {
    show({ ...conflicted, showTerminal: true });
    expect(half('terminal').style.visibility).toBe('visible');
  });
});

describe('the pending-approval face', () => {
  const pending = {
    surfaceType: 'tool',
    command: 'pnpm storybook',
    cwd: '/repo',
    toolPending: {
      name: 'storybook',
      run: 'pnpm storybook',
      path: '/repo/dormouse.yml',
      projectRoot: '/repo',
      cwd: '/repo',
      upstreamUrl: 'https://github.com/diffplug/dormouse',
    },
  };

  it('mounts no terminal, so no shell runs in an unapproved repo', () => {
    // The load-bearing assertion: both halves stay mounted for every other
    // face, and mounting TerminalPanel here would spawn a PTY before the human
    // has allowed anything.
    show(pending);
    expect(container.querySelector('[data-testid="terminal"]')).toBeNull();
    expect(container.querySelector('[data-testid="browser"]')).toBeNull();
  });

  it('names the command it is asking about', () => {
    show(pending);
    expect(container.textContent).toContain('dor tool storybook');
    expect(container.textContent).toContain('pnpm storybook');
  });

  it('offers the upstream and the folder', () => {
    show(pending);
    const labels = [...container.querySelectorAll('button')].map((b) => b.textContent ?? '');
    expect(labels.some((l) => l.includes('upstream https://github.com/diffplug/dormouse'))).toBe(true);
    expect(labels.some((l) => l.includes('folder'))).toBe(true);
    expect(labels.some((l) => l.includes('Disallow and close'))).toBe(true);
  });

  it('omits the upstream button when git resolved no remote', () => {
    show({ ...pending, toolPending: { ...pending.toolPending, upstreamUrl: null } });
    const labels = [...container.querySelectorAll('button')].map((b) => b.textContent ?? '');
    expect(labels.some((l) => l.includes('upstream'))).toBe(false);
    expect(labels.some((l) => l.includes('folder'))).toBe(true);
  });

  it('takes precedence over the terminal pin, since there is no terminal yet', () => {
    show({ ...pending, showTerminal: true });
    expect(container.querySelector('[data-testid="terminal"]')).toBeNull();
  });
});

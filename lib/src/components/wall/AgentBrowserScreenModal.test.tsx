/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentBrowserScreenModal } from './AgentBrowserScreenModal';
import type { ScreenController, ScreenSnapshot } from './agent-browser-screen';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const SNAPSHOT: ScreenSnapshot = {
  state: 'SYNCED',
  renderMode: 'ab-screencast',
  viewport: { w: 1280, h: 720, dpr: 1 },
  paneCss: { w: 1280, h: 720 },
  displayDpr: 1,
  syncEngaged: true,
};

function controller(): ScreenController {
  return {
    id: 'browser-1',
    subscribe: () => () => {},
    snapshot: () => SNAPSHOT,
    actions: {
      engageSync: vi.fn(),
      applyDevice: vi.fn(),
      applyViewport: vi.fn(),
      openModal: vi.fn(),
      setRenderMode: vi.fn(),
    },
    subscribeChrome: () => () => {},
    chrome: () => ({
      url: 'http://localhost:5173/',
      displayUrl: 'localhost:5173',
      title: 'Vite + React',
      key: null,
    }),
    chromeActions: { navigate: vi.fn(), back: vi.fn(), forward: vi.fn(), reload: vi.fn() },
    hostCapable: true,
    canPopOut: true,
  };
}

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

describe('AgentBrowserScreenModal display icons', () => {
  it('composes compact capability and presentation glyphs through the modal hierarchy', () => {
    act(() => root.render(
      <AgentBrowserScreenModal controller={controller()} label="surface:3" onClose={() => {}} />,
    ));

    const option = (title: string) =>
      [...container.querySelectorAll('label')].find((label) =>
        label.textContent?.includes(title),
      );

    expect(option('agent-browser screencast')?.querySelectorAll('svg')).toHaveLength(1);
    expect(option('Resize with pane')?.querySelectorAll('svg')).toHaveLength(1);
    expect(option('Fixed size')?.querySelectorAll('svg')).toHaveLength(1);
    expect(option('agent-browser popout')?.querySelectorAll('svg')).toHaveLength(2);
    expect(option('iframe embed')?.querySelectorAll('svg')).toHaveLength(1);
    expect(option('agent-browser screencast')?.querySelector('[data-agent-capability-icon="robot-wide"]')).not.toBeNull();
    expect(option('agent-browser popout')?.querySelector('[data-agent-capability-icon="robot-wide"]')).not.toBeNull();
    expect(option('iframe embed')?.querySelector('[data-agent-capability-icon]')).toBeNull();

    for (const icon of container.querySelectorAll('label svg')) {
      expect(icon.getAttribute('width')).toBe('14');
      expect(icon.getAttribute('height')).toBe('14');
    }
  });
});

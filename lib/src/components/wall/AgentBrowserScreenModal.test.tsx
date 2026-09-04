/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentBrowserScreenModal } from './AgentBrowserScreenModal';
import { getAgentBrowserScreenController } from './agent-browser-screen';
import { registerStubScreen, STUB_SCREEN } from './wall-test-utils';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

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
    const registration = registerStubScreen('browser-1', {
      snapshot: { ...STUB_SCREEN, renderMode: 'ab-screencast' },
    });
    const controller = getAgentBrowserScreenController('browser-1');
    expect(controller).not.toBeNull();

    act(() => root.render(
      <AgentBrowserScreenModal controller={controller!} label="surface:3" onClose={() => {}} />,
    ));

    const option = (title: string) =>
      [...container.querySelectorAll('label')].find((label) => label.textContent?.includes(title));

    // Only the two agent-browser render options carry the robot; the nested
    // resolution rows and the iframe option are presentation-only.
    for (const [label, glyphs, robot] of [
      ['agent-browser screencast', 1, true],
      ['Resize with pane', 1, false],
      ['Fixed size', 1, false],
      ['agent-browser popout', 2, true],
      ['iframe embed', 1, false],
    ] as const) {
      const row = option(label);
      expect(row, label).toBeDefined();
      expect(row?.querySelectorAll('svg'), label).toHaveLength(glyphs);
      const capability = row?.querySelector('[data-agent-capability-icon="robot-wide"]');
      if (robot) expect(capability, label).not.toBeNull();
      else expect(capability, label).toBeNull();
    }

    for (const icon of container.querySelectorAll('label svg')) {
      expect(icon.getAttribute('width')).toBe('14');
      expect(icon.getAttribute('height')).toBe('14');
    }

    registration.dispose();
  });
});

/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakePtyAdapter, setPlatform } from '../../lib/platform';
import type { PlatformAdapter } from '../../lib/platform/types';
import { AgentBrowserScreenModal } from './AgentBrowserScreenModal';
import { getAgentBrowserScreenController } from './agent-browser-screen';
import { registerStubScreen, STUB_SCREEN } from './wall-test-utils';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  setPlatform(new FakePtyAdapter());
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  setPlatform(new FakePtyAdapter());
});

describe('AgentBrowserScreenModal', () => {
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
      [...document.body.querySelectorAll('label')].find((label) => label.textContent?.includes(title));

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

    for (const icon of document.body.querySelectorAll('label svg')) {
      expect(icon.getAttribute('width')).toBe('14');
      expect(icon.getAttribute('height')).toBe('14');
    }

    registration.dispose();
  });

  it('offers Playwright with its own device registry and dispatches the selected provider', () => {
    const platform: PlatformAdapter = new FakePtyAdapter();
    platform.playwright = async () => ({ ok: true });
    setPlatform(platform);
    const registration = registerStubScreen('playwright', { snapshot: { ...STUB_SCREEN, renderMode: 'pw-screencast' } });
    const controller = getAgentBrowserScreenController('playwright')!;
    act(() => root.render(<AgentBrowserScreenModal controller={controller} label="surface:4" onClose={() => {}} />));
    expect(document.body.textContent).toContain('Playwright screencast');
    expect(document.body.textContent).toContain('iPad Pro 11');
    expect(document.body.textContent).not.toContain('Galaxy S25');
    const popout = [...document.body.querySelectorAll('label')].find(label => label.textContent === 'Playwright popout')!;
    act(() => popout.querySelector<HTMLInputElement>('input')!.click());
    act(() => [...document.body.querySelectorAll('button')].find(button => button.textContent === 'Apply')!.click());
    expect(controller.actions.setRenderMode).toHaveBeenCalledWith('pw-popout');
    registration.dispose();
  });

  it('offers only the render modes the controller declares, whatever the host supports', () => {
    // A tool on a host with every provider: Playwright and popout would strand it.
    const platform: PlatformAdapter = new FakePtyAdapter();
    platform.playwright = async () => ({ ok: true });
    platform.agentBrowserPopOut = async () => ({ ok: true });
    setPlatform(platform);
    const registration = registerStubScreen('tool', {
      snapshot: { ...STUB_SCREEN, renderMode: 'ab-screencast' },
      renderModes: ['ab-screencast', 'iframe'],
    });
    act(() => root.render(
      <AgentBrowserScreenModal controller={getAgentBrowserScreenController('tool')!} label="surface:5" onClose={() => {}} />,
    ));
    const options = [...document.body.querySelectorAll('input[name="render-mode"]')]
      .map((input) => input.closest('label')?.textContent);
    expect(options).toEqual(['agent-browser screencast', 'iframe embed']);
    registration.dispose();
  });

  it('tells the user the embed drops logins, and refuses it for an https:// page on a proxying host', () => {
    const platform: PlatformAdapter = new FakePtyAdapter();
    platform.createIframeProxyUrl = async () => ({ ok: true, url: 'http://127.0.0.1:61234/' });
    setPlatform(platform);
    const iframeRow = () => [...document.body.querySelectorAll('label')].find((label) => label.textContent?.includes('iframe embed'))!;

    const secure = registerStubScreen('secure', {
      snapshot: { ...STUB_SCREEN, renderMode: 'ab-screencast' },
      chrome: { url: 'https://example.com/account', displayUrl: 'example.com/account', title: null, key: null },
    });
    act(() => root.render(<AgentBrowserScreenModal controller={getAgentBrowserScreenController('secure')!} label="surface:5" onClose={() => {}} />));
    expect(document.body.textContent).toContain('no logins/cookies');
    expect(iframeRow().querySelector('input')!.disabled).toBe(true);
    expect(iframeRow().textContent).toContain('the embedded view frames http:// pages only');
    secure.dispose();

    // Nothing but http(s) is framed at all.
    const file = registerStubScreen('file', {
      snapshot: { ...STUB_SCREEN, renderMode: 'ab-screencast' },
      chrome: { url: 'file:///tmp/report.html', displayUrl: 'report.html', title: null, key: null },
    });
    act(() => root.render(<AgentBrowserScreenModal controller={getAgentBrowserScreenController('file')!} label="surface:7" onClose={() => {}} />));
    expect(iframeRow().querySelector('input')!.disabled).toBe(true);
    file.dispose();

    const local = registerStubScreen('local', {
      snapshot: { ...STUB_SCREEN, renderMode: 'ab-screencast' },
      chrome: { url: 'http://localhost:5173/', displayUrl: 'localhost:5173/', title: null, key: null },
    });
    act(() => root.render(<AgentBrowserScreenModal controller={getAgentBrowserScreenController('local')!} label="surface:6" onClose={() => {}} />));
    expect(iframeRow().querySelector('input')!.disabled).toBe(false);
    // The page can move to https after iframe was picked: Apply then stands down.
    act(() => iframeRow().querySelector<HTMLInputElement>('input')!.click());
    const apply = () => [...document.body.querySelectorAll('button')].find((button) => button.textContent === 'Apply')!;
    expect(apply().disabled).toBe(false);
    act(() => local.updateChrome({ url: 'https://example.com/', displayUrl: 'example.com/', title: null, key: null }));
    expect(apply().disabled).toBe(true);
    local.dispose();
  });

  it('keeps resize selected while an engaged sync is transiently scaled', () => {
    const registration = registerStubScreen('browser-transient', {
      snapshot: {
        ...STUB_SCREEN,
        state: 'SCALED',
        renderMode: 'ab-screencast',
        syncEngaged: true,
      },
    });
    const controller = getAgentBrowserScreenController('browser-transient');
    expect(controller).not.toBeNull();

    act(() => root.render(
      <AgentBrowserScreenModal controller={controller!} label="surface:3" onClose={() => {}} />,
    ));

    const optionInput = (title: string) =>
      [...document.body.querySelectorAll('label')]
        .find((label) => label.textContent?.includes(title))
        ?.querySelector<HTMLInputElement>('input[type="radio"]');

    expect(optionInput('Resize with pane')?.checked).toBe(true);
    expect(optionInput('Fixed size')?.checked).toBe(false);

    const apply = [...document.body.querySelectorAll('button')]
      .find((button) => button.textContent === 'Apply');
    act(() => apply?.click());
    expect(controller!.actions.engageSync).toHaveBeenCalledOnce();
    expect(controller!.actions.applyViewport).not.toHaveBeenCalled();

    registration.dispose();
  });
});

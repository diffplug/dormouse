/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AboutPanel, aboutDiagnostics, type AboutFacts } from './AboutSettings';
import { setPlatform } from '../lib/platform';
import { FakePtyAdapter } from '../lib/platform/fake-adapter';
import type { BuildStamp } from '../lib/build-info';

const STAMP: BuildStamp = { version: '1.2.0', commit: 'd080b4f5', commitsSinceVersion: 14, dirty: true, official: false };
const HOSTED = { mode: 'hosted', origin: 'https://relay.dormouse.sh' } as const;
const SELF_HOST = { mode: 'self-host', origin: 'https://relay.example.com' } as const;
const ENV = { platform: 'MacIntel', userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15' };

let container: HTMLDivElement;
let root: Root;
let openExternal: ReturnType<typeof vi.fn>;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const platform = new FakePtyAdapter();
  openExternal = vi.fn();
  platform.openExternal = openExternal;
  setPlatform(platform);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(facts: AboutFacts) {
  await act(async () => root.render(<AboutPanel facts={facts} />));
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((node) => node.textContent?.trim() === label);
  if (!found) throw new Error(`no button reading ${label}`);
  return found;
}

describe('AboutPanel', () => {
  it('names a development build with its commits past the tag and uncommitted changes', async () => {
    await render({ host: 'standalone', stamp: STAMP, relay: HOSTED });
    expect(container.textContent).toContain('Dormouse 1.2.0+14');
    expect(container.textContent).toContain('Development build · d080b4f5, with uncommitted changes · Desktop app');
    await act(async () => button('Source').click());
    expect(openExternal).toHaveBeenCalledWith('https://github.com/diffplug/dormouse/tree/d080b4f5');
  });

  it('links an official release’s source at its tag', async () => {
    await render({ host: 'vscode', stamp: { ...STAMP, commitsSinceVersion: 0, dirty: false, official: true }, relay: HOSTED });
    expect(container.textContent).toContain('Official release');
    expect(container.textContent).toContain('from tag v1.2.0');
    await act(async () => button('Source').click());
    expect(openExternal).toHaveBeenCalledWith('https://github.com/diffplug/dormouse/tree/v1.2.0');
  });

  it('names a self-host build and its Relay ahead of whether it is official', async () => {
    await render({ host: 'standalone', stamp: { ...STAMP, official: true }, relay: SELF_HOST });
    expect(container.textContent).toContain('Self-host build');
    expect(container.textContent).toContain('reach only relay.example.com');
  });

  it('names no kind until the Burrow says whether this is self-host', async () => {
    await render({ host: 'standalone', stamp: STAMP, relay: 'loading' });
    expect(container.textContent).not.toMatch(/Development build|Official release|Self-host build/);
  });

  it('offers the playground a download', async () => {
    await render({ host: 'playground', stamp: STAMP, relay: null });
    expect(container.textContent).toContain('Web playground');
    await act(async () => button('Download Dormouse').click());
    expect(openExternal).toHaveBeenCalledWith('https://dormouse.sh/#download');
  });

  it('copies the details without rendering the user agent', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const facts: AboutFacts = { host: 'standalone', stamp: STAMP, relay: SELF_HOST };
    await render(facts);
    expect(container.textContent).not.toContain(navigator.userAgent);
    await act(async () => button('Copy details').click());
    expect(writeText).toHaveBeenCalledWith(aboutDiagnostics(facts));
    expect(button('Copied')).toBeTruthy();
  });
});

describe('aboutDiagnostics', () => {
  it('lists the build, install kind, host, Relay, and OS', () => {
    expect(aboutDiagnostics({ host: 'standalone', stamp: STAMP, relay: SELF_HOST }, ENV)).toBe(
      'Dormouse 1.2.0+14 (d080b4f5, with uncommitted changes)\n' +
        'Install: Self-host build\n' +
        'Host: Desktop app\n' +
        'Relay: relay.example.com (self-host)\n' +
        'OS: MacIntel\n' +
        `User agent: ${ENV.userAgent}\n`,
    );
    expect(aboutDiagnostics({ host: undefined, stamp: null, relay: 'loading' }, ENV)).toBe(
      'Dormouse, version unknown\nInstall: unknown\nOS: MacIntel\n' + `User agent: ${ENV.userAgent}\n`,
    );
  });
});

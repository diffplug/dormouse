/**
 * @vitest-environment jsdom
 */
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HostsView, type HostView } from './App';
import type { PushAvailability } from '../client/push-subscribe';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const HOSTS: HostView[] = [
  { hostId: 'host-1', label: 'First laptop', online: true },
  { hostId: 'host-2', label: 'Second laptop', online: true },
];

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

function renderHosts(
  overrides: {
    isPushSubscribed?: (hostId: string) => boolean;
    pushState?: PushAvailability | null;
    pushConfigured?: boolean;
    onEnablePush?: (host: HostView) => void;
  } = {},
) {
  act(() => {
    root.render(
      <StrictMode>
        <HostsView
          hosts={HOSTS}
          busy={null}
          error={null}
          isPaired={() => true}
          isPushSubscribed={overrides.isPushSubscribed ?? (() => false)}
          pushState={overrides.pushState ?? 'ready'}
          pushConfigured={overrides.pushConfigured ?? true}
          needsLocalPasskey={false}
          onRefresh={() => undefined}
          onPair={() => undefined}
          onConnect={() => undefined}
          onEnablePush={overrides.onEnablePush ?? (() => undefined)}
          onSetup={() => undefined}
        />
      </StrictMode>,
    );
  });
}

/**
 * The push row belonging to one Host, found through that Host's label rather
 * than by document order — the assertions are about which Host owns which
 * state, so they must not silently pass if the rows are reordered.
 */
function pushRowFor(label: string): HTMLElement {
  const title = [...container.querySelectorAll('div')].find((el) => el.textContent === label);
  const row = title?.closest('div.flex.flex-col')?.lastElementChild;
  if (!(row instanceof HTMLElement)) throw new Error(`no push row for ${label}`);
  return row;
}

function enableButtonIn(row: HTMLElement): HTMLButtonElement | null {
  return [...row.querySelectorAll('button')].find((b) => b.textContent === 'Enable alerts') ?? null;
}

describe('HostsView push registration', () => {
  it('shows Alerts on only for the Host whose server registration succeeded', () => {
    // A PushSubscription is scope-wide, so a browser that can receive push says
    // nothing about which Hosts hold a server row. Only the registered Host may
    // claim alerts are on; the other must still offer the button.
    renderHosts({ isPushSubscribed: (hostId) => hostId === 'host-1' });

    const first = pushRowFor('First laptop');
    const second = pushRowFor('Second laptop');

    expect(first.textContent).toContain('Alerts on.');
    expect(enableButtonIn(first)).toBeNull();

    expect(second.textContent).not.toContain('Alerts on.');
    expect(enableButtonIn(second)).not.toBeNull();
  });

  it('offers the button for every Host when none has registered', () => {
    renderHosts();

    for (const label of ['First laptop', 'Second laptop']) {
      expect(enableButtonIn(pushRowFor(label))).not.toBeNull();
    }
  });

  it('enables push for the Host whose button was clicked', () => {
    const onEnablePush = vi.fn();
    renderHosts({ onEnablePush });

    act(() => {
      enableButtonIn(pushRowFor('Second laptop'))!.click();
    });

    expect(onEnablePush).toHaveBeenCalledWith(HOSTS[1]);
  });

  it('explains an unavailable reason instead of offering a button that cannot work', () => {
    renderHosts({ pushState: 'denied' });

    const row = pushRowFor('First laptop');
    expect(row.textContent).toContain('blocked');
    expect(enableButtonIn(row)).toBeNull();
  });

  it('reports a server with push disabled rather than the browser state', () => {
    renderHosts({ pushConfigured: false });

    const row = pushRowFor('First laptop');
    expect(row.textContent).toContain('server has push notifications disabled');
    expect(enableButtonIn(row)).toBeNull();
  });
});

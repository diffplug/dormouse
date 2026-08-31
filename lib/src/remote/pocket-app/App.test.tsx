/**
 * @vitest-environment jsdom
 */
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HostsView, type HostPairState, type HostView, type PushConfigStatus } from './App';
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
    hosts?: HostView[];
    pairState?: (hostId: string) => HostPairState;
    isPushSubscribed?: (hostId: string) => boolean;
    pushState?: PushAvailability | null;
    pushConfigStatus?: PushConfigStatus;
    onPair?: (host: HostView) => void;
    onConnect?: (host: HostView) => void;
    onEnablePush?: (host: HostView) => void;
    onRetryPushConfig?: () => void;
  } = {},
) {
  act(() => {
    root.render(
      <StrictMode>
        <HostsView
          hosts={overrides.hosts ?? HOSTS}
          busy={null}
          error={null}
          pairState={overrides.pairState ?? (() => 'paired')}
          isPushSubscribed={overrides.isPushSubscribed ?? (() => false)}
          pushState={overrides.pushState ?? 'ready'}
          pushConfigStatus={overrides.pushConfigStatus ?? 'ready'}
          onRefresh={() => undefined}
          onPair={overrides.onPair ?? (() => undefined)}
          onConnect={overrides.onConnect ?? (() => undefined)}
          onEnablePush={overrides.onEnablePush ?? (() => undefined)}
          onRetryPushConfig={overrides.onRetryPushConfig ?? (() => undefined)}
        />
      </StrictMode>,
    );
  });
}

/** The host row itself (not its push row), found through the Host's label. */
function rowFor(label: string): HTMLElement {
  const title = [...container.querySelectorAll('div')].find((el) => el.textContent === label);
  const row = title?.closest('div.flex.flex-col')?.firstElementChild;
  if (!(row instanceof HTMLElement)) throw new Error(`no host row for ${label}`);
  return row;
}

/** The labels of a row's action buttons, in order. */
function actionsIn(row: HTMLElement): string[] {
  return [...row.querySelectorAll('button')].map((button) => button.textContent ?? '');
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

function retryButtonIn(row: HTMLElement): HTMLButtonElement | null {
  return [...row.querySelectorAll('button')].find((b) => b.textContent === 'Retry') ?? null;
}

describe('HostsView pair/connect actions', () => {
  it('offers Pair alone where the Host holds no record for this Client', () => {
    // The whole point of asking the Host: a primary Connect on an unpaired
    // Host is an action that can only fail.
    renderHosts({ pairState: () => 'unpaired' });

    expect(actionsIn(rowFor('First laptop'))).toEqual(['Pair']);
  });

  it('offers Connect alone once the Host recognizes this Client', () => {
    renderHosts({ pairState: () => 'paired' });

    expect(actionsIn(rowFor('Second laptop'))).toEqual(['Connect']);
  });

  it('renames the action to Pair again after an ACL-miss denial', () => {
    renderHosts({ pairState: (hostId) => (hostId === 'host-1' ? 'stale' : 'unpaired') });

    // Still one action, and still Pair — the label is what says the last
    // attempt was denied, so the row explains itself without adding a button.
    expect(actionsIn(rowFor('First laptop'))).toEqual(['Pair again']);
    expect(actionsIn(rowFor('Second laptop'))).toEqual(['Pair']);
  });

  it('keeps one disabled action on an offline host', () => {
    const offline: HostView[] = [
      { hostId: 'host-1', label: 'First laptop', online: false },
      { hostId: 'host-2', label: 'Second laptop', online: false },
    ];
    // Offline means the Host cannot be asked, so the cached marker picks the
    // action — but neither can be taken until it is back.
    renderHosts({
      hosts: offline,
      pairState: (hostId) => (hostId === 'host-1' ? 'paired' : 'unpaired'),
    });

    const paired = rowFor('First laptop');
    expect(actionsIn(paired)).toEqual(['Connect']);
    expect(paired.querySelector('button')!.disabled).toBe(true);
    expect(actionsIn(rowFor('Second laptop'))).toEqual(['Pair']);
    expect(rowFor('Second laptop').querySelector('button')!.disabled).toBe(true);
  });

  it('routes the action to the Host whose row it belongs to', () => {
    const onPair = vi.fn();
    const onConnect = vi.fn();
    renderHosts({
      pairState: (hostId) => (hostId === 'host-1' ? 'paired' : 'unpaired'),
      onPair,
      onConnect,
    });

    act(() => rowFor('First laptop').querySelector('button')!.click());
    act(() => rowFor('Second laptop').querySelector('button')!.click());

    expect(onConnect).toHaveBeenCalledWith(HOSTS[0]);
    expect(onPair).toHaveBeenCalledWith(HOSTS[1]);
  });
});

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
    renderHosts({ pushConfigStatus: 'disabled' });

    const row = pushRowFor('First laptop');
    expect(row.textContent).toContain('server has push notifications disabled');
    expect(enableButtonIn(row)).toBeNull();
  });

  it('does not advise installing when the server cannot push at all', () => {
    // The install ritual the notice describes would end at the same "push is
    // disabled" copy the rows already show — advice and rows must not contradict.
    renderHosts({ pushState: 'needs-install', pushConfigStatus: 'disabled' });

    expect(container.textContent).not.toContain('Add Dormouse to your Home Screen');
    expect(pushRowFor('First laptop').textContent).toContain(
      'server has push notifications disabled',
    );
  });

  it('does not offer Enable alerts until the VAPID key is cached', () => {
    renderHosts({ pushConfigStatus: 'loading' });

    const row = pushRowFor('First laptop');
    expect(row.textContent).toContain('Checking whether this server can send alerts');
    expect(enableButtonIn(row)).toBeNull();
  });

  it('retries config separately from the permission-triggering Enable tap', () => {
    const onRetryPushConfig = vi.fn();
    renderHosts({ pushConfigStatus: 'error', onRetryPushConfig });

    const row = pushRowFor('First laptop');
    expect(row.textContent).toContain('Could not check');
    expect(enableButtonIn(row)).toBeNull();
    act(() => retryButtonIn(row)!.click());
    expect(onRetryPushConfig).toHaveBeenCalledOnce();
  });
});

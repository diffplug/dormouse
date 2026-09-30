/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setPlatform } from '../lib/platform';
import { FakePtyAdapter } from '../lib/platform/fake-adapter';
import { makeStubUpdatesPort } from '../lib/platform/test-ports';
import {
  LAN,
  RELAY_ON,
  SELF_HOST_UNENROLLED_STATUS,
  UNENROLLED_STATUS,
  enrolledStatus,
  makeStubBurrowLink,
  type PrimedBurrow,
} from '../host/remote/test-burrow-link';
import {
  networkPolicyResult,
  nothingPolicy,
  type NetworkInterfaceInfo,
  type NetworkLevel,
  type NetworkPolicy,
} from '../remote/network-policy';
import {
  NetworkPhones,
  NetworkSettings,
  NetworkUpdates,
  connectionsFor,
  policyForLevel,
  type NetworkFacts,
} from './NetworkSettings';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const WIFI: NetworkInterfaceInfo = { id: 'en0', label: 'Local network', kind: 'lan', prefixes: [LAN, 'fd00:1::/64'] };
const ETHERNET: NetworkInterfaceInfo = { id: 'en5', label: 'Local network', kind: 'lan', prefixes: ['10.1.0.0/16', LAN] };
const TAILSCALE: NetworkInterfaceInfo = { id: 'utun4', label: 'Tailscale', kind: 'vpn', prefixes: ['100.64.0.0/10'] };
const DOCKER: NetworkInterfaceInfo = { id: 'bridge100', label: 'Virtual network', kind: 'virtual', prefixes: ['192.168.215.0/24'] };
const INTERFACES = [WIFI, ETHERNET, TAILSCALE, DOCKER];

const HOSTED_ORIGIN = UNENROLLED_STATUS.relayOrigin;
const LOCAL: NetworkPolicy = { level: 'local', allowed: [LAN], autoUpdate: false };

/** A Hosted build, un-enrolled, network on and nothing else. */
function facts(over: Partial<NetworkFacts> = {}): NetworkFacts {
  return {
    policy: LOCAL,
    relayOrigin: HOSTED_ORIGIN,
    relayMode: 'hosted',
    enrolled: false,
    pairedClients: 0,
    pushEnabled: false,
    managedVoice: false,
    updater: false,
    ...over,
  };
}

const destinations = (over: Partial<NetworkFacts>) => connectionsFor(facts(over)).map((row) => row.to);

describe('connectionsFor', () => {
  it('lists nothing under Nothing, whatever else is on', () => {
    expect(
      connectionsFor(facts({
        policy: { ...nothingPolicy(), autoUpdate: true },
        managedVoice: true,
        updater: true,
        pushEnabled: true,
        pairedClients: 1,
      })),
    ).toEqual([]);
  });

  it('lists Hosted only while a link is open, and the phone on an allowed network, under Local networks', () => {
    expect(connectionsFor(facts())).toEqual([
      {
        to: 'hosted.dormouse.sh',
        when: 'Only while a one-time link is open',
        carries: 'Encrypted handshakes. Never terminal traffic.',
      },
      { to: 'Your phone, on an allowed network', when: 'While connected', carries: 'Terminal traffic, end-to-end encrypted.' },
    ]);
    // With nothing allowed no link opens, so neither connection happens.
    expect(connectionsFor(facts({ policy: { ...LOCAL, allowed: [] } }))).toEqual([]);
  });

  it('lists the Relay always, once enrolled, and the phone directly, under My Relay only', () => {
    const relay = { policy: RELAY_ON, relayOrigin: SELF_HOST_UNENROLLED_STATUS.relayOrigin, relayMode: 'self-host' } as const;
    const enrolled = connectionsFor(facts({ ...relay, enrolled: true }));
    expect(enrolled.map((row) => [row.to, row.when])).toEqual([
      ['ned-mac.tail9c2f1.ts.net', 'Always'],
      ['Your phone, directly', 'While connected'],
    ]);
    expect(connectionsFor(facts(relay))[0]!.when).toBe('Always, once this computer is enrolled');
  });

  it('lists push through the Relay only with push on and a phone paired', () => {
    const relay = { policy: RELAY_ON, relayOrigin: SELF_HOST_UNENROLLED_STATUS.relayOrigin, relayMode: 'self-host', enrolled: true } as const;
    const push = 'ned-mac.tail9c2f1.ts.net → your phone’s push service';
    expect(destinations({ ...relay, pushEnabled: true, pairedClients: 1 })).toContain(push);
    expect(destinations({ ...relay, pushEnabled: true })).not.toContain(push);
    expect(destinations({ ...relay, pairedClients: 1 })).not.toContain(push);
  });

  it('lists Hosted for managed voice only with a token saved, in a Hosted build', () => {
    const voice = (over: Partial<NetworkFacts>) =>
      connectionsFor(facts({ policy: { ...LOCAL, allowed: [] }, ...over }));
    expect(voice({ managedVoice: true })).toEqual([
      {
        to: 'hosted.dormouse.sh',
        when: 'When an alert is spoken in the managed voice',
        carries: 'The pane’s name and the voice id, which Hosted passes to ElevenLabs.',
      },
    ]);
    expect(voice({})).toEqual([]);
    expect(voice({ managedVoice: true, relayMode: 'self-host', policy: RELAY_ON }).map((row) => row.when))
      .not.toContain('When an alert is spoken in the managed voice');
  });

  it('lists the update check only with automatic checks on and an updater in this window', () => {
    const on = { policy: { ...LOCAL, allowed: [], autoUpdate: true } };
    expect(connectionsFor(facts({ ...on, updater: true }))).toEqual([
      {
        to: 'dormouse.sh',
        when: 'Each launch',
        carries: 'A request for the newest version number. Downloading one waits for you.',
      },
    ]);
    expect(connectionsFor(facts(on))).toEqual([]);
    expect(connectionsFor(facts({ policy: { ...LOCAL, allowed: [] }, updater: true }))).toEqual([]);
  });
});

describe('policyForLevel', () => {
  const network = (policy: NetworkPolicy) => networkPolicyResult(policy, 'hosted', INTERFACES);

  it('allows every LAN prefix, once, when Local networks is chosen with nothing allowed', () => {
    expect(policyForLevel(network(nothingPolicy()), 'local')).toEqual({
      level: 'local',
      allowed: [LAN, 'fd00:1::/64', '10.1.0.0/16'],
      autoUpdate: false,
    });
  });

  it('keeps the networks already allowed, and fills nothing for another level', () => {
    const typed = { ...nothingPolicy(), allowed: ['10.8.0.0/24'] };
    expect(policyForLevel(network(typed), 'local').allowed).toEqual(['10.8.0.0/24']);
    expect(policyForLevel(network(nothingPolicy()), 'relay' as NetworkLevel).allowed).toEqual([]);
    expect(policyForLevel(network({ ...LOCAL, autoUpdate: true }), 'nothing')).toEqual({
      level: 'nothing',
      allowed: [LAN],
      autoUpdate: true,
    });
  });
});

let container: HTMLDivElement;
let root: Root;
let platform: FakePtyAdapter;
let command: ReturnType<typeof vi.fn>;

/** Serve the panel from the stub link, recording every command it sends. */
function link(primed: PrimedBurrow) {
  const stub = makeStubBurrowLink(primed);
  command = vi.fn(stub.command);
  platform.burrow = { ...stub, command };
}

async function render() {
  await act(async () =>
    root.render(
      <>
        <NetworkSettings />
        <NetworkPhones />
        <NetworkUpdates />
      </>,
    ),
  );
  await act(async () => {});
}

const text = () => container.textContent ?? '';

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === label);
  if (!found) throw new Error(`no button reading ${label}`);
  return found;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  platform = new FakePtyAdapter();
  setPlatform(platform);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('Settings → Network', () => {
  it('renders nothing without a Burrow service', async () => {
    await render();
    expect(container.innerHTML).toBe('');
  });

  it('offers only the levels the service offers and has copy for', async () => {
    link({
      status: UNENROLLED_STATUS,
      network: { ...networkPolicyResult(nothingPolicy(), 'hosted', INTERFACES), levels: ['nothing', 'local', 'anywhere'] },
    });
    await render();
    const radios = [...container.querySelectorAll('[role="radio"]')].map((radio) => radio.textContent);
    expect(radios.map((label) => label?.split('.')[0])).toEqual([
      'NothingDormouse opens no connections on its own',
      'Local networksPhones connect only over networks you choose',
    ]);
  });

  it('chooses Local networks from the Phones hint, allowing the LAN interfaces', async () => {
    link({ status: UNENROLLED_STATUS, network: networkPolicyResult(nothingPolicy(), 'hosted', INTERFACES) });
    await render();
    expect(text()).toContain('Choose Local networks to connect a phone.');
    await act(async () => button('Local networks').click());
    expect(command).toHaveBeenCalledWith('setNetworkPolicy', {
      policy: { level: 'local', allowed: [LAN, 'fd00:1::/64', '10.1.0.0/16'], autoUpdate: false },
    });
    // The Phones section now holds the Remote control choices.
    await act(async () => {});
    expect(text()).toContain('One-time connection');
  });

  it('shows a refused change where it was made', async () => {
    link({ status: UNENROLLED_STATUS, network: networkPolicyResult(nothingPolicy(), 'hosted', INTERFACES) });
    const stub = command;
    command = vi.fn(async (cmd: string, params?: unknown) => {
      if (cmd === 'setNetworkPolicy') throw new Error('disk full');
      return stub(cmd, params);
    });
    platform.burrow = { ...platform.burrow!, command };
    await render();
    const local = container.querySelector<HTMLElement>('[role="radio"][aria-checked="false"]')!;
    await act(async () => local.click());
    expect(text()).toContain('disk full');
  });

  describe('updates', () => {
    const hosted = (policy: NetworkPolicy) => ({
      status: UNENROLLED_STATUS,
      network: networkPolicyResult(policy, 'hosted', INTERFACES),
    });

    it('says when the last check was, and checks now, where this window has the updater', async () => {
      link(hosted({ ...LOCAL, autoUpdate: true }));
      const port = makeStubUpdatesPort(null);
      platform.updates = port;
      await render();
      expect(text()).toContain('Checked at each launch. Never checked on this computer.');
      expect(text()).toContain('The bottom bar reminds you after a week without a successful check.');
      await act(async () => button('Check now').click());
      expect(port.checks).toBe(1);
      expect(text()).toContain('Last checked today.');
    });

    it('checks only when asked under Nothing, which offers no switch', async () => {
      link(hosted({ ...nothingPolicy(), autoUpdate: true }));
      platform.updates = makeStubUpdatesPort(Date.now() - 9 * 86_400_000);
      await render();
      expect(text()).toContain('Checked only when you ask. Last checked 9 days ago.');
      expect(container.querySelector('[role="switch"][aria-label^="Check for updates"]')).toBeNull();
    });

    it('turns automatic checks on through the policy', async () => {
      link(hosted(LOCAL));
      await render();
      const toggle = container.querySelector<HTMLElement>('[role="switch"][aria-label^="Check for updates automatically"]')!;
      await act(async () => toggle.click());
      expect(command).toHaveBeenCalledWith('setNetworkPolicy', { policy: { ...LOCAL, autoUpdate: true } });
    });

    it('offers no last check or Check now without the updater', async () => {
      link(hosted(LOCAL));
      await render();
      expect(text()).toContain('Checked only when you ask.');
      expect(text()).not.toContain('Check now');
      expect(text()).not.toContain('Never checked');
    });

    it('names the Marketplace in VS Code, and the source in a self-host build', async () => {
      link(hosted(LOCAL));
      platform.hostOwnsUpdates = true;
      await render();
      expect(text()).toContain('VS Code installs Dormouse updates from the Marketplace');
      expect(text()).not.toContain('Check for updates automatically');

      await act(async () => root.unmount());
      root = createRoot(container);
      platform.hostOwnsUpdates = undefined;
      link({ status: enrolledStatus(), network: networkPolicyResult(RELAY_ON, 'self-host', INTERFACES) });
      platform.updates = makeStubUpdatesPort(null);
      await render();
      expect(text()).toContain('This build never updates itself. Rebuild it from source to update.');
      expect(text()).not.toContain('Check now');
    });
  });
});

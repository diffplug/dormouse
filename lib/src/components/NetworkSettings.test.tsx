/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setPlatform } from '../lib/platform';
import { setNativeFieldValue } from '../lib/dom';
import { canonicalCidr } from '../host/remote/network-interfaces';
import { FakePtyAdapter } from '../lib/platform/fake-adapter';
import { refreshBurrowStatus } from '../remote/burrow/burrow-status-store';
import { getNetworkPolicySnapshot, subscribeToNetworkPolicy } from '../remote/burrow/network-policy-store';
import { makeStubUpdatesPort } from '../lib/platform/test-ports';
import { CLOUDFLARE_STUN_HOST } from '../remote/direct/ice-servers';
import {
  ANYWHERE_ON as ANYWHERE,
  LAN,
  LOCAL_ON as LOCAL,
  RELAY_ON,
  SELF_HOST_UNENROLLED_STATUS,
  UNENROLLED_STATUS,
  enrolledStatus,
  makeStubBurrowLink,
  type PrimedBurrow,
} from '../host/remote/test-burrow-link';
import {
  MAX_ALLOWED_NETWORKS,
  networkPolicyResult,
  nothingPolicy,
  type NetworkInterfaceInfo,
  type NetworkPolicy,
} from '../remote/network-policy';
import {
  NetworkPhones,
  NetworkSettings,
  NetworkUpdates,
  PATH_REFUSAL_LABEL,
  connectionsFor,
  policyForLevel,
  type NetworkFacts,
} from './NetworkSettings';
import { pathRefusalSentence } from './remote-control-shared';
import type { PathRefusal } from '../remote/direct/path-refusal';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const WIFI: NetworkInterfaceInfo = { id: 'en0', label: 'Local network', kind: 'lan', prefixes: [LAN, 'fd00:1::/64'] };
const ETHERNET: NetworkInterfaceInfo = { id: 'en5', label: 'Local network', kind: 'lan', prefixes: ['10.1.0.0/16', LAN] };
const TAILSCALE: NetworkInterfaceInfo = { id: 'utun4', label: 'Tailscale', kind: 'vpn', prefixes: ['100.64.0.0/10'] };
const DOCKER: NetworkInterfaceInfo = { id: 'bridge100', label: 'Virtual network', kind: 'virtual', prefixes: ['192.168.215.0/24'] };
const INTERFACES = [WIFI, ETHERNET, TAILSCALE, DOCKER];

/** A Hosted build, un-enrolled, network on and nothing else. */
function facts(over: Partial<NetworkFacts> = {}): NetworkFacts {
  return { policy: LOCAL, status: UNENROLLED_STATUS, managedVoice: false, updater: false, ...over };
}

/** A self-host build under My Relay only, enrolled with `pairedClients` phones. */
const relayFacts = (pairedClients = 0) =>
  ({ policy: RELAY_ON, status: enrolledStatus({ pairedClients }) }) satisfies Partial<NetworkFacts>;

const destinations = (over: Partial<NetworkFacts>) => connectionsFor(facts(over)).map((row) => row.to);

describe('connectionsFor', () => {
  it('lists nothing under Nothing, whatever else is on', () => {
    expect(
      connectionsFor(facts({
        policy: { ...nothingPolicy(), autoUpdate: true },
        status: enrolledStatus({ pairedClients: 1 }),
        managedVoice: true,
        updater: true,
      })),
    ).toEqual([]);
  });

  it('lists Hosted only while a link is open, and the phone on an allowed network, under Local networks', () => {
    expect(connectionsFor(facts())).toEqual([
      {
        to: 'relay.dormouse.sh',
        when: 'Only while a one-time link is open',
        carries: 'Encrypted handshakes. Never terminal traffic.',
      },
      { to: 'Your phone, on an allowed network', when: 'While connected', carries: 'Terminal traffic, end-to-end encrypted.' },
    ]);
    // With nothing allowed no link opens, so neither connection happens.
    expect(connectionsFor(facts({ policy: { ...LOCAL, allowed: [] } }))).toEqual([]);
  });

  it('lists Hosted while a link is open, Cloudflare’s STUN as a phone connects, and the phone on any network, under Anywhere', () => {
    const rows = [
      {
        to: 'relay.dormouse.sh',
        when: 'Only while a one-time link is open',
        carries: 'Encrypted handshakes. Never terminal traffic.',
      },
      {
        to: CLOUDFLARE_STUN_HOST,
        when: 'When a phone connects',
        carries: 'A lookup that shows Cloudflare this computer’s public IP address.',
      },
      { to: 'Your phone, on any network', when: 'While connected', carries: 'Terminal traffic, end-to-end encrypted.' },
    ];
    expect(connectionsFor(facts({ policy: ANYWHERE }))).toEqual(rows);
    // The networks left allowed add nothing.
    expect(connectionsFor(facts({ policy: { ...ANYWHERE, allowed: [LAN] } }))).toEqual(rows);
  });

  it('lists Hosted always once enrolled, terminal traffic through it only under Anywhere, and push once a phone is paired', () => {
    const enrolled = { ...UNENROLLED_STATUS, enrolled: true, pairedClients: 1 };
    const push = {
      to: 'relay.dormouse.sh → your phone’s push service',
      when: 'When an alert goes unattended, where push is on',
      carries: 'An end-to-end encrypted notification.',
    };
    expect(connectionsFor(facts({ policy: ANYWHERE, status: enrolled }))).toEqual([
      {
        to: 'relay.dormouse.sh',
        when: 'Always',
        carries:
          'Encrypted handshakes and one-time links, requests for setup codes and the push device list, and terminal traffic when a phone can’t connect directly.',
      },
      {
        to: CLOUDFLARE_STUN_HOST,
        when: 'When a phone connects',
        carries: 'A lookup that shows Cloudflare this computer’s public IP address.',
      },
      { to: 'Your phone, directly', when: 'While connected', carries: 'Terminal traffic, end-to-end encrypted.' },
      push,
    ]);
    // Local networks holds a paired phone to the direct path: never terminal
    // traffic through Hosted, and the phone only on an allowed network.
    expect(connectionsFor(facts({ status: enrolled }))).toEqual([
      {
        to: 'relay.dormouse.sh',
        when: 'Always',
        carries:
          'Encrypted handshakes and one-time links, requests for setup codes and the push device list. Never terminal traffic.',
      },
      {
        to: 'Your phone, directly, on an allowed network',
        when: 'While connected',
        carries: 'Terminal traffic, end-to-end encrypted.',
      },
      push,
    ]);
    // With nothing allowed no phone connects and no link opens, but the
    // socket still runs.
    expect(connectionsFor(facts({ policy: { ...LOCAL, allowed: [] }, status: enrolled }))).toEqual([
      {
        to: 'relay.dormouse.sh',
        when: 'Always',
        carries: 'Encrypted handshakes, requests for setup codes and the push device list. Never terminal traffic.',
      },
      push,
    ]);
    expect(destinations({ policy: ANYWHERE, status: { ...enrolled, pairedClients: 0 } })).not.toContain(push.to);
  });

  it('lists the Relay always, once enrolled, and the phone directly, under My Relay only', () => {
    expect(connectionsFor(facts(relayFacts())).map((row) => [row.to, row.when])).toEqual([
      ['ned-mac.tail9c2f1.ts.net', 'Always'],
      ['Your phone, directly', 'While connected'],
    ]);
    const unenrolled = facts({ policy: RELAY_ON, status: SELF_HOST_UNENROLLED_STATUS });
    expect(connectionsFor(unenrolled)[0]!.when).toBe('Always, once this computer is enrolled');
  });

  it('lists no relay socket while the Relay refuses this Burrow, which opens nothing', () => {
    for (const connection of ['removed', 'not-entitled'] as const) {
      // Hosted: only the one-time links that still ride its origin.
      expect(
        connectionsFor(facts({ status: { ...UNENROLLED_STATUS, enrolled: true, pairedClients: 1, connection } })),
        connection,
      ).toEqual(connectionsFor(facts()));
      // Self-host under My Relay only: nothing reaches this computer at all.
      expect(connectionsFor(facts({ ...relayFacts(1), status: enrolledStatus({ pairedClients: 1, connection }) }))).toEqual([]);
    }
    // A socket merely down is still the standing connection.
    expect(connectionsFor(facts({ ...relayFacts(1), status: enrolledStatus({ pairedClients: 1, connection: 'disconnected' }) }))[0]!.when).toBe('Always');
  });

  it('lists push through the Relay once a phone is paired, naming the push setting as its condition', () => {
    // Push may be on in a Workspace, some in other windows, with the default
    // off, so the list cannot read it and states the condition instead.
    const push = connectionsFor(facts(relayFacts(1))).find((row) => row.to.endsWith('your phone’s push service'));
    expect(push).toEqual({
      to: 'ned-mac.tail9c2f1.ts.net → your phone’s push service',
      when: 'When an alert goes unattended, where push is on',
      carries: 'An end-to-end encrypted notification.',
    });
    expect(destinations(relayFacts(0))).not.toContain(push!.to);
  });

  it('lists Hosted for managed voice only with a token saved, in a Hosted build', () => {
    const voice = (over: Partial<NetworkFacts>) =>
      connectionsFor(facts({ policy: { ...LOCAL, allowed: [] }, ...over }));
    expect(voice({ managedVoice: true })).toEqual([
      {
        to: 'voice.dormouse.sh',
        when: 'When an alert is spoken in the managed voice',
        carries: 'The pane’s name and the voice id, which Hosted passes to ElevenLabs.',
      },
    ]);
    expect(voice({})).toEqual([]);
    expect(voice({ ...relayFacts(), managedVoice: true }).map((row) => row.when))
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
    expect(policyForLevel(network(nothingPolicy()), 'relay').allowed).toEqual([]);
    expect(policyForLevel(network(nothingPolicy()), 'anywhere')).toEqual(ANYWHERE);
    expect(policyForLevel(network(LOCAL), 'anywhere')).toEqual({ ...ANYWHERE, allowed: [LAN] });
    expect(policyForLevel(network({ ...LOCAL, autoUpdate: true }), 'nothing')).toEqual({
      level: 'nothing',
      allowed: [LAN],
      autoUpdate: true,
    });
  });
});

/** 10:42 on this machine's clock, whatever its zone. */
const AT_10_42 = new Date(2026, 9, 1, 10, 42).getTime();
const CLOCK_10_42 = new Date(AT_10_42).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

describe('pathRefusalSentence', () => {
  const observed: PathRefusal = {
    at: AT_10_42,
    kind: 'path-refused',
    end: 'remote',
    address: '172.58.12.9',
    addressSource: 'observed',
  };
  const reported: PathRefusal = { ...observed, kind: 'given-up', addressSource: 'reported' };
  const remote: PathRefusal = { at: AT_10_42, kind: 'path-refused', end: 'remote' };
  const local: PathRefusal = { at: AT_10_42, kind: 'path-refused', end: 'local', localAddress: '10.0.0.2' };
  const localUnnamed: PathRefusal = { at: AT_10_42, kind: 'path-refused', end: 'local' };
  const none: PathRefusal = { at: AT_10_42, kind: 'deadline' };
  const SAME_DAY = AT_10_42 + 60 * 60 * 1000;

  it('says when, and which end was off the networks allowed below', () => {
    expect(pathRefusalSentence(observed, 'network-panel', SAME_DAY)).toBe(
      `At ${CLOCK_10_42} a phone tried to connect from 172.58.12.9, which isn’t on a network allowed below.`,
    );
    // The phone's own claim is named as its claim, never as off the networks.
    expect(pathRefusalSentence(reported, 'network-panel', SAME_DAY)).toBe(
      `At ${CLOCK_10_42} a phone couldn’t connect directly over an allowed network (it reported 172.58.12.9).`,
    );
    expect(pathRefusalSentence(remote, 'network-panel', SAME_DAY)).toBe(
      `At ${CLOCK_10_42} a phone tried to connect from outside the networks allowed below.`,
    );
    // This computer's own end: never the phone's network.
    expect(pathRefusalSentence(local, 'network-panel', SAME_DAY)).toBe(
      `At ${CLOCK_10_42} a phone couldn’t connect: this computer wasn’t on a network allowed below (its address was 10.0.0.2).`,
    );
    expect(pathRefusalSentence(localUnnamed, 'network-panel', SAME_DAY)).toBe(
      `At ${CLOCK_10_42} a phone couldn’t connect: this computer wasn’t on a network allowed below.`,
    );
    expect(pathRefusalSentence(none, 'network-panel', SAME_DAY)).toBe(
      `At ${CLOCK_10_42} a phone couldn’t reach this computer over an allowed network.`,
    );
  });

  it('names the date of a refusal from another day', () => {
    const day = new Date(AT_10_42).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const nextDay = new Date(2026, 9, 2, 9, 0).getTime();
    expect(pathRefusalSentence(none, 'network-panel', nextDay)).toBe(
      `On ${day} at ${CLOCK_10_42} a phone couldn’t reach this computer over an allowed network.`,
    );
    const withYear = new Date(AT_10_42).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    expect(pathRefusalSentence(none, 'network-panel', new Date(2027, 0, 2).getTime())).toContain(`On ${withYear} at`);
  });

  it('words a one-time ending the same way, as the ending', () => {
    expect(pathRefusalSentence(observed, 'one-time')).toBe(
      'The phone tried to connect from 172.58.12.9, which isn’t on one of your allowed networks, so the connection ended.',
    );
    expect(pathRefusalSentence(reported, 'one-time')).toBe(
      'The phone couldn’t connect directly over one of your allowed networks (it reported 172.58.12.9), so the connection ended.',
    );
    expect(pathRefusalSentence(local, 'one-time')).toBe(
      'This computer wasn’t on one of your allowed networks (its address was 10.0.0.2), so the connection ended.',
    );
    expect(pathRefusalSentence(none, 'one-time')).toBe(
      'The phone couldn’t reach this computer over one of your allowed networks, so the connection ended.',
    );
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

type Command = (cmd: string, params?: unknown) => Promise<unknown>;

/** Wrap the link's `command` so `answer` may answer first; `undefined` falls through to `stub`. */
function intercept(answer: (cmd: string, params: unknown, stub: Command) => unknown) {
  const stub = command as Command;
  command = vi.fn(async (cmd: string, params?: unknown) => {
    const answered = answer(cmd, params, stub);
    return answered === undefined ? stub(cmd, params) : answered;
  });
  platform.burrow = { ...platform.burrow!, command };
}

/** Every policy the panel sent, in order. */
const sentPolicies = () =>
  command.mock.calls.filter(([cmd]) => cmd === 'setNetworkPolicy').map(([, params]) => (params as { policy: NetworkPolicy }).policy);

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

/** The level picker's radio titled `name`. */
function radio(name: string): HTMLElement {
  return [...container.querySelectorAll<HTMLElement>('[role="radio"]')].find((el) => el.textContent?.startsWith(name))!;
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

  it('offers the levels the service offers, in its order', async () => {
    link({ status: UNENROLLED_STATUS, network: networkPolicyResult(nothingPolicy(), 'hosted', INTERFACES) });
    await render();
    const radios = [...container.querySelectorAll('[role="radio"]')].map((radio) => radio.textContent);
    expect(radios).toEqual([
      'NothingDormouse opens no connections on its own, and phones can’t reach it.',
      'Local networksPhones connect only over networks you choose.',
      'AnywherePhones connect directly from any network.',
    ]);
  });

  it('chooses Anywhere, which shows no allowed networks', async () => {
    link({ status: UNENROLLED_STATUS, network: networkPolicyResult(LOCAL, 'hosted', INTERFACES) });
    await render();
    expect(text()).toContain('Allowed networks');
    await act(async () => radio('Anywhere').click());
    await act(async () => {});
    expect(radio('Anywhere').getAttribute('aria-checked')).toBe('true');
    expect(text()).not.toContain('Allowed networks');
  });

  it('chooses Local networks from the Phones hint, allowing the LAN interfaces', async () => {
    link({ status: UNENROLLED_STATUS, network: networkPolicyResult(nothingPolicy(), 'hosted', INTERFACES) });
    await render();
    expect(text()).toContain('Choose Local networks or Anywhere to connect a phone.');
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
    intercept((cmd) => {
      if (cmd === 'setNetworkPolicy') throw new Error('disk full');
    });
    await render();
    const local = container.querySelector<HTMLElement>('[role="radio"][aria-checked="false"]')!;
    await act(async () => local.click());
    expect(text()).toContain('disk full');
  });

  describe('a second change before the first lands', () => {
    /** Hold every `setNetworkPolicy` until `release` answers the oldest one. */
    function holdSets(): () => Promise<void> {
      const held: Array<() => void> = [];
      intercept((cmd, params, stub) =>
        cmd === 'setNetworkPolicy'
          ? new Promise((resolve) => held.push(() => resolve(stub(cmd, params))))
          : undefined);
      return async () => {
        await act(async () => held.shift()!());
        await act(async () => {});
      };
    }

    it('builds on the first, so two switches turned on both stay on', async () => {
      link({ status: UNENROLLED_STATUS, network: networkPolicyResult(LOCAL, 'hosted', INTERFACES) });
      const release = holdSets();
      await render();
      const allow = (label: string) =>
        container.querySelector<HTMLElement>(`[role="switch"][aria-label="Allow ${label} off"]`)!;
      const tailscale = allow('Tailscale utun4');
      const docker = allow('Virtual network bridge100');
      await act(async () => {
        tailscale.click();
        docker.click();
      });
      await release();
      await release();
      expect(sentPolicies()).toEqual([
        { ...LOCAL, allowed: [LAN, '100.64.0.0/10'] },
        { ...LOCAL, allowed: [LAN, '100.64.0.0/10', '192.168.215.0/24'] },
      ]);
    });

    it('lands on the level chosen last', async () => {
      link({ status: UNENROLLED_STATUS, network: networkPolicyResult(nothingPolicy(), 'hosted', INTERFACES) });
      const release = holdSets();
      await render();
      const [local, nothing] = [radio('Local networks'), radio('Nothing')];
      await act(async () => {
        local.click();
        nothing.click();
      });
      await release();
      await release();
      expect(sentPolicies().map((policy) => policy.level)).toEqual(['local', 'nothing']);
      expect(radio('Nothing').getAttribute('aria-checked')).toBe('true');
    });
  });

  it('offers Disconnect for an enrollment Nothing holds, without leaving Nothing', async () => {
    link({ status: enrolledStatus({ connection: 'stopped' }), network: networkPolicyResult(nothingPolicy(), 'self-host', []) });
    await render();
    expect(text()).toContain('Enrolled with https://ned-mac.tail9c2f1.ts.net');
    await act(async () => button('Disconnect').click());
    await act(async () => button('Disconnect').click());
    expect(command.mock.calls.map(([cmd]) => cmd)).toContain('clearEnrollment');
    expect(sentPolicies()).toEqual([]);
  });

  it('shows every allowed range, a partly allowed interface’s included', async () => {
    // Wi-Fi and Ethernet share the LAN; each also has a range of its own.
    link({ status: UNENROLLED_STATUS, network: networkPolicyResult(LOCAL, 'hosted', INTERFACES) });
    await render();
    expect(container.querySelector('[role="switch"][aria-label="Allow Local network en0 off"]')).not.toBeNull();
    expect(text()).toContain(`Part of Local network · en0${LAN}`);
    await act(async () => container.querySelector<HTMLElement>(`button[aria-label="Remove ${LAN}"]`)!.click());
    expect(sentPolicies()).toEqual([{ ...LOCAL, allowed: [] }]);
  });

  it('keeps a range another switch reading On still needs when one is turned off', async () => {
    const both = { ...LOCAL, allowed: [LAN, 'fd00:1::/64', '10.1.0.0/16'] };
    link({ status: UNENROLLED_STATUS, network: networkPolicyResult(both, 'hosted', INTERFACES) });
    await render();
    await act(async () =>
      container.querySelector<HTMLElement>('[role="switch"][aria-label="Allow Local network en5 on"]')!.click());
    expect(sentPolicies()).toEqual([{ ...both, allowed: [LAN, 'fd00:1::/64'] }]);
  });

  it('shows the last refused phone above the allowed networks until it is dismissed', async () => {
    const refusal: PathRefusal = { at: AT_10_42, kind: 'path-refused', end: 'remote', address: '172.58.12.9', addressSource: 'observed' };
    link({ status: UNENROLLED_STATUS, network: networkPolicyResult(LOCAL, 'hosted', INTERFACES, refusal) });
    await render();
    const notice = () => container.querySelector(`[role="status"][aria-label="${PATH_REFUSAL_LABEL}"]`);
    expect(notice()?.textContent).toContain(pathRefusalSentence(refusal, 'network-panel'));

    await act(async () => button('Dismiss').click());
    expect(command.mock.calls.map(([cmd]) => cmd)).toContain('dismissPathRefusal');
    expect(notice()).toBeNull();
  });

  it('shows no refused phone under a level that holds no path', async () => {
    const refusal: PathRefusal = { at: AT_10_42, kind: 'deadline' };
    link({ status: UNENROLLED_STATUS, network: networkPolicyResult(ANYWHERE, 'hosted', INTERFACES, refusal) });
    await render();
    expect(text()).not.toContain('couldn’t reach this computer');
  });

  it('says how many ranges may be allowed rather than sending one too many', async () => {
    const full = Array.from({ length: MAX_ALLOWED_NETWORKS }, (_, i) => `10.${i}.0.0/16`);
    link({ status: UNENROLLED_STATUS, network: networkPolicyResult({ ...LOCAL, allowed: full }, 'hosted', INTERFACES) });
    await render();
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Add an allowed network range"]')!;
    await act(async () => setNativeFieldValue(input, '10.99.0.0/16'));
    await act(async () => button('Add').click());
    expect(text()).toContain(`At most ${MAX_ALLOWED_NETWORKS} ranges can be allowed. Remove one first.`);
    expect(sentPolicies()).toEqual([]);
  });

  it('keeps the choice up through a failed status read', async () => {
    link({ status: UNENROLLED_STATUS, network: networkPolicyResult(LOCAL, 'hosted', INTERFACES) });
    await render();
    intercept((cmd) => (cmd === 'status' ? Promise.reject(new Error('bridge timed out')) : undefined));
    await act(async () => refreshBurrowStatus());
    expect(container.querySelectorAll('[role="radio"]')).toHaveLength(3);
    expect(text()).not.toContain('Could not reach');
  });

  it('re-reads the policy on open, past a failed read the Baseboard’s subscription holds', async () => {
    link({ status: UNENROLLED_STATUS, network: networkPolicyResult(LOCAL, 'hosted', INTERFACES) });
    let up = false;
    intercept((cmd) => (cmd === 'networkPolicy' && !up ? Promise.reject(new Error('not up yet')) : undefined));
    const release = subscribeToNetworkPolicy(() => {});
    try {
      await act(async () => {});
      expect(getNetworkPolicySnapshot().kind).toBe('error');
      up = true;
      await render();
      expect(container.querySelectorAll('[role="radio"]')).toHaveLength(3);
    } finally {
      release();
    }
  });

  it('lists the update check in a window without the updater’s port, which the build still runs', async () => {
    link({ status: UNENROLLED_STATUS, network: networkPolicyResult({ ...LOCAL, autoUpdate: true }, 'hosted', INTERFACES) });
    await render();
    const listed = () => [...container.querySelectorAll('dt')].map((dt) => dt.textContent);
    expect(listed()).toContain('dormouse.sh');

    // VS Code's Marketplace updates the extension, so nothing of Dormouse's checks.
    await act(async () => root.unmount());
    root = createRoot(container);
    platform.hostOwnsUpdates = true;
    await render();
    expect(listed()).not.toContain('dormouse.sh');
  });

  it('lists a typed range as the service saved it, in canonical form', async () => {
    link({ status: UNENROLLED_STATUS, network: networkPolicyResult(LOCAL, 'hosted', INTERFACES) });
    // The service's canonical save (`requestedNetworkPolicy`), over the stub.
    intercept((cmd, params, stub) => {
      if (cmd !== 'setNetworkPolicy') return undefined;
      const { policy } = params as { policy: NetworkPolicy };
      return stub(cmd, { policy: { ...policy, allowed: policy.allowed.map((cidr) => canonicalCidr(cidr)!) } });
    });
    await render();

    const input = container.querySelector<HTMLInputElement>('input[aria-label="Add an allowed network range"]')!;
    await act(async () => setNativeFieldValue(input, ' 10.8.0.7/24 '));
    await act(async () => button('Add').click());
    expect(command).toHaveBeenCalledWith('setNetworkPolicy', {
      policy: { ...LOCAL, allowed: [LAN, '10.8.0.7/24'] },
    });
    expect(text()).toContain('Added range · not connected now10.8.0.0/24');
    expect(text()).not.toContain('10.8.0.7');
    expect(input.value).toBe('');
  });

  describe('updates', () => {
    const hosted = (policy: NetworkPolicy) => ({
      status: UNENROLLED_STATUS,
      network: networkPolicyResult(policy, 'hosted', INTERFACES),
    });

    it('says when the last check was, and checks now, where this window has the updater', async () => {
      link(hosted({ ...LOCAL, autoUpdate: true }));
      platform.updates = makeStubUpdatesPort(null);
      await render();
      expect(text()).toContain('Checked at each launch. Never checked on this computer.');
      expect(text()).toContain('The bottom bar reminds you after a week without a successful check.');
      // Only the stub's `checkNow` records a check.
      await act(async () => button('Check now').click());
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

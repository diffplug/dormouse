import type { Meta, StoryObj } from '@storybook/react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { ModalSurface } from '../components/design';
import { NetworkPhones, NetworkSettings, NetworkUpdates } from '../components/NetworkSettings';
import {
  ANYWHERE_ON,
  LOCAL_ON,
  RELAY_ON,
  SELF_HOST_UNENROLLED_STATUS,
  UNENROLLED_STATUS,
  enrolledStatus,
} from '../host/remote/test-burrow-link';
import { CLOUDFLARE_STUN_HOST } from '../remote/direct/ice-servers';
import type { PathRefusal } from '../remote/direct/path-refusal';
import {
  networkPolicyResult,
  nothingPolicy,
  type NetworkInterfaceInfo,
  type NetworkPolicy,
} from '../remote/network-policy';

/**
 * Settings → Network (`docs/specs/remote-network.md` -> "Settings → Network"):
 * its three groups as the Settings dialog stacks them, on a surface its width.
 * `SettingsDialog`'s `Network` stories cover it in place.
 *
 * Every state comes from the stub link's `network` option under `primedBurrow`
 * — the policy, the build's levels, this machine's interfaces — and the
 * `primedUpdates` / `primedManagedVoice` ports, since the panel reads its whole
 * world from the platform. Changes go to the stub, which holds and answers
 * them as the service does.
 */
function NetworkStory() {
  return (
    <div className="flex justify-center p-6">
      <ModalSurface padding="spacious" className="w-full max-w-[36rem]">
        <NetworkSettings />
        <NetworkPhones />
        <NetworkUpdates />
      </ModalSurface>
    </div>
  );
}

const WIFI: NetworkInterfaceInfo = {
  id: 'en0', label: 'Local network', kind: 'lan', prefixes: ['192.168.1.0/24', '2601:646:8a00:1d0::/64'],
};
const TAILSCALE: NetworkInterfaceInfo = {
  id: 'utun4', label: 'Tailscale', kind: 'vpn', prefixes: ['100.64.0.0/10', 'fd7a:115c:a1e0::/48'],
};
const DOCKER: NetworkInterfaceInfo = {
  id: 'bridge100', label: 'Virtual network', kind: 'virtual', prefixes: ['192.168.215.0/24'],
};
const INTERFACES = [WIFI, TAILSCALE, DOCKER];

const DAY = 86_400_000;

/** A Hosted build holding `policy`, on a laptop with Wi-Fi, a tailnet, and Docker. */
function hosted(policy: NetworkPolicy, status = UNENROLLED_STATUS, refusal: PathRefusal | null = null) {
  return { status, network: networkPolicyResult(policy, 'hosted', INTERFACES, refusal) };
}

/** 10:42 this morning, on whatever clock renders the story. */
const morning = new Date();
morning.setHours(10, 42, 0, 0);
const AT_10_42 = morning.getTime();

/** A self-host build holding `policy`. */
function selfHost(policy: NetworkPolicy, status = SELF_HOST_UNENROLLED_STATUS) {
  return { status, network: networkPolicyResult(policy, 'self-host', INTERFACES) };
}

const meta: Meta<typeof NetworkStory> = {
  title: 'Modals/NetworkSettings',
  component: NetworkStory,
  // The panel reads module-singleton stores, as `RemoteControlSection`'s
  // stories explain; each needs its own frame on a docs page.
  parameters: { docs: { story: { inline: false, height: '640px' } } },
};

export default meta;
type Story = StoryObj<typeof NetworkStory>;

type Body = ReturnType<typeof within>;

/** The panel opens on "Checking…" until the stub answers; wait for the picker. */
async function settled(canvasElement: HTMLElement): Promise<Body> {
  const canvas = within(canvasElement);
  await canvas.findByRole('radiogroup', { name: 'End-to-end encrypted terminal data may travel' });
  return canvas;
}

/** Every new install: nothing leaves this computer unless its user clicks something. */
export const Nothing: Story = {
  parameters: { primedBurrow: hosted(nothingPolicy()), primedUpdates: { checkedAt: null } },
  play: async ({ canvasElement }) => {
    const canvas = await settled(canvasElement);
    await expect(canvas.getByRole('radio', { name: /^Nowhere/ })).toHaveAttribute('aria-checked', 'true');
    await canvas.findByText(/^Nothing\. Terminals, browser panes, and agents/);
    await canvas.findByText(/Checked only when you ask\. Never checked on this computer\./);
    await expect(canvas.getByRole('radio', { name: /^Anywhere/ })).toHaveAttribute('aria-checked', 'false');
  },
};

/** Nine days since the last check: the Baseboard is reminding them (`UpdateBanner` → CheckDue). */
export const NothingCheckDue: Story = {
  parameters: { primedBurrow: hosted(nothingPolicy()), primedUpdates: { checkedAt: Date.now() - 9 * DAY } },
  play: async ({ canvasElement }) => {
    const canvas = await settled(canvasElement);
    await canvas.findByText(/Last checked 9 days ago\./);
    await userEvent.click(canvas.getByRole('button', { name: 'Check now' }));
    await canvas.findByText(/Last checked today\./);
  },
};

/**
 * The Phones hint names the choices that allow a phone, each a shortcut to
 * itself — and Local networks chosen with nothing allowed allows the Wi-Fi,
 * never the tailnet or Docker.
 */
export const NothingChooseFromPhones: Story = {
  parameters: { primedBurrow: hosted(nothingPolicy()) },
  play: async ({ canvasElement }) => {
    const canvas = await settled(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Local networks only' }));
    await waitFor(() =>
      expect(canvas.getByRole('radio', { name: /^Local networks/ })).toHaveAttribute('aria-checked', 'true'));
    await expect(canvas.getByRole('switch', { name: 'Allow Local network en0 on' })).toBeVisible();
    await expect(canvas.getByRole('switch', { name: 'Allow Tailscale utun4 off' })).toBeVisible();
    await expect(canvas.getByRole('switch', { name: 'Allow Virtual network bridge100 off' })).toBeVisible();
    await canvas.findByRole('button', { name: 'One-time connection' });
  },
};

/** Pocket, but terminal traffic stays on the home Wi-Fi and the tailnet; update checks on. */
export const LocalNetworks: Story = {
  parameters: {
    primedBurrow: hosted({ level: 'local', allowed: [...WIFI.prefixes, ...TAILSCALE.prefixes], autoUpdate: true }),
    primedUpdates: { checkedAt: Date.now() },
  },
  play: async ({ canvasElement }) => {
    const canvas = await settled(canvasElement);
    await canvas.findByText('Your phone, on an allowed network');
    await canvas.findByText('dormouse.sh');
    await canvas.findByText(/Checked at each launch\. Last checked today\./);
  },
};

/** Before any phone: Hosted is contacted only while a one-time link is open. */
export const LocalNetworksFirstRun: Story = {
  parameters: { primedBurrow: hosted({ level: 'local', allowed: WIFI.prefixes, autoUpdate: false }) },
  play: async ({ canvasElement }) => {
    const canvas = await settled(canvasElement);
    await canvas.findByText(/Only while a one-time link is open\./);
  },
};

/** A range the user typed, for a network this computer is not on right now. */
export const LocalNetworksTypedRange: Story = {
  parameters: {
    primedBurrow: hosted({ level: 'local', allowed: [...WIFI.prefixes, '10.8.0.0/24'], autoUpdate: false }),
  },
  play: async ({ canvasElement }) => {
    const canvas = await settled(canvasElement);
    await canvas.findByText('Added range · not connected now');
    await userEvent.type(canvas.getByRole('textbox', { name: 'Add an allowed network range' }), '10.9.0.0/24');
    await userEvent.click(canvas.getByRole('button', { name: 'Add' }));
    await canvas.findByText('10.9.0.0/24');
  },
};

/**
 * A phone on cellular reached the code and no further: the Burrow saw its
 * address on the selected pair, and says so above the networks it could join.
 * Dismiss forgets it.
 */
export const LocalNetworksRefusedObserved: Story = {
  parameters: {
    primedBurrow: hosted(
      { level: 'local', allowed: WIFI.prefixes, autoUpdate: false },
      UNENROLLED_STATUS,
      { at: AT_10_42, kind: 'path-refused', end: 'remote', address: '172.58.12.9', addressSource: 'observed' },
    ),
  },
  play: async ({ canvasElement }) => {
    const canvas = await settled(canvasElement);
    const notice = await canvas.findByRole('status', { name: 'Last refused phone' });
    await expect(notice).toHaveTextContent(/a phone tried to connect from 172\.58\.12\.9, which isn’t on a network allowed below\./);
    await userEvent.click(within(notice).getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(canvas.queryByRole('status', { name: 'Last refused phone' })).toBeNull());
  },
};

/** No pair formed, so the address is the one the phone's offer reported, named as its claim and never as off the networks. */
export const LocalNetworksRefusedReported: Story = {
  parameters: {
    primedBurrow: hosted(
      { level: 'local', allowed: WIFI.prefixes, autoUpdate: false },
      UNENROLLED_STATUS,
      { at: AT_10_42, kind: 'given-up', end: 'remote', address: '2607:fb90:1:2::9', addressSource: 'reported' },
    ),
  },
  play: async ({ canvasElement }) => {
    const canvas = await settled(canvasElement);
    await expect(await canvas.findByRole('status', { name: 'Last refused phone' })).toHaveTextContent(
      /a phone couldn’t connect directly over an allowed network \(it reported 2607:fb90:1:2::9\)\./,
    );
  },
};

/** This computer's own end was off the allowed networks: the panel says so, and blames no phone's network. */
export const LocalNetworksRefusedThisComputer: Story = {
  parameters: {
    primedBurrow: hosted(
      { level: 'local', allowed: WIFI.prefixes, autoUpdate: false },
      UNENROLLED_STATUS,
      { at: AT_10_42, kind: 'path-refused', end: 'local', localAddress: '10.0.0.2' },
    ),
  },
  play: async ({ canvasElement }) => {
    const canvas = await settled(canvasElement);
    const notice = await canvas.findByRole('status', { name: 'Last refused phone' });
    await expect(notice).toHaveTextContent(
      /a phone couldn’t connect: this computer wasn’t on a network allowed below \(its address was 10\.0\.0\.2\)\./,
    );
    await expect(notice).not.toHaveTextContent(/tried to connect from/);
  },
};

/** Nothing to name: the phone offered no public address and no pair formed. */
export const LocalNetworksRefusedNoAddress: Story = {
  parameters: {
    primedBurrow: hosted(
      { level: 'local', allowed: WIFI.prefixes, autoUpdate: false },
      UNENROLLED_STATUS,
      { at: AT_10_42, kind: 'deadline' },
    ),
  },
  play: async ({ canvasElement }) => {
    const canvas = await settled(canvasElement);
    await expect(await canvas.findByRole('status', { name: 'Last refused phone' })).toHaveTextContent(
      /a phone couldn’t reach this computer over an allowed network\./,
    );
  },
};

/** Every network switched off: say so, and list no connection that cannot happen. */
export const LocalNetworksNoneAllowed: Story = {
  parameters: { primedBurrow: hosted({ level: 'local', allowed: [], autoUpdate: false }) },
  play: async ({ canvasElement }) => {
    const canvas = await settled(canvasElement);
    await canvas.findByText('No network is allowed, so no phone can connect.');
    await canvas.findByText(/^Nothing\. Terminals, browser panes, and agents/);
  },
};

/**
 * Phones on any network: one-time links only, Cloudflare's STUN as a phone
 * connects, and no allowed networks to pick.
 */
export const Anywhere: Story = {
  parameters: { primedBurrow: hosted(ANYWHERE_ON) },
  play: async ({ canvasElement }) => {
    const canvas = await settled(canvasElement);
    await expect(canvas.getByRole('radio', { name: /^Anywhere/ })).toHaveAttribute('aria-checked', 'true');
    await canvas.findByText(CLOUDFLARE_STUN_HOST);
    await canvas.findByText('Your phone, on any network');
    await canvas.findByText(/Your phone can be on any network\./);
    await expect(canvas.queryByText('Allowed networks')).toBeNull();
  },
};

/** A Hosted build, enrolled, with one phone paired. */
const HOSTED_ENROLLED = { ...UNENROLLED_STATUS, enrolled: true, serving: true, burrowId: 'burrow-6f1c2a90', connection: 'connected', pairedClients: 1 } as const;

/**
 * Enrolled under Local networks: Hosted always, but never terminal traffic —
 * a paired phone connects only directly, on an allowed network.
 */
export const LocalNetworksEnrolled: Story = {
  parameters: { primedBurrow: hosted({ level: 'local', allowed: WIFI.prefixes, autoUpdate: false }, HOSTED_ENROLLED) },
  play: async ({ canvasElement }) => {
    const canvas = await settled(canvasElement);
    await canvas.findByText(/Never terminal traffic\./);
    await canvas.findByText('Your phone, directly, on an allowed network');
    await canvas.findByText('relay.dormouse.sh → your phone’s push service');
    await expect(canvas.queryByText(/Only while a one-time link is open\./)).toBeNull();
  },
};

/** Enrolled under Anywhere: a phone that can't connect directly relays through Hosted. */
export const AnywhereEnrolled: Story = {
  parameters: { primedBurrow: hosted(ANYWHERE_ON, HOSTED_ENROLLED) },
  play: async ({ canvasElement }) => {
    const canvas = await settled(canvasElement);
    await canvas.findByText(/terminal traffic when a phone can’t connect directly\./);
    await canvas.findByText(CLOUDFLARE_STUN_HOST);
    await canvas.findByText('Your phone, directly');
  },
};

/** Walks the choices and checks that the connection list follows. */
export const SwitchingLevels: Story = {
  parameters: { primedBurrow: hosted(nothingPolicy()) },
  play: async ({ canvasElement }) => {
    const canvas = await settled(canvasElement);
    await userEvent.click(canvas.getByRole('radio', { name: /^Local networks/ }));
    await canvas.findByText('Allowed networks');
    await canvas.findByText('Your phone, on an allowed network');
    await userEvent.click(canvas.getByRole('radio', { name: /^Anywhere/ }));
    await canvas.findByText(CLOUDFLARE_STUN_HOST);
    await expect(canvas.queryByText('Allowed networks')).toBeNull();
    await userEvent.click(canvas.getByRole('radio', { name: /^Nowhere/ }));
    await canvas.findByText(/^Nothing\. Terminals, browser panes, and agents/);
    await expect(canvas.queryByText('Allowed networks')).toBeNull();
    await canvas.findByRole('button', { name: 'Local networks only' });
    await canvas.findByRole('button', { name: 'Anywhere' });
  },
};

/** A managed-voice token saved: speaking an alert in it reaches Hosted. */
export const ManagedVoice: Story = {
  parameters: {
    primedBurrow: hosted({ ...LOCAL_ON, allowed: WIFI.prefixes }),
    primedManagedVoice: { configured: true },
  },
  play: async ({ canvasElement }) => {
    const canvas = await settled(canvasElement);
    await canvas.findByText(/When an alert is spoken in the managed voice\./);
  },
};

/** A self-host build: its own Relay or nothing, push through it, and no updater. */
export const SelfHost: Story = {
  parameters: { primedBurrow: selfHost(RELAY_ON, enrolledStatus({ pairedClients: 1 })) },
  play: async ({ canvasElement }) => {
    const canvas = await settled(canvasElement);
    await expect(canvas.getByRole('radio', { name: /^Anywhere, through / })).toHaveAttribute('aria-checked', 'true');
    await canvas.findByText('ned-mac.tail9c2f1.ts.net → your phone’s push service');
    await canvas.findByText('This build never updates itself. Rebuild it from source to update.');
    await canvas.findByText('1 paired phone.');
  },
};

/** A self-host build at Nothing, before enrolling: Anywhere, through its Relay, is the way to a phone. */
export const SelfHostNothing: Story = {
  parameters: { primedBurrow: selfHost(nothingPolicy()) },
  play: async ({ canvasElement }) => {
    const canvas = await settled(canvasElement);
    await canvas.findByRole('button', { name: /^Anywhere, through / });
  },
};

/** Nothing, with an enrollment held: Disconnect, which is local, stays in reach. */
export const SelfHostNothingEnrolled: Story = {
  parameters: { primedBurrow: selfHost(nothingPolicy(), enrolledStatus({ connection: 'stopped', serving: false })) },
  play: async ({ canvasElement }) => {
    const canvas = await settled(canvasElement);
    await canvas.findByText(/which nothing reaches while Network is set to Nowhere/);
    await userEvent.click(canvas.getByRole('button', { name: 'Disconnect' }));
    await canvas.findByText('Paired phones will need to pair again.');
  },
};

/** VS Code: the Marketplace, not Dormouse, updates the extension. */
export const VsCode: Story = {
  parameters: { primedBurrow: hosted({ ...LOCAL_ON, allowed: WIFI.prefixes }), hostOwnsUpdates: true },
  play: async ({ canvasElement }) => {
    const canvas = await settled(canvasElement);
    await canvas.findByText(/installs Dormouse updates from the Marketplace/);
  },
};

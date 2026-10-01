/**
 * The network policy (`docs/specs/remote-network.md` -> "Policy"): the one
 * setting that decides every connection Dormouse opens on its own. Shared by
 * the host that holds and enforces it and the webview that shows it, so it
 * imports nothing DOM or Node — the types, the shape guards both untrusted
 * edges need, and which levels a build offers. Canonical CIDR math is the
 * host's (`lib/src/host/remote/network-interfaces.ts`).
 */

import type { RelayMode } from '../host/relay-origin';
import { isRecord, isStringArray } from '../lib/is-record';

const LEVELS = ['nothing', 'local', 'anywhere', 'relay'] as const;

/**
 * `relay` is the UI's "My Relay only". `anywhere` is reserved for Cloudflare
 * STUN (`docs/specs/remote-network.md` -> "Anywhere"): no build offers it yet.
 */
export type NetworkLevel = (typeof LEVELS)[number];

const isLevel = (value: unknown): value is NetworkLevel =>
  (LEVELS as readonly unknown[]).includes(value);

export interface NetworkPolicy {
  level: NetworkLevel;
  /** Canonical CIDRs a phone's direct path must fall within, under `local`. */
  allowed: string[];
  /** Whether Standalone checks for updates at launch, where the level is not `nothing`. */
  autoUpdate: boolean;
}

const INTERFACE_KINDS = ['lan', 'vpn', 'virtual'] as const;

/** One of this machine's interfaces, as the Allowed networks list offers it. */
export interface NetworkInterfaceInfo {
  /** The OS name, e.g. `en0`, `utun4`. */
  id: string;
  /** What a person calls it, e.g. `Tailscale`. */
  label: string;
  /** `virtual` covers bridge, container, and VM interfaces. */
  kind: (typeof INTERFACE_KINDS)[number];
  /** Canonical CIDRs from the interface's own netmask, both families, link-local left out. */
  prefixes: string[];
}

/** What `networkPolicy` answers and the `network-policy` event carries. */
export interface NetworkPolicyResult {
  policy: NetworkPolicy;
  /** The levels this build offers, in the order the picker lists them. */
  levels: NetworkLevel[];
  interfaces: NetworkInterfaceInfo[];
}

/** The most CIDRs a policy may allow. */
export const MAX_ALLOWED_NETWORKS = 32;

/** The policy that opens nothing: a new install's, and what an unreadable record reads as. */
export function nothingPolicy(): NetworkPolicy {
  return { level: 'nothing', allowed: [], autoUpdate: false };
}

/**
 * The levels a build offers: a Hosted build's `local` (and later `anywhere`),
 * or a self-host build's `relay`. The service refuses any other.
 */
export function levelsFor(mode: RelayMode): NetworkLevel[] {
  return mode === 'self-host' ? ['nothing', 'relay'] : ['nothing', 'local'];
}

/**
 * Whether `level` runs the persistent Burrow — the relay socket and everything
 * that needs it: `relay` alone today. **Every other level holds an enrollment
 * without running it**, since only My Relay only has a path rule for a
 * persistent session (`docs/specs/remote-network.md` → "Policy").
 */
export function runsBurrow(level: NetworkLevel): boolean {
  return level === 'relay';
}

/**
 * Whether `policy` lets a one-time link open: Local networks with at least one
 * network allowed, since a phone's direct path must fall within one
 * (`docs/specs/remote-network.md` → "Local networks").
 */
export function opensOneTimeLinks(policy: NetworkPolicy): boolean {
  return policy.level === 'local' && policy.allowed.length > 0;
}

/** Whether Standalone checks for updates at launch under `policy` (`docs/specs/remote-network.md` → "Updates"). */
export function checksForUpdates(policy: NetworkPolicy): boolean {
  return policy.level !== 'nothing' && policy.autoUpdate;
}

/** What `networkPolicy` answers, for a build of `mode`. */
export function networkPolicyResult(
  policy: NetworkPolicy,
  mode: RelayMode,
  interfaces: NetworkInterfaceInfo[],
): NetworkPolicyResult {
  return { policy, levels: levelsFor(mode), interfaces };
}

/**
 * `value` as a fresh policy if it is one exactly — its three keys and no
 * others, a known level, at most {@link MAX_ALLOWED_NETWORKS} strings — else
 * `null`. Whether each string is a canonical CIDR, and whether this build
 * offers the level, are the service's checks.
 */
export function parseNetworkPolicy(value: unknown): NetworkPolicy | null {
  if (!isRecord(value) || Object.keys(value).length !== 3) return null;
  const { level, allowed, autoUpdate } = value;
  if (!isLevel(level) || !isStringArray(allowed) || allowed.length > MAX_ALLOWED_NETWORKS) return null;
  return typeof autoUpdate === 'boolean' ? { level, allowed: [...allowed], autoUpdate } : null;
}

/**
 * A stored record as a store answers it: `null` when there is none, and
 * **Nothing when there is one that is not a policy**, `null` included — a
 * damaged record must never open a connection the user may have turned off.
 */
export function storedNetworkPolicy(value: unknown): NetworkPolicy | null {
  if (value === undefined) return null;
  return parseNetworkPolicy(value) ?? nothingPolicy();
}

function isNetworkInterfaceInfo(value: unknown): value is NetworkInterfaceInfo {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.label === 'string' &&
    (INTERFACE_KINDS as readonly unknown[]).includes(value.kind) &&
    isStringArray(value.prefixes)
  );
}

/** Whether `value` is a {@link NetworkPolicyResult} a Settings panel can render. */
export function isNetworkPolicyResult(value: unknown): value is NetworkPolicyResult {
  return (
    isRecord(value) &&
    parseNetworkPolicy(value.policy) !== null &&
    Array.isArray(value.levels) &&
    value.levels.every(isLevel) &&
    Array.isArray(value.interfaces) &&
    value.interfaces.every(isNetworkInterfaceInfo)
  );
}

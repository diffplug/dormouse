/**
 * The network policy (`docs/specs/remote-network.md` -> "Policy"): the one
 * setting that decides every connection Dormouse opens on its own. Shared by
 * the host that holds and enforces it and the webview that shows it, so it
 * imports nothing DOM or Node — the types, the shape guards both untrusted
 * edges need, and which levels a build offers. Canonical CIDR math is the
 * host's (`lib/src/host/remote/network-interfaces.ts`).
 */

import type { RelayMode } from '../host/relay-origin';

/**
 * `relay` is the UI's "My Relay only". `anywhere` is reserved for Cloudflare
 * STUN (`docs/specs/remote-network.md` -> "Anywhere"): no build offers it yet.
 */
export type NetworkLevel = 'nothing' | 'local' | 'anywhere' | 'relay';

const LEVELS: ReadonlySet<string> = new Set<NetworkLevel>(['nothing', 'local', 'anywhere', 'relay']);

export interface NetworkPolicy {
  level: NetworkLevel;
  /** Canonical CIDRs a phone's direct path must fall within, under `local`. */
  allowed: string[];
  /** Whether Standalone checks for updates at launch, where the level is not `nothing`. */
  autoUpdate: boolean;
}

/** One of this machine's interfaces, as the Allowed networks list offers it. */
export interface NetworkInterfaceInfo {
  /** The OS name, e.g. `en0`, `utun4`. */
  id: string;
  /** What a person calls it, e.g. `Tailscale`. */
  label: string;
  /** `virtual` covers bridge, container, and VM interfaces. */
  kind: 'lan' | 'vpn' | 'virtual';
  /** Canonical CIDRs from the interface's own netmask, both families, IPv6 link-local left out. */
  prefixes: string[];
}

const INTERFACE_KINDS: ReadonlySet<string> = new Set<NetworkInterfaceInfo['kind']>(['lan', 'vpn', 'virtual']);

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

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

/**
 * Whether `value` is a policy, exactly: its three keys and no others, a known
 * level, at most {@link MAX_ALLOWED_NETWORKS} strings. Whether each string is a
 * canonical CIDR, and whether this build offers the level, are the service's
 * checks.
 */
export function isNetworkPolicy(value: unknown): value is NetworkPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return (
    keys.length === 3 &&
    typeof record.level === 'string' &&
    LEVELS.has(record.level) &&
    isStringArray(record.allowed) &&
    record.allowed.length <= MAX_ALLOWED_NETWORKS &&
    typeof record.autoUpdate === 'boolean'
  );
}

/**
 * A stored record as a store answers it: `null` when there is none, and
 * **Nothing when there is one that is not a policy** — a damaged record must
 * never open a connection the user may have turned off.
 */
export function storedNetworkPolicy(value: unknown): NetworkPolicy | null {
  if (value === undefined || value === null) return null;
  return isNetworkPolicy(value)
    ? { level: value.level, allowed: [...value.allowed], autoUpdate: value.autoUpdate }
    : nothingPolicy();
}

function isNetworkInterfaceInfo(value: unknown): value is NetworkInterfaceInfo {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === 'string' &&
    typeof record.label === 'string' &&
    typeof record.kind === 'string' &&
    INTERFACE_KINDS.has(record.kind) &&
    isStringArray(record.prefixes)
  );
}

/** Whether `value` is a {@link NetworkPolicyResult} a Settings panel can render. */
export function isNetworkPolicyResult(value: unknown): value is NetworkPolicyResult {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    isNetworkPolicy(record.policy) &&
    Array.isArray(record.levels) &&
    record.levels.every((level) => typeof level === 'string' && LEVELS.has(level)) &&
    Array.isArray(record.interfaces) &&
    record.interfaces.every(isNetworkInterfaceInfo)
  );
}

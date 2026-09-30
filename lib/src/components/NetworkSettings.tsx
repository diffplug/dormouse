import { useCallback, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react';
import { clsx } from 'clsx';
import { SwitchRow } from './AlarmSettingsControls';
import { OnOffSwitch, SUBTLE_ACTION_COLOR_CLASS, SUBTLE_ACTION_INTERACTION_CLASS, TextInput, UNDER_SWITCH_INDENT, modalActionButton } from './design';
import { useManagedVoiceConfigured } from './ManagedVoiceSection';
import { RemoteControlSection } from './RemoteControlSection';
import type { BurrowConsoleStatus } from '../host/remote/service-protocol';
import type { RelayMode } from '../host/relay-origin';
import { getPlatform } from '../lib/platform';
import type { UpdatesPort, UpdatesSnapshot } from '../lib/platform/types';
import { getAlertSettings, subscribeToAlertSettings } from '../lib/terminal-registry';
import { getBurrowStatusSnapshot, subscribeToBurrowStatus } from '../remote/burrow/burrow-status-store';
import {
  getNetworkPolicySnapshot,
  setNetworkPolicy,
  subscribeToNetworkPolicy,
} from '../remote/burrow/network-policy-store';
import {
  MAX_ALLOWED_NETWORKS,
  type NetworkInterfaceInfo,
  type NetworkLevel,
  type NetworkPolicy,
  type NetworkPolicyResult,
} from '../remote/network-policy';

/**
 * Settings → Network (`docs/specs/remote-network.md` -> "Settings → Network"):
 * one choice decides every connection Dormouse opens on its own, and
 * {@link connectionsFor} lists exactly those connections. Three parts, each its
 * own search group in the Settings dialog — {@link NetworkSettings} (the
 * choice, the list, the allowed networks), {@link NetworkPhones}, and
 * {@link NetworkUpdates} — and all three render nothing without a Burrow
 * service, which holds the policy.
 *
 * **The service is the only writer.** Every change goes out as a whole policy
 * through `setNetworkPolicy`, and what renders is the store's mirror of the
 * service's answer, never a local draft.
 */

/** The Burrow service's two answers every part reads: the policy, and the build it runs in. */
type NetworkView =
  | { kind: 'unsupported' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; network: NetworkPolicyResult; status: BurrowConsoleStatus };

function useNetworkView(): NetworkView {
  const network = useSyncExternalStore(subscribeToNetworkPolicy, getNetworkPolicySnapshot);
  const burrow = useSyncExternalStore(subscribeToBurrowStatus, getBurrowStatusSnapshot);
  if (network.kind === 'unsupported' || burrow.kind === 'unsupported') return { kind: 'unsupported' };
  if (network.kind === 'error') return network;
  if (burrow.kind === 'error') return burrow;
  if (network.kind === 'loading' || burrow.kind === 'loading') return { kind: 'loading' };
  return { kind: 'ready', network: network.network, status: burrow.status };
}

/** The level as the service holds it, or `null` before it answers or without a service. */
export function useNetworkLevel(): NetworkLevel | null {
  const network = useSyncExternalStore(subscribeToNetworkPolicy, getNetworkPolicySnapshot);
  return network.kind === 'ready' ? network.network.policy.level : null;
}

/** A change sent to the service, and the refusal it answered, if any. */
function useSave() {
  const [error, setError] = useState<string | null>(null);
  const save = useCallback(async (next: NetworkPolicy): Promise<boolean> => {
    setError(null);
    try {
      await setNetworkPolicy(next);
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return false;
    }
  }, []);
  return { error, save };
}

/**
 * The policy choosing `level` makes. **Local networks chosen with nothing
 * allowed first allows every prefix of this machine's `lan` interfaces**, never
 * a VPN or virtual one; the service never fills them in.
 */
export function policyForLevel(network: NetworkPolicyResult, level: NetworkLevel): NetworkPolicy {
  const { policy, interfaces } = network;
  if (level !== 'local' || policy.allowed.length > 0) return { ...policy, level };
  const lan = interfaces.filter((item) => item.kind === 'lan').flatMap((item) => item.prefixes);
  return { ...policy, level, allowed: [...new Set(lan)].slice(0, MAX_ALLOWED_NETWORKS) };
}

/** An origin's host, as the copy names it. */
function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

interface LevelChoice {
  level: NetworkLevel;
  title: string;
  detail: string;
}

/**
 * What the picker says for `level`, or `null` for one this build has no copy
 * for, which is not offered: `anywhere` until its stage ships.
 */
function choiceFor(level: NetworkLevel, relayOrigin: string): LevelChoice | null {
  const relay = hostOf(relayOrigin);
  switch (level) {
    case 'nothing':
      return {
        level,
        title: 'Nothing',
        detail: 'Dormouse opens no connections on its own. Phones can’t reach this computer.',
      };
    case 'local':
      return {
        level,
        title: 'Local networks',
        detail: `Phones connect only over networks you choose. ${relay} introduces them but never carries your terminals.`,
      };
    case 'relay':
      return {
        level,
        title: 'My Relay only',
        detail: `Phones reach this computer through ${relay}. Nothing else is contacted.`,
      };
    case 'anywhere':
      return null;
  }
}

/** The choices the service offers, in its order. */
function choicesFor(network: NetworkPolicyResult, status: BurrowConsoleStatus): LevelChoice[] {
  return network.levels.flatMap((level) => choiceFor(level, status.relayOrigin) ?? []);
}

export interface ConnectionRow {
  to: string;
  when: string;
  carries: string;
}

/** What {@link connectionsFor} reads. */
export interface NetworkFacts {
  policy: NetworkPolicy;
  /** The build's baked relay origin and mode, as `status` carries them. */
  relayOrigin: string;
  relayMode: RelayMode;
  enrolled: boolean;
  pairedClients: number;
  /** Push notifications are on in the application's alert settings. */
  pushEnabled: boolean;
  /** A managed-voice token is saved. */
  managedVoice: boolean;
  /** This window has the updater's port: a Standalone build that checks for updates. */
  updater: boolean;
}

const UPDATES_HOST = 'dormouse.sh';

/**
 * Every connection this computer opens on its own under `facts`, and nothing
 * else — each row backed by code (`docs/specs/remote-network.md` -> "Settings →
 * Network"). Terminals and browser panes reach whatever the user points them
 * at; those are the user's connections, not Dormouse's.
 */
export function connectionsFor(facts: NetworkFacts): ConnectionRow[] {
  const { policy } = facts;
  if (policy.level === 'nothing') return [];
  const relay = hostOf(facts.relayOrigin);
  const rows: ConnectionRow[] = [];
  if (policy.level === 'local' && policy.allowed.length > 0) {
    rows.push(
      {
        to: relay,
        when: 'Only while a one-time link is open',
        carries: 'Encrypted handshakes. Never terminal traffic.',
      },
      {
        to: 'Your phone, on an allowed network',
        when: 'While connected',
        carries: 'Terminal traffic, end-to-end encrypted.',
      },
    );
  }
  if (policy.level === 'relay') {
    rows.push(
      {
        to: relay,
        when: facts.enrolled ? 'Always' : 'Always, once this computer is enrolled',
        carries: 'Encrypted handshakes, and terminal traffic when a phone can’t connect directly.',
      },
      {
        to: 'Your phone, directly',
        when: 'While connected',
        carries: 'Terminal traffic, end-to-end encrypted.',
      },
    );
    if (facts.pushEnabled && facts.pairedClients > 0) {
      rows.push({
        to: `${relay} → your phone’s push service`,
        when: 'When an alert goes unattended',
        carries: 'An end-to-end encrypted notification.',
      });
    }
  }
  if (facts.managedVoice && facts.relayMode === 'hosted') {
    rows.push({
      to: relay,
      when: 'When an alert is spoken in the managed voice',
      carries: 'The pane’s name and the voice id, which Hosted passes to ElevenLabs.',
    });
  }
  if (policy.autoUpdate && facts.updater) {
    rows.push({
      to: UPDATES_HOST,
      when: 'Each launch',
      carries: 'A request for the newest version number. Downloading one waits for you.',
    });
  }
  return rows;
}

const SECTION = 'mt-4 border-t border-border pt-3';
const LABEL = 'text-sm text-foreground';
const HINT = 'mt-1 text-sm leading-relaxed text-muted';
const ERROR = 'mt-2 text-sm leading-relaxed text-error';
/** A link-like action inside running text. */
const INLINE_ACTION = clsx('rounded px-0.5', SUBTLE_ACTION_COLOR_CLASS, SUBTLE_ACTION_INTERACTION_CLASS);

/** The choice, what it connects to, and — under Local networks — the allowed networks. */
export function NetworkSettings() {
  const view = useNetworkView();
  const { error, save } = useSave();
  const settings = useSyncExternalStore(subscribeToAlertSettings, getAlertSettings);
  const managedVoice = useManagedVoiceConfigured();

  if (view.kind === 'unsupported') return null;
  if (view.kind === 'loading') return <div className={`mt-4 ${HINT}`}>Checking…</div>;
  if (view.kind === 'error') {
    return <div className={`mt-4 ${HINT}`}>Could not read this computer’s network setting: {view.message}</div>;
  }
  const { network, status } = view;
  const { policy } = network;
  const rows = connectionsFor({
    policy,
    relayOrigin: status.relayOrigin,
    relayMode: status.relayMode,
    enrolled: status.enrolled,
    pairedClients: status.pairedClients,
    pushEnabled: settings.pushEnabled,
    managedVoice,
    updater: getPlatform().updates !== undefined,
  });
  return (
    <div className="mt-4">
      <LevelPicker
        choices={choicesFor(network, status)}
        level={policy.level}
        onLevel={(level) => {
          if (level !== policy.level) void save(policyForLevel(network, level));
        }}
      />
      {error ? <div className={ERROR}>{error}</div> : null}
      <ConnectionList rows={rows} />
      {policy.level === 'local' ? (
        <AllowedNetworks interfaces={network.interfaces} policy={policy} />
      ) : null}
    </div>
  );
}

function LevelPicker({ choices, level, onLevel }: {
  choices: LevelChoice[];
  level: NetworkLevel;
  onLevel: (level: NetworkLevel) => void;
}) {
  const group = useRef<HTMLDivElement>(null);
  const move = (event: KeyboardEvent, position: number) => {
    const step = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1
      : event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = (position + step + choices.length) % choices.length;
    onLevel(choices[next].level);
    (group.current?.children[next] as HTMLElement | undefined)?.focus();
  };
  return (
    <div>
      <div id="network-level-label" className={LABEL}>Connections Dormouse makes on its own</div>
      <div ref={group} role="radiogroup" aria-labelledby="network-level-label" className="mt-1.5 flex flex-col gap-1">
        {choices.map((choice, position) => {
          const selected = choice.level === level;
          return (
            <button
              key={choice.level}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={selected ? 0 : -1}
              onClick={() => onLevel(choice.level)}
              onKeyDown={(event) => move(event, position)}
              className="flex items-start gap-2 rounded px-1 py-1 text-left hover:bg-current/10 focus-visible:outline focus-visible:outline-focus-ring"
            >
              <span
                aria-hidden
                className={clsx(
                  'mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full',
                  selected ? 'bg-link/25' : 'bg-foreground/10',
                )}
              >
                {selected ? <span className="h-2 w-2 rounded-full bg-link" /> : null}
              </span>
              <span className="min-w-0">
                <span className={clsx('block text-sm', selected ? 'font-semibold text-foreground' : 'text-foreground')}>
                  {choice.title}
                </span>
                <span className="block text-sm leading-relaxed text-muted">{choice.detail}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ConnectionList({ rows }: { rows: ConnectionRow[] }) {
  return (
    <section className={SECTION} aria-labelledby="network-connections-label">
      <div id="network-connections-label" className={LABEL}>What this computer connects to</div>
      {rows.length === 0 ? (
        <div className={HINT}>
          Nothing. Terminals and browser panes still reach whatever you open in them, including
          panes restored at launch.
        </div>
      ) : (
        <dl className="mt-1.5 grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-x-4 text-sm">
          {rows.map((row, position) => (
            <div key={position} className="col-span-2 grid grid-cols-subgrid border-t border-border py-1 first:border-t-0">
              <dt className="break-words text-foreground">{row.to}</dt>
              <dd className="leading-relaxed text-muted">{row.when}. {row.carries}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

/** A loose CIDR shape check to enable Add; the service's canonical check is the gate. */
function looksLikeCidr(text: string): boolean {
  return /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/.test(text) || /^[0-9a-f:]+\/\d{1,3}$/i.test(text);
}

function AllowedNetworks({ interfaces, policy }: { interfaces: NetworkInterfaceInfo[]; policy: NetworkPolicy }) {
  const [draft, setDraft] = useState('');
  const { error, save } = useSave();
  const { allowed } = policy;
  // An interface with no prefix to allow (IPv6 link-local only) has no row.
  const offered = interfaces.filter((item) => item.prefixes.length > 0);
  const known = new Set(offered.flatMap((item) => item.prefixes));
  const typed = allowed.filter((cidr) => !known.has(cidr));
  const change = (next: string[]) => save({ ...policy, allowed: next });
  const add = (cidrs: string[]) => change([...allowed, ...cidrs.filter((cidr) => !allowed.includes(cidr))]);
  const remove = (cidrs: string[]) => change(allowed.filter((cidr) => !cidrs.includes(cidr)));
  const range = draft.trim().toLowerCase();

  return (
    <section className={SECTION} aria-labelledby="network-allowed-label">
      <div id="network-allowed-label" className={LABEL}>Allowed networks</div>
      <div className={HINT}>A phone connects only when both ends of its connection are on one of these.</div>
      <div className="mt-2 flex flex-col gap-1.5">
        {offered.map((item) => (
          <NetworkRow
            key={item.id}
            control={<OnOffSwitch
              on={item.prefixes.every((cidr) => allowed.includes(cidr))}
              label={`Allow ${item.label}`}
              onEnable={() => void add(item.prefixes)}
              onDisable={() => void remove(item.prefixes)}
            />}
            name={`${item.label} · ${item.id}`}
            prefixes={item.prefixes}
          />
        ))}
        {typed.map((cidr) => (
          <NetworkRow
            key={cidr}
            control={<button
              type="button"
              className={clsx('h-6 w-15 shrink-0 rounded px-1 text-left text-sm', SUBTLE_ACTION_COLOR_CLASS, SUBTLE_ACTION_INTERACTION_CLASS)}
              onClick={() => void remove([cidr])}
            >
              Remove
            </button>}
            name="Added range · not connected now"
            prefixes={[cidr]}
          />
        ))}
      </div>
      <form
        className={`${UNDER_SWITCH_INDENT} mt-2 flex items-center gap-2`}
        onSubmit={(event) => {
          event.preventDefault();
          if (!looksLikeCidr(range)) return;
          void add([range]).then((saved) => {
            if (saved) setDraft('');
          });
        }}
      >
        <TextInput
          value={draft}
          onChange={setDraft}
          placeholder="Add a range, e.g. 10.8.0.0/24"
          aria-label="Add an allowed network range"
          className="text-sm"
        />
        <button type="submit" disabled={!looksLikeCidr(range)} className={modalActionButton()}>Add</button>
      </form>
      {error ? <div className={`${UNDER_SWITCH_INDENT} ${ERROR}`}>{error}</div> : null}
      {allowed.length === 0 ? (
        <div className={`${UNDER_SWITCH_INDENT} ${ERROR}`}>
          No network is allowed, so no phone can connect.
        </div>
      ) : null}
      <div className={`${UNDER_SWITCH_INDENT} ${HINT}`}>
        A range matches any network using the same addresses, so another Wi-Fi on 192.168.1.x matches
        192.168.1.0/24 too. Pairing still decides which phones may connect.
      </div>
    </section>
  );
}

function NetworkRow({ control, name, prefixes }: { control: ReactNode; name: string; prefixes: string[] }) {
  return (
    <div className="flex items-start gap-3">
      {control}
      <div className="min-w-0 pt-0.5 text-sm">
        <div className="text-foreground">{name}</div>
        <div className="break-all text-muted">{prefixes.join('  ')}</div>
      </div>
    </div>
  );
}

/**
 * The ways a phone reaches this computer: under any level but Nothing, the
 * Remote control choices; under Nothing, the levels that allow one, each a
 * shortcut to itself.
 */
export function NetworkPhones() {
  const view = useNetworkView();
  const { error, save } = useSave();
  if (view.kind !== 'ready') return null;
  const { network, status } = view;
  const choices = choicesFor(network, status).filter((choice) => choice.level !== 'nothing');
  return (
    <section className={SECTION} aria-labelledby="network-phones-label">
      <div id="network-phones-label" className={LABEL}>Phones</div>
      {network.policy.level === 'nothing' ? (
        <div className={HINT}>
          Choose{' '}
          {choices.map((choice, position) => (
            <span key={choice.level}>
              {position > 0 ? (position === choices.length - 1 ? ' or ' : ', ') : null}
              <button
                type="button"
                className={INLINE_ACTION}
                onClick={() => void save(policyForLevel(network, choice.level))}
              >
                {choice.title}
              </button>
            </span>
          ))}
          {' '}to connect a phone.
        </div>
      ) : (
        <RemoteControlSection />
      )}
      {error ? <div className={ERROR}>{error}</div> : null}
    </section>
  );
}

/** The updater's snapshot, or `null` where this window has no port. */
function useUpdates(port: UpdatesPort | undefined): UpdatesSnapshot | null {
  const subscribe = useCallback((listener: () => void) => port?.subscribe(listener) ?? (() => {}), [port]);
  const snapshot = useCallback(() => port?.getSnapshot() ?? null, [port]);
  return useSyncExternalStore(subscribe, snapshot);
}

/**
 * Update checks: the switch under any level but Nothing, and — where this
 * window has the updater's port — the last check and Check now. A self-host
 * build and VS Code have no updater of Dormouse's to show.
 */
export function NetworkUpdates() {
  const view = useNetworkView();
  const { error, save } = useSave();
  const port = getPlatform().updates;
  const updates = useUpdates(port);
  if (view.kind !== 'ready') return null;
  const { policy } = view.network;

  if (view.status.relayMode === 'self-host') {
    return (
      <section className={SECTION}>
        <div className={LABEL}>Updates</div>
        <div className={HINT}>This build never updates itself. Rebuild it from source to update.</div>
      </section>
    );
  }
  if (getPlatform().hostOwnsUpdates) {
    return (
      <section className={SECTION}>
        <div className={LABEL}>Updates</div>
        <div className={HINT}>VS Code installs Dormouse updates from the Marketplace, following its own extension update setting.</div>
      </section>
    );
  }
  const off = policy.level === 'nothing';
  const auto = !off && policy.autoUpdate;
  return (
    <section className={SECTION}>
      {off ? (
        <div className={LABEL}>Updates</div>
      ) : (
        <SwitchRow
          label="Check for updates automatically"
          on={policy.autoUpdate}
          onChange={(autoUpdate) => void save({ ...policy, autoUpdate })}
        />
      )}
      <div className={off ? HINT : `${UNDER_SWITCH_INDENT} ${HINT}`}>
        {auto ? 'Checked at each launch.' : 'Checked only when you ask.'}
        {port && updates ? (
          <>
            {' '}
            {updates.checkedAt === null
              ? 'Never checked on this computer.'
              : `Last checked ${daysAgo(updates.checkedAt)}.`}{' '}
            <button
              type="button"
              disabled={updates.checking}
              className={INLINE_ACTION}
              onClick={() => port.checkNow()}
            >
              {updates.checking ? 'Checking…' : 'Check now'}
            </button>
            <div>The bottom bar reminds you after a week without a successful check.</div>
          </>
        ) : null}
        {error ? <div className={ERROR}>{error}</div> : null}
      </div>
    </section>
  );
}

function daysAgo(at: number): string {
  const days = Math.floor((Date.now() - at) / 86_400_000);
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
}

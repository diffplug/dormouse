import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react';
import { clsx } from 'clsx';
import { SwitchRow } from './AlarmSettingsControls';
import {
  INLINE_ACTION_CLASS,
  OnOffSwitch,
  SETTINGS_SECTION,
  SUBTLE_ACTION_COLOR_CLASS,
  SUBTLE_ACTION_INTERACTION_CLASS,
  TextInput,
  UNDER_SWITCH_INDENT,
  modalActionButton,
} from './design';
import { useManagedVoiceConfigured } from './ManagedVoiceSection';
import { hostOf, pathRefusalSentence, useBusyAction } from './remote-control-shared';
import { HeldEnrollment, RemoteControlSection } from './RemoteControlSection';
import { relayRefuses, type BurrowConsoleStatus } from '../host/remote/service-protocol';
import { HOSTED_VOICE_ORIGIN } from '../host/relay-origin';
import { getPlatform } from '../lib/platform';
import { CLOUDFLARE_STUN_HOST } from '../remote/direct/ice-servers';
import type { UpdatesPort, UpdatesSnapshot } from '../lib/platform/types';
import { getBurrowStatusSnapshot, subscribeToBurrowStatus } from '../remote/burrow/burrow-status-store';
import type { PathRefusal } from '../remote/direct/path-refusal';
import {
  changeNetworkPolicy,
  dismissPathRefusal,
  getNetworkPolicySnapshot,
  refreshNetworkPolicy,
  subscribeToNetworkPolicy,
} from '../remote/burrow/network-policy-store';
import {
  MAX_ALLOWED_NETWORKS,
  burrowUsesStun,
  checksForUpdates,
  holdsToAllowedNetworks,
  opensOneTimeLinks,
  phoneOnAnyNetwork,
  runsBurrow,
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
 * through `changeNetworkPolicy`, made from the service's latest answer, and what
 * renders is the store's mirror of it, never a local draft.
 */

/**
 * The Burrow service's two answers every part reads: the policy, and the build
 * it runs in. `error` carries the sentence to show.
 */
type NetworkView =
  | { kind: 'unsupported' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; network: NetworkPolicyResult; status: BurrowConsoleStatus };

function useNetworkView(): NetworkView {
  const network = useSyncExternalStore(subscribeToNetworkPolicy, getNetworkPolicySnapshot);
  const burrow = useSyncExternalStore(subscribeToBurrowStatus, getBurrowStatusSnapshot);
  if (network.kind === 'unsupported' || burrow.kind === 'unsupported') return { kind: 'unsupported' };
  if (network.kind === 'error') {
    return { kind: 'error', message: `Could not read this computer’s network setting: ${network.message}` };
  }
  if (burrow.kind === 'error') {
    return { kind: 'error', message: `Could not reach this computer’s remote-control service: ${burrow.message}` };
  }
  if (network.kind === 'loading' || burrow.kind === 'loading') return { kind: 'loading' };
  return { kind: 'ready', network: network.network, status: burrow.status };
}

type NetworkChange = Parameters<typeof changeNetworkPolicy>[0];

/**
 * A change sent to the service, and the refusal it answered, if any. `change`
 * reads the policy as the service last answered it, never as this render
 * showed it (`changeNetworkPolicy`).
 */
function useSave() {
  const { error, run } = useBusyAction();
  const save = useCallback((change: NetworkChange) => run(() => changeNetworkPolicy(change)), [run]);
  return { error, save };
}

/**
 * The policy choosing `level` makes. **Local networks chosen with nothing
 * allowed first allows every prefix of this machine's `lan` interfaces**, never
 * a VPN or virtual one; the service never fills them in.
 */
export function policyForLevel(network: NetworkPolicyResult, level: NetworkLevel): NetworkPolicy {
  const { policy, interfaces } = network;
  if (!holdsToAllowedNetworks(level) || policy.allowed.length > 0) return { ...policy, level };
  const lan = interfaces.filter((item) => item.kind === 'lan').flatMap((item) => item.prefixes);
  return { ...policy, level, allowed: [...new Set(lan)].slice(0, MAX_ALLOWED_NETWORKS) };
}

/** The change choosing `level` makes, or none when it is already the level. */
const chooseLevel = (level: NetworkLevel): NetworkChange => (network) =>
  network.policy.level === level ? null : policyForLevel(network, level);

interface LevelChoice {
  level: NetworkLevel;
  title: string;
  detail: string;
}

/**
 * What the picker says for `level`: what the level is for. What it connects to
 * is {@link connectionsFor}'s alone.
 */
function choiceFor(level: NetworkLevel, relayOrigin: string): Omit<LevelChoice, 'level'> {
  switch (level) {
    case 'nothing':
      return { title: 'Nothing', detail: 'Dormouse opens no connections on its own, and phones can’t reach it.' };
    case 'local':
      return { title: 'Local networks', detail: 'Phones connect only over networks you choose.' };
    case 'anywhere':
      return { title: 'Anywhere', detail: 'Phones connect directly from any network.' };
    case 'relay':
      return {
        title: 'My Relay only',
        detail: `Phones reach Dormouse through ${hostOf(relayOrigin)}, the Relay this build was made for.`,
      };
  }
}

/** The choices the service offers, in its order. */
function choicesFor(network: NetworkPolicyResult, status: BurrowConsoleStatus): LevelChoice[] {
  return network.levels.map((level) => ({ level, ...choiceFor(level, status.relayOrigin) }));
}

interface ConnectionRow {
  to: string;
  when: string;
  carries: string;
}

/** What {@link connectionsFor} reads. */
export interface NetworkFacts {
  policy: NetworkPolicy;
  /** The build's relay origin and mode, the enrollment, its relay socket, and its paired phones. */
  status: Pick<BurrowConsoleStatus, 'relayOrigin' | 'relayMode' | 'enrolled' | 'connection' | 'pairedClients'>;
  /** A managed-voice token is saved. */
  managedVoice: boolean;
  /** This build checks for its own updates ({@link updatesItself}). */
  updater: boolean;
}

const UPDATES_HOST = 'dormouse.sh';

/**
 * Whether this build checks for its own updates: not a self-host build, which
 * never does, nor one whose host updates Dormouse (`hostOwnsUpdates`). True in
 * every window of such a build, though only the main one holds the updater's
 * `updates` port (`docs/specs/auto-update.md` -> "Threading").
 */
function updatesItself(status: Pick<BurrowConsoleStatus, 'relayMode'>): boolean {
  return status.relayMode !== 'self-host' && !getPlatform().hostOwnsUpdates;
}

/**
 * What the relay socket carries under `policy`: one-time links only where one
 * opens, and under Local networks never terminal traffic, which a paired
 * phone's session may not take through the relay
 * (`docs/specs/remote-network.md` -> "Local networks").
 */
function persistentRelayCarries(policy: NetworkPolicy): string {
  const handshakes = opensOneTimeLinks(policy) ? 'Encrypted handshakes and one-time links' : 'Encrypted handshakes';
  const requests = `${handshakes}, requests for setup codes and the push device list`;
  return holdsToAllowedNetworks(policy.level)
    ? `${requests}. Never terminal traffic.`
    : `${requests}, and terminal traffic when a phone can’t connect directly.`;
}

/** Where the phone row says the phone is: on any network, an allowed one, or simply directly. */
function phoneRowFor(policy: NetworkPolicy, persistent: boolean): string {
  if (policy.level === 'relay') return 'Your phone, directly';
  if (phoneOnAnyNetwork(policy)) return persistent ? 'Your phone, directly' : 'Your phone, on any network';
  return persistent ? 'Your phone, directly, on an allowed network' : 'Your phone, on an allowed network';
}

/**
 * Every connection Dormouse opens on its own under `facts`, and nothing
 * else — each row backed by code (`docs/specs/remote-network.md` -> "Settings →
 * Network"). Terminals and browser panes reach whatever the user points them
 * at; those are the user's connections, not Dormouse's.
 */
export function connectionsFor(facts: NetworkFacts): ConnectionRow[] {
  const { policy, status } = facts;
  if (policy.level === 'nothing') return [];
  const relay = hostOf(status.relayOrigin);
  const rows: ConnectionRow[] = [];
  const oneTime = opensOneTimeLinks(policy);
  // The relay socket: a self-host build's, enrolled or about to be; a Hosted
  // build's once it is enrolled, the one-time links riding the same origin.
  // None while the Relay no longer takes this Burrow, which asks it nothing.
  const refused = status.enrolled && relayRefuses(status.connection);
  const persistent =
    runsBurrow(policy.level) && (status.relayMode === 'self-host' || status.enrolled) && !refused;
  if (persistent) {
    rows.push({
      to: relay,
      when: status.enrolled ? 'Always' : 'Always, once this computer is enrolled',
      carries: persistentRelayCarries(policy),
    });
  } else if (oneTime) {
    rows.push({
      to: relay,
      when: 'Only while a one-time link is open',
      carries: 'Encrypted handshakes. Never terminal traffic.',
    });
  }
  // The transport's own predicate, so the row and the gathering never disagree.
  if (oneTime && burrowUsesStun(policy.level)) {
    rows.push({
      to: CLOUDFLARE_STUN_HOST,
      when: 'When a phone connects',
      carries: 'A lookup that shows Cloudflare this computer’s public IP address.',
    });
  }
  // A phone reaches this computer directly wherever one can connect at all —
  // not under Local networks with nothing allowed, nor under My Relay only
  // once that Relay refuses this Burrow.
  if (oneTime || (policy.level === 'relay' && !refused)) {
    rows.push({
      to: phoneRowFor(policy, persistent),
      when: 'While connected',
      carries: 'Terminal traffic, end-to-end encrypted.',
    });
  }
  // Whether push is on is the application's default and every Workspace's
  // own, some in other windows, so the row names the condition instead.
  if (persistent && status.pairedClients > 0) {
    rows.push({
      to: `${relay} → your phone’s push service`,
      when: 'When an alert goes unattended, where push is on',
      carries: 'An end-to-end encrypted notification.',
    });
  }
  if (facts.managedVoice && status.relayMode === 'hosted') {
    rows.push({
      to: hostOf(HOSTED_VOICE_ORIGIN),
      when: 'When an alert is spoken in the managed voice',
      carries: 'The pane’s name and the voice id, which Hosted passes to ElevenLabs.',
    });
  }
  if (checksForUpdates(policy) && facts.updater) {
    rows.push({
      to: UPDATES_HOST,
      when: 'Each launch',
      carries: 'A request for the newest version number. Downloading one waits for you.',
    });
  }
  return rows;
}

const LABEL = 'text-sm text-foreground';
const HINT = 'mt-1 text-sm leading-relaxed text-muted';
const ERROR = 'mt-2 text-sm leading-relaxed text-error';

/** The choice, what it connects to, and — under Local networks — the allowed networks. */
export function NetworkSettings() {
  const view = useNetworkView();
  const { error, save } = useSave();
  const managedVoice = useManagedVoiceConfigured();
  // The Baseboard keeps the store subscribed for the window's life, so this is
  // what re-reads the interfaces and recovers a first read that failed.
  useEffect(() => void refreshNetworkPolicy(), []);

  if (view.kind === 'unsupported') return null;
  if (view.kind === 'loading') return <div className={`mt-4 ${HINT}`}>Checking…</div>;
  if (view.kind === 'error') return <div className={`mt-4 ${HINT}`}>{view.message}</div>;
  const { network, status } = view;
  const { policy } = network;
  const rows = connectionsFor({ policy, status, managedVoice, updater: updatesItself(status) });
  return (
    <div className="mt-4">
      <LevelPicker
        choices={choicesFor(network, status)}
        level={policy.level}
        onLevel={(level) => void save(chooseLevel(level))}
      />
      {error ? <div className={ERROR}>{error}</div> : null}
      <ConnectionList rows={rows} />
      {holdsToAllowedNetworks(policy.level) ? <AllowedNetworks network={network} /> : null}
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
              aria-labelledby={`network-level-${choice.level}`}
              aria-describedby={`network-level-${choice.level}-detail`}
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
                <span
                  id={`network-level-${choice.level}`}
                  className={clsx('block text-sm text-foreground', selected && 'font-semibold')}
                >
                  {choice.title}
                </span>
                <span id={`network-level-${choice.level}-detail`} className="block text-sm leading-relaxed text-muted">
                  {choice.detail}
                </span>
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
    <section className={SETTINGS_SECTION} aria-labelledby="network-connections-label">
      <div id="network-connections-label" className={LABEL}>What Dormouse connects to</div>
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

/** Whether every prefix of `item` is allowed, which is when its switch reads On. */
function allOn(item: NetworkInterfaceInfo, allowed: readonly string[]): boolean {
  return item.prefixes.every((cidr) => allowed.includes(cidr));
}

function AllowedNetworks({ network }: { network: NetworkPolicyResult }) {
  const [draft, setDraft] = useState('');
  const { error, save } = useSave();
  const { interfaces, policy: { allowed } } = network;
  // **Every allowed range is shown**: one no switch reading On covers — typed,
  // or part of an interface only partly allowed — gets a row of its own.
  const covered = new Set(interfaces.filter((item) => allOn(item, allowed)).flatMap((item) => item.prefixes));
  const listed = allowed.filter((cidr) => !covered.has(cidr));
  // Each against the service's latest answer, so quick clicks compose.
  const change = (next: (allowed: string[]) => string[]) =>
    save(({ policy: latest }) => {
      const nextAllowed = next(latest.allowed);
      if (nextAllowed.length > MAX_ALLOWED_NETWORKS) {
        throw new Error(`At most ${MAX_ALLOWED_NETWORKS} ranges can be allowed. Remove one first.`);
      }
      return { ...latest, allowed: nextAllowed };
    });
  const add = (cidrs: string[]) => change((now) => [...now, ...cidrs.filter((cidr) => !now.includes(cidr))]);
  const remove = (cidr: string) => change((now) => now.filter((other) => other !== cidr));
  // Off keeps a range another switch reading On still needs.
  const switchOff = (item: NetworkInterfaceInfo) =>
    change((now) => {
      const kept = new Set(
        interfaces.filter((other) => other !== item && allOn(other, now)).flatMap((other) => other.prefixes),
      );
      return now.filter((cidr) => !item.prefixes.includes(cidr) || kept.has(cidr));
    });
  const range = draft.trim().toLowerCase();

  return (
    <section className={SETTINGS_SECTION} aria-labelledby="network-allowed-label">
      <div id="network-allowed-label" className={LABEL}>Allowed networks</div>
      <div className={HINT}>A phone connects only when both ends of its connection are on one of these.</div>
      {network.refusal ? <PathRefusalNotice refusal={network.refusal} /> : null}
      <div className="mt-2 flex flex-col gap-1.5">
        {interfaces.map((item) => (
          <NetworkRow
            key={item.id}
            control={<OnOffSwitch
              on={allOn(item, allowed)}
              label={`Allow ${item.label} ${item.id}`}
              onEnable={() => void add(item.prefixes)}
              onDisable={() => void switchOff(item)}
            />}
            name={`${item.label} · ${item.id}`}
            prefixes={item.prefixes}
          />
        ))}
        {listed.map((cidr) => {
          const owner = interfaces.find((item) => item.prefixes.includes(cidr));
          return (
            <NetworkRow
              key={cidr}
              control={<button
                type="button"
                aria-label={`Remove ${cidr}`}
                className={clsx('h-6 w-15 shrink-0 rounded px-1 text-left text-sm', SUBTLE_ACTION_COLOR_CLASS, SUBTLE_ACTION_INTERACTION_CLASS)}
                onClick={() => void remove(cidr)}
              >
                Remove
              </button>}
              name={owner ? `Part of ${owner.label} · ${owner.id}` : 'Added range · not connected now'}
              prefixes={[cidr]}
            />
          );
        })}
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

/** The accessible name of the line saying the path ended a phone's session. */
export const PATH_REFUSAL_LABEL = 'Last refused phone';

/** The last session the path ended, above the allowed networks it names, until dismissed. */
function PathRefusalNotice({ refusal }: { refusal: PathRefusal }) {
  const { busy, error, run } = useBusyAction();
  return (
    <div role="status" aria-label={PATH_REFUSAL_LABEL} className="mt-2 text-sm leading-relaxed text-foreground">
      {pathRefusalSentence(refusal, 'network-panel')}{' '}
      <button type="button" disabled={busy} className={INLINE_ACTION_CLASS} onClick={() => void run(dismissPathRefusal)}>
        Dismiss
      </button>
      {error ? <div className={ERROR}>{error}</div> : null}
    </div>
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
 * shortcut to itself, and Disconnect for an enrollment held meanwhile.
 */
export function NetworkPhones() {
  const view = useNetworkView();
  const { error, save } = useSave();
  if (view.kind !== 'ready') return null;
  const { network, status } = view;
  const choices = choicesFor(network, status).filter((choice) => choice.level !== 'nothing');
  return (
    <section className={SETTINGS_SECTION} aria-labelledby="network-phones-label">
      <div id="network-phones-label" className={LABEL}>Phones</div>
      {network.policy.level === 'nothing' ? (
        <>
          <div className={HINT}>
            Choose{' '}
            {choices.map((choice, position) => (
              <span key={choice.level}>
                {position > 0 ? (position === choices.length - 1 ? ' or ' : ', ') : null}
                <button
                  type="button"
                  className={INLINE_ACTION_CLASS}
                  onClick={() => void save(chooseLevel(choice.level))}
                >
                  {choice.title}
                </button>
              </span>
            ))}
            {' '}to connect a phone.
          </div>
          {status.enrolled ? <HeldEnrollment relayOrigin={status.relayOrigin} /> : null}
        </>
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

  if (!updatesItself(view.status)) {
    return (
      <section className={SETTINGS_SECTION}>
        <div className={LABEL}>Updates</div>
        <div className={HINT}>
          {view.status.relayMode === 'self-host'
            ? 'This build never updates itself. Rebuild it from source to update.'
            : 'VS Code installs Dormouse updates from the Marketplace, following its own extension update setting.'}
        </div>
      </section>
    );
  }
  const off = policy.level === 'nothing';
  const auto = checksForUpdates(policy);
  return (
    <section className={SETTINGS_SECTION}>
      {off ? (
        <div className={LABEL}>Updates</div>
      ) : (
        <SwitchRow
          label="Check for updates automatically"
          on={policy.autoUpdate}
          onChange={(autoUpdate) => void save(({ policy: latest }) => ({ ...latest, autoUpdate }))}
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
              className={INLINE_ACTION_CLASS}
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

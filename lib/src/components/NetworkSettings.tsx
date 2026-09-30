import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { clsx } from 'clsx';
import { SwitchRow } from './AlarmSettingsControls';
import { OnOffSwitch, SUBTLE_ACTION_COLOR_CLASS, SUBTLE_ACTION_INTERACTION_CLASS, TextInput, UNDER_SWITCH_INDENT, modalActionButton } from './design';

/**
 * PROTOTYPE — the Network topic of Settings, for settling the UI before the
 * architecture (`docs/specs/remote-network.md`). Presentational only: every
 * value arrives as a prop and every change leaves as a callback, so the story
 * can drive each state without a Burrow service.
 *
 * The contract it proposes: one choice decides every connection Dormouse opens
 * on its own, and {@link connectionsFor} lists exactly those connections. That
 * list is the promise; each row must be backed by code before this ships.
 *
 * A new install starts at `nothing`. With automatic update checks off — always,
 * under `nothing` — the Baseboard reminds the user once a check is
 * {@link UPDATE_REMINDER_DAYS} old, and at most once per that interval; the
 * reminder itself contacts nothing.
 */

export const UPDATE_REMINDER_DAYS = 7;

export type NetworkLevel = 'nothing' | 'local' | 'anywhere';

export type NetworkBuild = { kind: 'hosted' } | { kind: 'self-host'; relayOrigin: string };

export interface NetworkInterfaceInfo {
  /** The OS name, e.g. `en0`, `utun4`. */
  id: string;
  /** What a person calls it, e.g. `Wi-Fi`, `Tailscale`. */
  label: string;
  /** `virtual` covers bridge, container, and VM interfaces: never allowed by default. */
  kind: 'wifi' | 'ethernet' | 'vpn' | 'virtual';
  /** Canonical CIDRs from the interface's own netmask, both families. */
  prefixes: string[];
}

export interface PairedPhone {
  id: string;
  label: string;
  detail: string;
}

export interface NetworkSettingsState {
  build: NetworkBuild;
  host: 'standalone' | 'vscode';
  level: NetworkLevel;
  /** CIDRs a phone's direct path must fall within, under `local`. */
  allowed: string[];
  interfaces: NetworkInterfaceInfo[];
  autoUpdate: boolean;
  /** Epoch ms of the last successful check, or null since this version was installed. */
  lastUpdateCheck: number | null;
  phones: PairedPhone[];
  /** Mirrors of Notifications settings, for the connection list only. */
  pushEnabled: boolean;
  managedVoice: boolean;
}

export interface NetworkSettingsActions {
  onLevel: (level: NetworkLevel) => void;
  onAllowed: (allowed: string[]) => void;
  onAutoUpdate: (on: boolean) => void;
  onCheckForUpdates: () => void;
  onPair: () => void;
  onOneTime: () => void;
  onRemovePhone: (id: string) => void;
}

const HOSTED = 'hosted.dormouse.sh';
const STUN = 'stun.cloudflare.com';
const UPDATES = 'dormouse.sh';

interface LevelChoice {
  level: NetworkLevel;
  title: string;
  detail: string;
}

function choicesFor(build: NetworkBuild): LevelChoice[] {
  const nothing: LevelChoice = {
    level: 'nothing',
    title: 'Nothing',
    detail: 'Dormouse opens no connections on its own. Phones can’t reach this computer.',
  };
  if (build.kind === 'self-host') {
    return [nothing, {
      level: 'anywhere',
      title: 'My Relay only',
      detail: `Phones reach this computer through ${build.relayOrigin}. Nothing else is contacted.`,
    }];
  }
  return [
    nothing,
    {
      level: 'local',
      title: 'Local networks',
      detail: `Phones connect only over networks you choose. ${HOSTED} introduces them but never carries your terminals.`,
    },
    {
      level: 'anywhere',
      title: 'Anywhere',
      detail: `Phones connect from any network: directly when possible, otherwise through ${HOSTED}.`,
    },
  ];
}

export interface ConnectionRow {
  to: string;
  when: string;
  carries: string;
}

/**
 * Every connection this computer opens on its own under `state`, and nothing
 * else. Terminals and browser panes reach whatever the user points them at;
 * those are the user's connections, not Dormouse's.
 */
export function connectionsFor(state: NetworkSettingsState): ConnectionRow[] {
  if (state.level === 'nothing') return [];
  const rows: ConnectionRow[] = [];
  const paired = state.phones.length > 0;
  const coordinator = state.build.kind === 'self-host' ? state.build.relayOrigin : HOSTED;

  if (state.build.kind === 'self-host') {
    rows.push({
      to: coordinator,
      when: 'Always',
      carries: 'Encrypted handshakes, and terminal traffic when a phone can’t connect directly.',
    });
  } else {
    rows.push({
      to: coordinator,
      when: paired ? 'Always, so paired phones can find this computer' : 'Only while a one-time link is open',
      carries: state.level === 'local'
        ? 'Encrypted handshakes. Never terminal traffic.'
        : 'Encrypted handshakes, and terminal traffic when a phone can’t connect directly.',
    });
    if (state.level === 'anywhere') {
      rows.push({
        to: STUN,
        when: 'When a phone connects',
        carries: 'A lookup that shows Cloudflare this computer’s public IP address.',
      });
    }
  }

  rows.push({
    to: state.level === 'local' ? 'Your phone, on an allowed network' : 'Your phone, directly',
    when: 'While connected',
    carries: 'Terminal traffic, end-to-end encrypted.',
  });

  if (paired && state.pushEnabled) {
    rows.push({
      to: `${coordinator} → your phone’s push service`,
      when: 'When an alert goes unattended',
      carries: 'An end-to-end encrypted notification.',
    });
  }
  if (state.managedVoice && state.build.kind === 'hosted' && state.host === 'standalone') {
    rows.push({
      to: HOSTED,
      when: 'When an alert is spoken in the managed voice',
      carries: 'The pane’s name, which Hosted passes to ElevenLabs.',
    });
  }
  if (state.autoUpdate && state.host === 'standalone' && state.build.kind === 'hosted') {
    rows.push({
      to: UPDATES,
      when: 'Each launch',
      carries: 'A request for the newest version number. Downloading one waits for you.',
    });
  }
  return rows;
}

const SECTION = 'mt-4 border-t border-border pt-3';
const LABEL = 'text-sm text-foreground';
const HINT = 'mt-1 text-sm leading-relaxed text-muted';

export function NetworkSettings({ state, actions }: { state: NetworkSettingsState; actions: NetworkSettingsActions }) {
  const choices = choicesFor(state.build);
  return (
    <div className="mt-4">
      <LevelPicker choices={choices} level={state.level} onLevel={actions.onLevel} />
      <ConnectionList rows={connectionsFor(state)} />
      {state.level === 'local' ? (
        <AllowedNetworks interfaces={state.interfaces} allowed={state.allowed} onAllowed={actions.onAllowed} />
      ) : null}
      <Phones state={state} actions={actions} />
      <Updates state={state} actions={actions} />
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

/** A loose CIDR shape check; the Burrow canonicalizes and is the real gate. */
function looksLikeCidr(text: string): boolean {
  return /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/.test(text) || /^[0-9a-f:]+\/\d{1,3}$/i.test(text);
}

function AllowedNetworks({ interfaces, allowed, onAllowed }: {
  interfaces: NetworkInterfaceInfo[];
  allowed: string[];
  onAllowed: (allowed: string[]) => void;
}) {
  const [draft, setDraft] = useState('');
  const known = new Set(interfaces.flatMap((item) => item.prefixes));
  const typed = allowed.filter((cidr) => !known.has(cidr));
  const add = (cidrs: string[]) => onAllowed([...allowed, ...cidrs.filter((cidr) => !allowed.includes(cidr))]);
  const remove = (cidrs: string[]) => onAllowed(allowed.filter((cidr) => !cidrs.includes(cidr)));
  const draftValid = looksLikeCidr(draft.trim());

  return (
    <section className={SECTION} aria-labelledby="network-allowed-label">
      <div id="network-allowed-label" className={LABEL}>Allowed networks</div>
      <div className={HINT}>A phone connects only when both ends of its connection are on one of these.</div>
      <div className="mt-2 flex flex-col gap-1.5">
        {interfaces.map((item) => {
          const on = item.prefixes.every((cidr) => allowed.includes(cidr));
          return (
            <NetworkRow
              key={item.id}
              control={<OnOffSwitch
                on={on}
                label={`Allow ${item.label}`}
                onEnable={() => add(item.prefixes)}
                onDisable={() => remove(item.prefixes)}
              />}
              name={`${item.label} · ${item.id}`}
              prefixes={item.prefixes}
            />
          );
        })}
        {typed.map((cidr) => (
          <NetworkRow
            key={cidr}
            control={<button
              type="button"
              className={clsx('h-6 w-15 shrink-0 rounded px-1 text-left text-sm', SUBTLE_ACTION_COLOR_CLASS, SUBTLE_ACTION_INTERACTION_CLASS)}
              onClick={() => remove([cidr])}
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
          if (!draftValid) return;
          add([draft.trim()]);
          setDraft('');
        }}
      >
        <TextInput
          value={draft}
          onChange={setDraft}
          placeholder="Add a range, e.g. 10.8.0.0/24"
          aria-label="Add an allowed network range"
          className="text-sm"
        />
        <button type="submit" disabled={!draftValid} className={modalActionButton()}>Add</button>
      </form>
      {allowed.length === 0 ? (
        <div className={`${UNDER_SWITCH_INDENT} mt-2 text-sm leading-relaxed text-error`}>
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

function Phones({ state, actions }: { state: NetworkSettingsState; actions: NetworkSettingsActions }) {
  const off = state.level === 'nothing';
  const blocked = state.level === 'local' && state.allowed.length === 0;
  return (
    <section className={SECTION} aria-labelledby="network-phones-label">
      <div id="network-phones-label" className={LABEL}>Phones</div>
      {state.phones.length ? (
        <ul className="mt-1.5 flex flex-col gap-1">
          {state.phones.map((phone) => (
            <li key={phone.id} className="flex items-baseline gap-3 text-sm">
              <span className="text-foreground">{phone.label}</span>
              <span className="min-w-0 flex-1 text-muted">{off ? 'Can’t connect while set to Nothing' : phone.detail}</span>
              <button
                type="button"
                className={clsx('rounded px-1', SUBTLE_ACTION_COLOR_CLASS, SUBTLE_ACTION_INTERACTION_CLASS)}
                onClick={() => actions.onRemovePhone(phone.id)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {off ? (
        <div className={HINT}>
          Choose{' '}
          {choicesFor(state.build).filter((choice) => choice.level !== 'nothing').map((choice, position, rest) => (
            <span key={choice.level}>
              {position > 0 ? (position === rest.length - 1 ? ' or ' : ', ') : null}
              <button
                type="button"
                className={clsx('rounded px-0.5', SUBTLE_ACTION_COLOR_CLASS, SUBTLE_ACTION_INTERACTION_CLASS)}
                onClick={() => actions.onLevel(choice.level)}
              >
                {choice.title}
              </button>
            </span>
          ))}
          {' '}to connect a phone.
        </div>
      ) : (
        <>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" disabled={blocked} className={modalActionButton({ tone: 'primary' })} onClick={actions.onPair}>
              Pair a phone
            </button>
            {state.build.kind === 'hosted' ? (
              <button type="button" disabled={blocked} className={modalActionButton()} onClick={actions.onOneTime}>
                One-time link
              </button>
            ) : null}
          </div>
          <div className={HINT}>
            {state.build.kind === 'hosted'
              ? 'A paired phone reconnects any time. A one-time link connects once, with no account, and saves nothing.'
              : 'A paired phone reconnects any time.'}
          </div>
        </>
      )}
    </section>
  );
}

function Updates({ state, actions }: { state: NetworkSettingsState; actions: NetworkSettingsActions }) {
  if (state.host === 'vscode') {
    return (
      <section className={SECTION}>
        <div className={LABEL}>Updates</div>
        <div className={HINT}>VS Code installs Dormouse updates from the Marketplace, following its own extension update setting.</div>
      </section>
    );
  }
  if (state.build.kind === 'self-host') {
    return (
      <section className={SECTION}>
        <div className={LABEL}>Updates</div>
        <div className={HINT}>This build never updates itself. Rebuild it from source to update.</div>
      </section>
    );
  }
  const off = state.level === 'nothing';
  const auto = !off && state.autoUpdate;
  const last = state.lastUpdateCheck === null
    ? 'Not checked since this version was installed.'
    : `Last checked ${daysAgo(state.lastUpdateCheck)}.`;
  return (
    <section className={SECTION}>
      {off ? (
        <div className={LABEL}>Updates</div>
      ) : (
        <SwitchRow label="Check for updates automatically" on={state.autoUpdate} onChange={actions.onAutoUpdate} />
      )}
      <div className={off ? HINT : `${UNDER_SWITCH_INDENT} ${HINT}`}>
        {auto ? 'Checked at each launch. ' : off ? 'Checked only when you ask. ' : ''}
        {last}{' '}
        <button
          type="button"
          className={clsx('rounded px-0.5', SUBTLE_ACTION_COLOR_CLASS, SUBTLE_ACTION_INTERACTION_CLASS)}
          onClick={actions.onCheckForUpdates}
        >
          Check now
        </button>
        {auto ? null : (
          <div>After a week without a check, the bottom bar reminds you. The reminder contacts nothing.</div>
        )}
      </div>
    </section>
  );
}

function daysAgo(at: number): string {
  const days = Math.floor((Date.now() - at) / 86_400_000);
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
}

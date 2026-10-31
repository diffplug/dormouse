import { useCallback, useEffect, useRef, useState } from 'react';
import { modalActionButton } from './design';
import { FIELD_LABEL, own } from './remote-control-shared';
import type { PairedDevice } from '../host/remote/service-protocol';
import type { AccessEvent, AccessLogEntry } from '../remote/burrow/access-log';
import {
  describeBurrowError,
  loadAccessLog,
  loadPairedDevices,
  subscribeToAccess,
} from '../remote/burrow/burrow-status-store';

/**
 * The paired phones and the access log, re-read on mount, whenever the
 * enrollment changes underneath, and on every `access` event — which carries
 * nothing, so there is no patching it in. `null` until the first read lands.
 * A failed read keeps what was shown and reports `error` until one succeeds.
 */
export function useAccessRecords(burrowId: string | null) {
  const [devices, setDevices] = useState<PairedDevice[] | null>(null);
  const [log, setLog] = useState<AccessLogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The newest read wins: an event can land while a revoke's re-read is still out. */
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const [nextDevices, nextLog] = await Promise.all([loadPairedDevices(), loadAccessLog()]);
      if (mine !== seq.current) return;
      setDevices(nextDevices);
      setLog(nextLog);
      setError(null);
    } catch (caught) {
      if (mine !== seq.current) return;
      setError(describeBurrowError(caught));
    }
  }, []);

  useEffect(() => {
    void reload();
    const unsubscribe = subscribeToAccess(() => void reload());
    return () => {
      unsubscribe();
      seq.current++;
    };
  }, [reload, burrowId]);

  return { devices, log, error, reload };
}

/**
 * Each paired phone, with a Revoke that asks once inline before acting — it
 * cuts the phone off at once, ending a session it holds, until it pairs again.
 * The view's busy/error pair runs it, so a refusal lands in the view's error
 * slot and the confirmation stays open over it.
 */
export function PairedDeviceList({
  devices,
  busy,
  onRevoke,
}: {
  devices: PairedDevice[];
  busy: boolean;
  onRevoke: (id: string) => Promise<boolean>;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  if (devices.length === 0) {
    return <div className="mt-0.5 text-muted">No phone has paired with this machine yet.</div>;
  }
  const now = Date.now();
  return (
    <div className="mt-1.5">
      <div className={FIELD_LABEL}>Paired phones</div>
      <ul>
        {devices.map((device) => (
          <li key={device.id} className="mt-1">
            <div className="flex items-baseline justify-between gap-2">
              <div className="min-w-0">
                <span className="text-foreground">{device.label}</span>{' '}
                <span className="font-mono text-xs text-muted">{device.id}</span>
              </div>
              {confirming === device.id ? null : (
                <button
                  type="button"
                  disabled={busy}
                  className={`shrink-0 ${modalActionButton()}`}
                  onClick={() => setConfirming(device.id)}
                >
                  Revoke
                </button>
              )}
            </div>
            <div className="text-xs text-muted">
              Paired {dayOf(device.pairedAt, now)} · {seenText(device, now)}
            </div>
            {confirming === device.id ? (
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted">
                  {device.connected
                    ? 'Its session ends now, and it will need to pair again.'
                    : 'It will need to pair again.'}
                </span>
                <button
                  type="button"
                  disabled={busy}
                  className={modalActionButton({ tone: 'primary' })}
                  onClick={() =>
                    void onRevoke(device.id).then((revoked) => {
                      if (revoked) setConfirming(null);
                    })
                  }
                >
                  Revoke
                </button>
                <button
                  type="button"
                  disabled={busy}
                  className={modalActionButton()}
                  onClick={() => setConfirming(null)}
                >
                  Cancel
                </button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Entries the log shows before Show all: a lost phone is found in the last few days, not the last 500 events. */
const ACCESS_LOG_SHOWN = 50;

/**
 * The access log, newest first, folded until clicked. One line an entry: when,
 * which device, and what happened in fixed copy ({@link ACCESS_EVENT_COPY}).
 * The device is the label the Burrow mapped to a closed set; nothing else the
 * phone chose is on the line.
 */
export function AccessLogDisclosure({ entries }: { entries: AccessLogEntry[] }) {
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const newestFirst = [...entries].reverse();
  const shown = all ? newestFirst : newestFirst.slice(0, ACCESS_LOG_SHOWN);
  const now = Date.now();
  return (
    <div className="mt-3">
      <button
        type="button"
        aria-expanded={open}
        className={modalActionButton()}
        onClick={() => setOpen((was) => !was)}
      >
        {open ? '− ' : '+ '}Access log
      </button>
      {open ? (
        entries.length === 0 ? (
          <div className="mt-1 text-xs text-muted">Nothing is in the access log yet.</div>
        ) : (
          <>
            <ul className="mt-1 text-xs" aria-label="Access log">
              {shown.map((entry, index) => (
                <li key={`${entry.at}-${index}`} className="flex gap-2">
                  <span className="shrink-0 tabular-nums text-muted">{timeOf(entry.at, now)}</span>
                  <span className="min-w-0">
                    <span className="text-foreground">{entry.device}</span>
                    {entry.deviceId ? <span className="font-mono text-muted"> {entry.deviceId}</span> : null}{' '}
                    <span className="text-muted">{describeAccess(entry)}</span>
                  </span>
                </li>
              ))}
            </ul>
            {shown.length < newestFirst.length ? (
              <button type="button" className={`mt-1 ${modalActionButton()}`} onClick={() => setAll(true)}>
                Show all {newestFirst.length}
              </button>
            ) : null}
          </>
        )
      ) : null}
    </div>
  );
}

/**
 * What each event reads as. Exhaustive over {@link AccessEvent}, so a new event
 * cannot render as nothing; the store already dropped any this build does not
 * know, and {@link own} stops a prototype name all the same.
 */
const ACCESS_EVENT_COPY: Record<AccessEvent, (entry: AccessLogEntry) => string> = {
  paired: () => 'paired',
  'pairing-denied': (entry) => `pairing refused${because(entry.reason)}`,
  connected: (entry) =>
    entry.presence === 'window'
      ? 'connected (presence window)'
      : entry.presence === 'proof'
        ? 'connected (passkey)'
        : 'connected',
  'connection-denied': (entry) => `connection refused${because(entry.reason)}`,
  attached: (entry) => (entry.surface ? `attached ${entry.surface}` : 'attached a terminal'),
  ended: (entry) => `session ended${after(entry.durationMs)}${entry.path ? `, ${entry.path}` : ''}`,
  revoked: (entry) =>
    entry.by === 'dor' ? 'revoked from dor' : entry.by === 'settings' ? 'revoked from Settings' : 'revoked',
  'one-time-connected': () => 'connected by one-time link',
  'one-time-denied': (entry) => `one-time link refused${because(entry.reason)}`,
  'one-time-ended': (entry) =>
    `one-time session ended${after(entry.durationMs)}${entry.reason ? ` (${entry.reason})` : ''}`,
};

function describeAccess(entry: AccessLogEntry): string {
  return own(ACCESS_EVENT_COPY, entry.event)?.(entry) ?? entry.event;
}

function because(reason: string | undefined): string {
  return reason ? `: ${reason}` : '';
}

function after(durationMs: number | undefined): string {
  if (durationMs === undefined) return '';
  const minutes = Math.round(durationMs / 60_000);
  if (minutes < 1) return ' after under a minute';
  if (minutes < 60) return ` after ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return ` after ${hours} h${rest ? ` ${rest} min` : ''}`;
}

function seenText(device: PairedDevice, now: number): string {
  if (device.connected) return 'Connected now';
  // `null` is a log with nothing about this phone — one paired before the log
  // existed, or since trimmed out of it — not proof it never connected.
  if (device.lastSeenAt === null) return 'Not in the access log';
  const ago = now - device.lastSeenAt;
  if (ago < 60_000) return 'Last seen just now';
  if (ago < 60 * 60_000) return `Last seen ${Math.floor(ago / 60_000)} min ago`;
  if (ago < 24 * 60 * 60_000) return `Last seen ${Math.floor(ago / (60 * 60_000))} h ago`;
  return `Last seen ${dayOf(device.lastSeenAt, now)}`;
}

/** `today`, or a short date — with its year only when it is not this one. */
function dayOf(at: number, now: number): string {
  const date = new Date(at);
  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) return 'today';
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
  });
}

/** The time alone for today's entries, else its date before it. */
function timeOf(at: number, now: number): string {
  const time = new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const day = dayOf(at, now);
  return day === 'today' ? time : `${day} ${time}`;
}

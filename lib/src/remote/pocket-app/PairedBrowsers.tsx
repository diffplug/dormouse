/**
 * The connected Burrow's paired browsers, and revoking one
 * (`docs/specs/pocket-app.md` -> "Paired browsers"): one record per browser on
 * this one Burrow, with nothing merged across Burrows.
 *
 * Listing never prompts, so it runs on mount. A revoke prompts, so it starts on
 * a tap, and its confirmation is inline, as the Burrows view's is: this is touch
 * UI, so nothing here waits on a hover.
 */

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { PairedBrowserV1 } from 'remote-lib-common';
import { dayOf, lastSeenText } from '../../components/device-seen-copy';
import {
  PasskeyUnavailableError,
  SessionExpiredError,
  type DeviceListing,
  type DeviceRevocation,
} from '../client/pocket-client';
import { ErrorRow, PK, pkButton } from './pocket-chrome';

/** The slice of the client this needs, which a story can answer. */
export interface PairedBrowsersSession {
  listDevices(): Promise<DeviceListing>;
  revokeDevice(id: string): Promise<DeviceRevocation>;
}

/** What a passkey prompt the person dismissed reads as; no browser text reaches the screen. */
export const PASSKEY_NOT_CONFIRMED = 'Your passkey wasn’t confirmed, so nothing changed. Try again.';

export const PAIRED_BROWSERS_TITLE = 'Paired browsers';
export const RETRY_PAIRED_BROWSERS = 'Try again';
export const THIS_BROWSER = 'This browser';
export const REVOKE_LABEL = 'Revoke';
export const CONFIRM_REVOKE_LABEL = 'Confirm with passkey';

type View =
  | { readonly at: 'idle' }
  | { readonly at: 'unsupported'; readonly message: string }
  | { readonly at: 'listed'; readonly devices: readonly PairedBrowserV1[] };

export function PairedBrowsers({
  session,
  onSelfRevoked,
  onAccountLost,
}: {
  session: PairedBrowsersSession;
  /** This browser's own pairing went: the session is over. */
  onSelfRevoked: () => void;
  /** The Relay session or the cached passkey is gone, which only sign-in mends. */
  onAccountLost: (error: Error) => void;
}): React.ReactElement {
  const titleId = useId();
  const [view, setView] = useState<View>({ at: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [confirming, setConfirming] = useState<string | null>(null);

  const attempt = useCallback(
    async (fn: () => Promise<void>) => {
      setError(null);
      setBusy(true);
      try {
        await fn();
      } catch (err) {
        if (err instanceof SessionExpiredError || err instanceof PasskeyUnavailableError) onAccountLost(err);
        else setError(failureMessage(err));
      } finally {
        setBusy(false);
      }
    },
    [onAccountLost],
  );

  const load = useCallback(async () => {
    const listing = await session.listDevices();
    if (listing.ok) setView({ at: 'listed', devices: listing.devices });
    else if (listing.unsupported) setView({ at: 'unsupported', message: listing.message });
    else setError(listing.message);
  }, [session]);

  // Once, for the mount, StrictMode's second run included.
  const loaded = useRef(false);
  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    void attempt(load);
  }, [attempt, load]);

  const revoke = (id: string) =>
    attempt(async () => {
      const result = await session.revokeDevice(id);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setConfirming(null);
      if (result.self) onSelfRevoked();
      else await load();
    });

  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-2 font-sans">
      <h3 id={titleId} className={PK.noticeTitle}>
        {PAIRED_BROWSERS_TITLE}
      </h3>
      {error ? <ErrorRow message={error} /> : null}
      {view.at === 'unsupported' ? <p className={PK.lead}>{view.message}</p> : null}
      {view.at === 'idle' && busy ? <p className={PK.lead}>…</p> : null}
      {view.at === 'idle' && !busy ? (
        <button type="button" className={pkButton({ tone: 'outline', block: true })} onClick={() => void attempt(load)}>
          {RETRY_PAIRED_BROWSERS}
        </button>
      ) : null}
      {view.at === 'listed'
        ? view.devices.map((device) => (
            <PairedBrowserRow
              key={device.id}
              device={device}
              busy={busy}
              confirming={confirming === device.id}
              onAsk={() => setConfirming(device.id)}
              onCancel={() => setConfirming(null)}
              onRevoke={() => void revoke(device.id)}
            />
          ))
        : null}
    </section>
  );
}

function PairedBrowserRow({
  device,
  busy,
  confirming,
  onAsk,
  onCancel,
  onRevoke,
}: {
  device: PairedBrowserV1;
  busy: boolean;
  confirming: boolean;
  onAsk: () => void;
  onCancel: () => void;
  onRevoke: () => void;
}): React.ReactElement {
  const now = Date.now();
  return (
    <div className={PK.notice}>
      <div className="flex items-center gap-3">
        <div className={PK.rowMain}>
          <div className={PK.rowTitle}>{device.label}</div>
          <div className={PK.rowSecondary}>
            {device.self ? `${THIS_BROWSER} · ` : ''}
            <span className="font-mono">{device.id}</span>
          </div>
          <div className={PK.rowDetail}>
            Paired {dayOf(device.approvedAt, now)} · {lastSeenText(device.lastSeenAt, now)}
          </div>
        </div>
        {confirming ? null : (
          <button
            type="button"
            className={pkButton({ tone: 'outline', size: 'sm' })}
            disabled={busy}
            aria-label={`${REVOKE_LABEL} ${device.label} ${device.id}`}
            onClick={onAsk}
          >
            {REVOKE_LABEL}
          </button>
        )}
      </div>
      {confirming ? (
        <>
          <p className={PK.noticeBody}>{revokeConsequence(device)}</p>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className={pkButton({ tone: 'outline', size: 'sm' })}
              disabled={busy}
              onClick={onCancel}
            >
              Cancel
            </button>
            <button type="button" className={pkButton({ size: 'sm' })} disabled={busy} onClick={onRevoke}>
              {busy ? '…' : CONFIRM_REVOKE_LABEL}
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}

/** What the confirmation says the tap does. */
export function revokeConsequence(device: Pick<PairedBrowserV1, 'self'>): string {
  return device.self
    ? 'This browser is cut off from this computer at once, and this session ends. Pairing again takes a new code on the computer.'
    : 'That browser is cut off from this computer at once. Pairing again takes a new code on the computer.';
}

/** The same panel with a screen of its own, for a session with no wall behind it. */
export function PairedBrowsersScreen({
  title,
  leading,
  ...panel
}: {
  title: string;
  leading: ReactNode;
  session: PairedBrowsersSession;
  onSelfRevoked: () => void;
  onAccountLost: (error: Error) => void;
}): React.ReactElement {
  return (
    <div className={PK.app}>
      <header className={PK.header}>
        {leading}
        <h1 className={PK.headerTitle}>{title}</h1>
      </header>
      <div className={PK.body}>
        <PairedBrowsers {...panel} />
      </div>
    </div>
  );
}

function failureMessage(err: unknown): string {
  if ((err as { name?: unknown } | null)?.name === 'NotAllowedError') return PASSKEY_NOT_CONFIRMED;
  return err instanceof Error ? err.message : String(err);
}

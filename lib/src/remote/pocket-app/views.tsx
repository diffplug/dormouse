/**
 * The phone screens and copy that do not depend on how a session was
 * authorized — the capability gate, the two-digit waiting screen, the
 * transport indicator — plus the label Pocket suggests at pairing (the
 * one-time page names itself: `oneTimeDeviceLabel`). Shared so every phone
 * page says these things one way (`docs/specs/pocket-app.md`).
 */

import { clsx } from 'clsx';
import type { DirectPath, DirectRelayCause } from 'remote-lib-common';
import { isInstalledWebApp } from '../client/install-state';
import { PK, pkButton } from './pocket-chrome';

/**
 * The label this Client suggests at pairing.
 *
 * One phone can hold two Client identities — a Safari tab and a Home Screen
 * install have separate storage and therefore separate per-Burrow statics — and
 * they are genuinely separate delivery targets that cannot be merged. Naming
 * the mode is what lets the person approving on the laptop, and the alarm
 * dialog afterwards, tell them apart.
 */
export function deviceLabel(): string {
  return isInstalledWebApp() ? 'Dormouse Pocket (Home Screen)' : 'Dormouse Pocket (browser)';
}

/** The whole shell with nothing in it yet; the capability probe's screen too. */
export function Waiting(): React.ReactElement {
  return (
    <div className={PK.app}>
      <div className={clsx(PK.body, PK.bodyCenter)}>…</div>
    </div>
  );
}

// --- The capability gate ----------------------------------------------------

/** What a browser that cannot run the protocol is told, and the whole of it. */
export const UNSUPPORTED_BROWSER_TITLE = 'This browser cannot run Dormouse Pocket';
export const UNSUPPORTED_BROWSER_BODY =
  'Dormouse Pocket needs X25519 in the Web Crypto API, which this browser does not have. ' +
  'Update it, or open Dormouse Pocket in a newer browser.';

/**
 * The whole of what a runtime without X25519 gets. **No action, and no remote
 * operation behind it**: every ceremony this app has needs the primitive this
 * browser lacks, so an offer here would be one that cannot work
 * (`docs/specs/remote-security-model.md` → Burrow identity). The copy defaults
 * to Pocket's; another phone page names itself and what it needs.
 */
export function UnsupportedBrowser({
  heading = 'Dormouse Pocket',
  title = UNSUPPORTED_BROWSER_TITLE,
  body = UNSUPPORTED_BROWSER_BODY,
}: {
  heading?: string;
  title?: string;
  body?: string;
}): React.ReactElement {
  return (
    <div className={PK.app}>
      <header className={PK.header}>
        <h1 className={PK.headerTitle}>{heading}</h1>
      </header>
      <div className={clsx(PK.body, PK.bodyCenter)}>
        <p className={PK.title}>{title}</p>
        <p className={PK.lead}>{body}</p>
      </div>
    </div>
  );
}

// --- The two-digit waiting screen -------------------------------------------

/** The accessible name of the digits; see {@link PairingCodeView}. */
export const PAIRING_CODE_LABEL = 'Pairing code';

/**
 * The digits the person has to type on the computer, and nothing else.
 *
 * **The code is on screen before the outcome is known, and stays until it
 * lands.** The laptop's modal tells the user to cancel if the phone shows no
 * code, so a screen that waited for anything before painting the digits would
 * teach exactly the reflex the ceremony is built to punish
 * (`docs/specs/remote-security-model.md` → Pairing).
 */
export function PairingCodeView({
  code,
  onCancel,
  heading = 'Pairing',
  instruction = 'Type these digits on the computer to approve.',
}: {
  /** Null for the moment between the handshake and the sampled code. */
  code: string | null;
  onCancel: () => void;
  /** The header, and what to do with the digits; Pocket's pairing copy by default. */
  heading?: string;
  instruction?: string;
}): React.ReactElement {
  return (
    <div className={PK.app}>
      <header className={PK.header}>
        <h1 className={PK.headerTitle}>{heading}</h1>
      </header>
      <div className={clsx(PK.body, PK.bodyCenter)}>
        {/* Named and announced structurally, so what identifies this screen — to
            a screen reader, to the tests, and to the walkthrough harness — is
            not a sentence the next copy pass is free to rewrite. */}
        <p className={PK.code} role="status" aria-label={PAIRING_CODE_LABEL} aria-live="polite">
          {code ?? '··'}
        </p>
        <p className={clsx(PK.lead, 'text-center')}>{instruction}</p>
        <button
          type="button"
          className={pkButton({ tone: 'outline', block: true })}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// --- The transport indicator ------------------------------------------------

/**
 * What the path indicator says, and the sentence behind each. **Which path
 * carries the session is shown, never inferred**, so a relayed fallback is
 * visible rather than silent (`docs/specs/pocket-app.md`).
 */
export const TRANSPORT_PATH_LABELS: Record<DirectPath, { label: string; title: string }> = {
  relay: { label: 'relay', title: 'This session goes through the relay.' },
  direct: { label: 'direct', title: 'This session goes straight to the computer.' },
};

/**
 * What each reason for staying relayed says to the person holding the phone.
 *
 * **The copy lives here, with the phone's other strings**, and the transport
 * hands up only which of the three it was ({@link DirectRelayCause}): the text
 * an attempt fails with includes a runtime's own exception message, which
 * belongs in the operator's log and not on a phone.
 */
export const TRANSPORT_RELAY_CAUSES: Record<DirectRelayCause, string> = {
  unsupported: 'This device cannot make a direct connection.',
  declined: 'The computer turned a direct connection down.',
  failed: 'A direct connection was tried and did not work.',
};

/** Which path carries the session, and why it is not the direct one. */
export interface TransportView {
  readonly path: DirectPath;
  readonly cause: DirectRelayCause | null;
}

/**
 * Where every session starts and where each one ends: relayed, with no reason
 * to give. Shared so the initial state and the default prop are one value.
 */
export const RELAYED_TRANSPORT: TransportView = { path: 'relay', cause: null };

/**
 * The indicator's hover text: which path, and the reason behind it where there
 * is one. **The reason is shown, never the label** — an attempt that quietly
 * stayed relayed is still `relay`, and inventing a third state for it would
 * make the common case look like a fault.
 */
export function transportTitle({ path, cause }: TransportView): string {
  const { title } = TRANSPORT_PATH_LABELS[path];
  return cause ? `${title} ${TRANSPORT_RELAY_CAUSES[cause]}` : title;
}

import { useState } from 'react';
import { TextInput, modalActionButton } from './design';
import { ExternalTextLink } from './ExternalTextLink';
import { FIELD_HINT, FIELD_LABEL, hostOf, useBusyAction, useMinutesLeft } from './remote-control-shared';
import { ACCOUNT_PAGE_PATH, HOSTED_ACCOUNT_ORIGIN } from '../host/relay-origin';
import type { HostedEnrollmentEndReason, HostedEnrollmentState } from '../host/remote/service-protocol';
import { HOSTED_REFS, withHostedRef, type HostedRef } from '../lib/hosted-links';
import { getPlatform } from '../lib/platform';
import { BURROW_IS_AN_APP } from '../remote/setup-copy';
import { beginHostedEnrollment, cancelHostedEnrollment } from '../remote/burrow/burrow-status-store';

const HOSTED_PAGE_URL = 'https://dormouse.sh/hosted/';
/** The Hosted page's voice section, the spoken-alarm row's link where the build has no managed voice. */
export const HOSTED_VOICE_URL = withHostedRef(HOSTED_PAGE_URL, HOSTED_REFS.settingsVoice, 'voice');

/**
 * The Hosted page's plans, the one way every no-plan line names them; `from`
 * is the ref of the Settings section it sits in. (Not `ref`, which React
 * keeps for itself.)
 */
export function HostedPlansLink({ from }: { from: HostedRef }) {
  return <ExternalTextLink href={withHostedRef(HOSTED_PAGE_URL, from, 'pricing')}>See Hosted plans</ExternalTextLink>;
}

/** The one field the offer card and the typed form both ask for. */
export function BurrowNameField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  // The hint is a sibling of the label, not a child: inside it, it would join
  // the input's accessible name and leave the field called "Name for this
  // Burrow A Burrow is one Dormouse app …".
  return (
    <div className="mt-2">
      <label className="block">
        <span className={FIELD_LABEL}>Name for this Burrow</span>
        <TextInput
          value={value}
          onChange={onChange}
          autoComplete="off"
          placeholder="e.g. Work laptop"
        />
      </label>
      <p className={FIELD_HINT}>{BURROW_IS_AN_APP} Each pairs with your phone on its own.</p>
    </div>
  );
}

/** What a Hosted approval turns on: remote control, or Natural Voice. */
export type HostedApprovalPurpose = 'remote' | 'voice';

/**
 * The accessible name of the two digits a Hosted approval shows, which the
 * person types beside Approve on the account page.
 */
export const HOSTED_ENROLLMENT_CODE_LABEL = 'Digits to type at your account';

/** What an approval that ended short did not do. */
const NOT_DONE: Record<HostedApprovalPurpose, string> = {
  remote: 'this computer was not enrolled',
  voice: 'Natural Voice was not turned on',
};

/**
 * What an approval that ended short says, by purpose. **Fixed copy chosen by
 * code**, as `PAIRING_OUTCOME_COPY` is: `failed` alone adds the host's own
 * sentence.
 */
export const HOSTED_APPROVAL_ENDED_COPY = Object.fromEntries(
  (['remote', 'voice'] as const).map((purpose) => {
    const result = NOT_DONE[purpose];
    const copy: Record<HostedEnrollmentEndReason, string> = {
      expired: `That code expired before it was approved, so ${result}.`,
      'not-entitled': `The account that approved that code has no Hosted plan, so ${result}.`,
      mismatch: `The digits typed at your account were not the ones shown here, so ${result}.`,
      'answer-lost': `That code was approved and used, but the answer never reached this computer, so ${result}.`,
      failed: purpose === 'remote' ? 'This computer could not finish enrolling.' : 'Natural Voice could not finish turning on.',
    };
    return [purpose, copy];
  }),
) as Record<HostedApprovalPurpose, Record<HostedEnrollmentEndReason, string>>;

/** The copy a status's `redeeming` shows: approved, and the credential being saved. */
export const HOSTED_APPROVAL_REDEEMING_COPY: Record<HostedApprovalPurpose, string> = {
  remote: 'Approved. Enrolling this computer…',
  voice: 'Approved. Turning on Natural Voice…',
};

/** The account page the service names in `status.accountOrigin`, where computers are removed. */
export function accountPage(accountOrigin: string | null): string | null {
  return accountOrigin === null ? null : `${accountOrigin}${ACCOUNT_PAGE_PATH}`;
}

/** What a lost answer asks of the person: the Burrow it enrolled, named where the service knows it. */
export function answerLostRemoval(burrowId: string | undefined): string {
  return burrowId
    ? `Remove Burrow ${burrowId} from your account, then enroll again.`
    : 'Remove the computer it added from your account, then enroll again.';
}

/**
 * Why the last Hosted approval ended, with the account page where it says to
 * go there: only a lost remote-control answer left something to remove.
 */
export function HostedEnrollmentEnded({
  ended,
  accountOrigin,
  purpose = 'remote',
}: {
  ended: Extract<HostedEnrollmentState, { status: 'ended' }>;
  accountOrigin: string | null;
  purpose?: HostedApprovalPurpose;
}) {
  const lost = purpose === 'remote' && ended.reason === 'answer-lost';
  const page = lost ? accountPage(accountOrigin) : null;
  return (
    <div className="mt-1.5 text-sm leading-relaxed" role="status">
      <div className="text-foreground">{HOSTED_APPROVAL_ENDED_COPY[purpose][ended.reason]}</div>
      {lost ? <div className="mt-1 text-foreground">{answerLostRemoval(ended.burrowId)}</div> : null}
      {ended.reason === 'failed' && ended.message ? <div className="mt-1 text-error">{ended.message}</div> : null}
      {ended.reason === 'not-entitled' ? (
        <div className="mt-1">
          <HostedPlansLink from={purpose === 'voice' ? HOSTED_REFS.settingsVoice : HOSTED_REFS.settingsRemote} />
        </div>
      ) : null}
      {page ? (
        <div className="mt-1">
          <ExternalTextLink href={page}>Manage computers at {hostOf(page)}</ExternalTextLink>
        </div>
      ) : null}
    </div>
  );
}

/**
 * A Hosted approval under way, for either purpose: the code waiting, the
 * credential being saved, or why it ended. The host polls; this renders its
 * state, never one of its own.
 */
export function HostedApprovalProgress({
  enrollment,
  purpose,
  accountOrigin,
  busy,
  onCancel,
}: {
  enrollment: HostedEnrollmentState | null | undefined;
  purpose: HostedApprovalPurpose;
  accountOrigin: string | null;
  busy: boolean;
  onCancel: () => void;
}) {
  if (enrollment?.status === 'waiting') {
    return <HostedEnrollmentCode waiting={enrollment} accountOrigin={accountOrigin} busy={busy} onCancel={onCancel} />;
  }
  if (enrollment?.status === 'redeeming') {
    return (
      <div className="mt-1.5 text-sm leading-relaxed text-foreground" role="status">
        {HOSTED_APPROVAL_REDEEMING_COPY[purpose]}
      </div>
    );
  }
  if (enrollment?.status === 'ended') {
    return <HostedEnrollmentEnded ended={enrollment} accountOrigin={accountOrigin} purpose={purpose} />;
  }
  return null;
}

/**
 * Enrolling (`docs/specs/hosted.md` -> "Burrow enrollment"): a button that
 * begins it, under the name to keep for this machine where `askName`; then
 * {@link HostedApprovalProgress}; ended, a new code a click away.
 *
 * **The name field is hidden while a code waits, never unmounted**, so what
 * was typed survives a Cancel. Without `askName` the service's suggested name
 * is used: phones show it, and the person never typed one.
 */
export function HostedEnrollView({
  enrollment,
  accountOrigin,
  suggestedLabel,
  askName = true,
}: {
  enrollment: HostedEnrollmentState | null;
  accountOrigin: string | null;
  suggestedLabel: string;
  askName?: boolean;
}) {
  const [label, setLabel] = useState(suggestedLabel);
  const { busy, error, run } = useBusyAction();
  /** Which of the actions sharing {@link useBusyAction}'s gate is the begin, for its label. */
  const [beginning, setBeginning] = useState(false);
  const waiting = enrollment?.status === 'waiting' ? enrollment : null;
  const redeeming = enrollment?.status === 'redeeming';
  const ended = enrollment?.status === 'ended' ? enrollment : null;
  const name = askName ? label.trim() : suggestedLabel;
  const begin = () =>
    void run(async () => {
      setBeginning(true);
      try {
        // A code another window has waiting is answered; one that ended is replaced.
        await beginHostedEnrollment(name);
      } finally {
        setBeginning(false);
      }
    });

  return (
    <div>
      <HostedApprovalProgress
        enrollment={enrollment}
        purpose="remote"
        accountOrigin={accountOrigin}
        busy={busy}
        onCancel={() => void run(cancelHostedEnrollment)}
      />
      <form
        className="mt-1.5"
        hidden={waiting !== null || redeeming}
        onSubmit={(event) => {
          event.preventDefault();
          if (name !== '' && !busy) begin();
        }}
      >
        {askName ? <BurrowNameField value={label} onChange={setLabel} /> : null}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="submit"
            disabled={busy || name === ''}
            className={modalActionButton({ tone: 'primary' })}
          >
            {beginning ? 'Getting a code…' : ended ? 'Get a new code' : 'Enroll remote control'}
          </button>
          {ended ? (
            <button
              type="button"
              disabled={busy}
              className={modalActionButton()}
              onClick={() => void run(cancelHostedEnrollment)}
            >
              Done
            </button>
          ) : null}
        </div>
      </form>
      {error ? <div className="mt-2 text-sm leading-relaxed text-error">{error}</div> : null}
    </div>
  );
}

/**
 * The code waiting for approval: the two digits the account page asks for, in
 * large type, and the way there.
 */
export function HostedEnrollmentCode({
  waiting,
  accountOrigin,
  busy,
  onCancel,
}: {
  waiting: Extract<HostedEnrollmentState, { status: 'waiting' }>;
  accountOrigin: string | null;
  busy: boolean;
  onCancel: () => void;
}) {
  const minutesLeft = useMinutesLeft(waiting.expiresAt) ?? 0;
  const account = hostOf(waiting.verificationUrl);
  const page = accountPage(accountOrigin);
  return (
    <div className="mt-1.5 text-sm leading-relaxed">
      <div className="text-muted">Approve at your account, and type these two digits there:</div>
      <div
        aria-label={HOSTED_ENROLLMENT_CODE_LABEL}
        className="mt-1.5 text-center font-mono text-xl font-bold tracking-widest text-foreground select-all"
      >
        {waiting.confirmDigits}
      </div>
      <div className="mt-1 text-center text-xs text-muted">
        {minutesLeft > 0 ? `Expires in ${minutesLeft} min.` : 'This code has expired.'}
      </div>
      {waiting.accountFull ? (
        <div className="mt-1.5 text-error">
          That account already has as many computers as it can enroll.{' '}
          {page ? <ExternalTextLink href={page}>Remove one at {hostOf(page)}</ExternalTextLink> : 'Remove one from your account'}{' '}
          and this computer enrolls on its own.
        </div>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {/* An expired code approves nothing, so it opens nothing. */}
        <button
          type="button"
          disabled={minutesLeft === 0}
          className={modalActionButton({ tone: 'primary' })}
          onClick={() => getPlatform().openExternal?.(waiting.verificationUrl)}
        >
          Open {account} to approve
        </button>
        <button type="button" disabled={busy} className={modalActionButton()} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** The account host the copy names: the service's, else the release build's. */
export function accountHost(accountOrigin: string | null): string {
  return hostOf(accountOrigin ?? HOSTED_ACCOUNT_ORIGIN);
}

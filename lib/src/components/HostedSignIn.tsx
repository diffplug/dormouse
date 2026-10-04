import { useState } from 'react';
import { TextInput, modalActionButton } from './design';
import { ExternalTextLink } from './ExternalTextLink';
import { FIELD_HINT, FIELD_LABEL, hostOf, useBusyAction, useMinutesLeft } from './remote-control-shared';
import { ACCOUNT_PAGE_PATH, HOSTED_ACCOUNT_ORIGIN } from '../host/relay-origin';
import type { HostedEnrollmentEndReason, HostedEnrollmentState } from '../host/remote/service-protocol';
import { getPlatform } from '../lib/platform';
import { hostedPricingUrl, type HostedRef } from '../lib/hosted-links';
import { BURROW_IS_AN_APP } from '../remote/setup-copy';
import { beginHostedEnrollment, cancelHostedEnrollment } from '../remote/burrow/burrow-status-store';

/**
 * Signing in to Dormouse Hosted from this computer: the device-code
 * enrollment (`docs/specs/hosted.md` -> "Burrow enrollment") that both
 * Settings → Network's Remote control and Notifications' managed voice start.
 * One approval enrolls this computer's Burrow and hands managed voice its
 * token, so both places render the one flow from here.
 */

/** The words of every link to the plans. */
export const PLANS_LABEL = 'See Hosted plans';

/** The plans, linked wherever an account turns out to have none, attributed to the place (`ref`) that links them. */
export function HostedPlansLink({ plansRef }: { plansRef: HostedRef }) {
  return <ExternalTextLink href={hostedPricingUrl(plansRef)}>{PLANS_LABEL}</ExternalTextLink>;
}

/** The begin button's words, everywhere sign-in starts. */
export const SIGN_IN_LABEL = 'Sign in to Dormouse Hosted';

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

/**
 * The accessible name of the code a Hosted enrollment shows, which the account
 * page shows beside Approve for the person to compare.
 */
export const HOSTED_ENROLLMENT_CODE_LABEL = 'Enrollment code';

/**
 * What an enrollment that ended short of enrolling says. **Fixed copy chosen
 * by code**, as `PAIRING_OUTCOME_COPY` is: `failed` alone adds the service's
 * own sentence.
 */
export const HOSTED_ENROLLMENT_ENDED_COPY: Record<HostedEnrollmentEndReason, string> = {
  expired: 'That code expired before it was approved, so this computer was not signed in.',
  'not-entitled': 'The account that approved that code has no Hosted plan, so this computer was not signed in.',
  'answer-lost':
    'That code was approved and used, but the answer never reached this computer, so it was not signed in.',
  failed: 'This computer could not finish signing in.',
};

/** The copy a status's `redeeming` shows: approved, and the enrollment being saved. */
export const HOSTED_ENROLLMENT_REDEEMING_COPY = 'Approved. Signing this computer in…';

/** The account page the service names in `status.accountOrigin`, where computers are removed. */
export function accountPage(accountOrigin: string | null): string | null {
  return accountOrigin === null ? null : `${accountOrigin}${ACCOUNT_PAGE_PATH}`;
}

/** What a lost answer asks of the person: the Burrow it enrolled, named where the service knows it. */
export function answerLostRemoval(burrowId: string | undefined): string {
  return burrowId
    ? `Remove Burrow ${burrowId} from your account, then sign in again.`
    : 'Remove the computer it added from your account, then sign in again.';
}

/** Why the last Hosted enrollment ended, with the account page where it says to go there. */
export function HostedEnrollmentEnded({
  ended,
  accountOrigin,
  plansRef,
}: {
  ended: Extract<HostedEnrollmentState, { status: 'ended' }>;
  accountOrigin: string | null;
  /** Where its plans link says it came from. */
  plansRef: HostedRef;
}) {
  const lost = ended.reason === 'answer-lost';
  const page = lost ? accountPage(accountOrigin) : null;
  return (
    <div className="mt-1.5 text-sm leading-relaxed" role="status">
      <div className="text-foreground">{HOSTED_ENROLLMENT_ENDED_COPY[ended.reason]}</div>
      {lost ? <div className="mt-1 text-foreground">{answerLostRemoval(ended.burrowId)}</div> : null}
      {ended.reason === 'failed' && ended.message ? <div className="mt-1 text-error">{ended.message}</div> : null}
      {ended.reason === 'not-entitled' ? (
        <div className="mt-1">
          <HostedPlansLink plansRef={plansRef} />
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
 * Signing in (`docs/specs/hosted.md` -> "Burrow enrollment"): a button that
 * begins it, under the name to keep for this machine where `askName`; then
 * the code, in large type, a button that opens the account page the service
 * composed to approve it, the time left, and Cancel; ended, why, with a new
 * code a click away. The service polls; this renders its `status`, never a
 * state of its own.
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
  plansRef,
}: {
  enrollment: HostedEnrollmentState | null;
  accountOrigin: string | null;
  suggestedLabel: string;
  askName?: boolean;
  /** Where an ended enrollment's plans link says it came from. */
  plansRef: HostedRef;
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
      {waiting ? (
        <HostedEnrollmentCode
          waiting={waiting}
          accountOrigin={accountOrigin}
          busy={busy}
          onCancel={() => void run(cancelHostedEnrollment)}
        />
      ) : null}
      {redeeming ? (
        <div className="mt-1.5 text-sm leading-relaxed text-foreground" role="status">
          {HOSTED_ENROLLMENT_REDEEMING_COPY}
        </div>
      ) : null}
      {ended ? <HostedEnrollmentEnded ended={ended} accountOrigin={accountOrigin} plansRef={plansRef} /> : null}
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
            {beginning ? 'Getting a code…' : ended ? 'Get a new code' : SIGN_IN_LABEL}
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

/** The code waiting for approval, and the way to approve it. */
function HostedEnrollmentCode({
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
      <div className="text-muted">Approve this computer at your account. Check that it shows this code:</div>
      <div
        aria-label={HOSTED_ENROLLMENT_CODE_LABEL}
        className="mt-1.5 text-center font-mono text-xl font-bold tracking-widest text-foreground select-all"
      >
        {waiting.userCode}
      </div>
      <div className="mt-1 text-center text-xs text-muted">
        {minutesLeft > 0 ? `Expires in ${minutesLeft} min.` : 'This code has expired.'}
      </div>
      {waiting.accountFull ? (
        <div className="mt-1.5 text-error">
          That account already has as many computers as it can sign in.{' '}
          {page ? <ExternalTextLink href={page}>Remove one at {hostOf(page)}</ExternalTextLink> : 'Remove one from your account'}{' '}
          and this computer signs in on its own.
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

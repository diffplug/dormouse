/**
 * One Hosted device-code approval at a time, for either purpose
 * (`docs/specs/hosted.md` -> "Burrow enrollment"): the begin, the code waiting
 * with the two digits the account must type, the polls, and the redemption.
 * Remote-control enrollment and managed voice each run one, differing only in
 * their {@link HostedApprovalFlow}: what begin holds back, how a poll reads,
 * and what a redemption keeps. The rules both keep are `docs/specs/relay.md`
 * -> "Burrow side".
 */
import type { BurrowEnrollBeginResponse } from 'remote-lib-common';
import {
  hostedApprovalDeadline,
  slowDownHostedApproval,
  type HostedApprovalAnswer,
} from '../../remote/burrow/enrollment';
import type { HostedEnrollmentEnded, HostedEnrollmentState } from './service-protocol';

/** What tells one purpose's approval from the other's. */
export interface HostedApprovalFlow<A, H, C> {
  /** Local prerequisites, cancellable before any code is requested. */
  prepare?(): Promise<void>;
  /**
   * Ask Hosted for a code. `held` stays in this process for the polls — the
   * device code with it, never in `state()`. Throws what the panel shows.
   */
  begin(arg: A): Promise<{ begin: BurrowEnrollBeginResponse; held: H }>;
  /** Checked once a begin answers, before its code shows: throws to refuse it. */
  admit?(): void;
  /** The account page the code opens, composed by the host; throws to refuse the begin. */
  verificationUrl(begin: BurrowEnrollBeginResponse): string;
  /** One poll. A throw ends the run `failed` with its message. */
  poll(deviceCode: string, held: H): Promise<HostedApprovalAnswer<C>>;
  /**
   * Hold a credential a poll redeemed. `current` is false when its run was
   * cancelled or replaced while the poll was out. Answers whether it was kept,
   * which makes any other code moot; a throw's message ends the run `failed`.
   */
  redeem(credential: C, current: boolean): Promise<boolean>;
}

interface Run<H> {
  readonly deviceCode: string;
  readonly held: H;
  readonly confirmDigits: string;
  readonly verificationUrl: string;
  /** This machine's deadline, bounded independently of Hosted's clock. */
  readonly expiresAt: number;
  intervalMs: number;
  /** The last poll found the approving account full. */
  accountFull: boolean;
  /** A poll redeemed it, and the flow is holding the credential. */
  redeeming: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class HostedApproval<A, H, C> {
  readonly #flow: HostedApprovalFlow<A, H, C>;
  readonly #onChange: () => void;
  readonly #now: () => number;
  readonly #log: (message: string) => void;
  #run: Run<H> | null = null;
  /** How the last one ended short, until the next begin or a cancel. */
  #ended: HostedEnrollmentEnded | null = null;
  /** Bumped by every begin and cancel, so a begin still in flight that was superseded keeps nothing. */
  #seq = 0;
  /** The begin in flight, which every other begin joins. */
  #beginning: Promise<HostedEnrollmentState> | null = null;
  #disposed = false;

  constructor(
    flow: HostedApprovalFlow<A, H, C>,
    options: {
      /** After every change to `state()`. */
      onChange: () => void;
      now?: () => number;
      /** Where a redemption failing after disposal is reported, there being no state left to show it. */
      log?: (message: string) => void;
    },
  ) {
    this.#flow = flow;
    this.#onChange = options.onChange;
    this.#now = options.now ?? (() => Date.now());
    this.#log = options.log ?? ((message) => console.warn(message));
  }

  /** The approval as the panel draws it: never the device code. */
  state(): HostedEnrollmentState | null {
    const run = this.#run;
    if (run?.redeeming) return { status: 'redeeming' };
    if (run) {
      return {
        status: 'waiting',
        confirmDigits: run.confirmDigits,
        verificationUrl: run.verificationUrl,
        expiresAt: run.expiresAt,
        accountFull: run.accountFull,
      };
    }
    return this.#ended ? { status: 'ended', ...this.#ended } : null;
  }

  /**
   * Begin, and poll from here. **A code already waiting or redeeming is
   * answered, not replaced** — another window's begin lands on the same host —
   * and a begin in flight is joined; one that ended is replaced once a new
   * code is in hand.
   */
  async begin(arg: A): Promise<HostedEnrollmentState> {
    if (this.#run) return this.state()!;
    if (this.#beginning) return await this.#beginning;
    const begun = this.#begin(arg, ++this.#seq);
    this.#beginning = begun;
    try {
      return await begun;
    } finally {
      if (this.#beginning === begun) this.#beginning = null;
    }
  }

  async #begin(arg: A, seq: number): Promise<HostedEnrollmentState> {
    if (this.#flow.prepare) {
      await this.#flow.prepare();
      if (seq !== this.#seq || this.#disposed) throw new Error('This approval was cancelled.');
    }
    const { begin, held } = await this.#flow.begin(arg);
    if (seq !== this.#seq || this.#disposed) throw new Error('This approval was cancelled.');
    this.#flow.admit?.();
    const run: Run<H> = {
      deviceCode: begin.deviceCode,
      held,
      confirmDigits: begin.confirmDigits,
      verificationUrl: this.#flow.verificationUrl(begin),
      expiresAt: hostedApprovalDeadline(begin.expiresAt, this.#now()),
      intervalMs: begin.interval * 1000,
      accountFull: false,
      redeeming: false,
      timer: null,
    };
    this.#clearRun();
    this.#ended = null;
    this.#run = run;
    this.#schedule(run);
    this.#onChange();
    return this.state()!;
  }

  /**
   * Stop the code waiting or ended, and say so; a begin in flight keeps
   * nothing. **A redeeming one is left to land**: its credential is spent.
   * A poll already out that redeems is still offered to the flow.
   */
  cancel(): void {
    this.#seq++;
    this.#beginning = null;
    const run = this.#run && !this.#run.redeeming ? this.#run : null;
    const had = run !== null || this.#ended !== null;
    if (run) this.#clearRun();
    this.#ended = null;
    if (had) this.#onChange();
  }

  /** Forget everything, unannounced, and void a begin in flight. */
  dispose(): void {
    this.#disposed = true;
    this.#seq++;
    this.#beginning = null;
    this.#clearRun();
    this.#ended = null;
  }

  #clearRun(): void {
    if (this.#run?.timer) clearTimeout(this.#run.timer);
    this.#run = null;
  }

  /** The next poll after `run.intervalMs`, or at the deadline if that comes first. */
  #schedule(run: Run<H>): void {
    const delay = Math.max(0, Math.min(run.intervalMs, run.expiresAt - this.#now()));
    run.timer = setTimeout(() => void this.#poll(run), delay);
  }

  async #poll(run: Run<H>): Promise<void> {
    run.timer = null;
    if (this.#run !== run) return;
    if (this.#now() >= run.expiresAt) {
      this.#end(run, { reason: 'expired' });
      return;
    }
    let answer: HostedApprovalAnswer<C>;
    try {
      answer = await this.#flow.poll(run.deviceCode, run.held);
    } catch (error) {
      this.#end(run, { reason: 'failed', message: messageOf(error) });
      return;
    }
    // Offered whatever happened while the poll was out: see `#redeem`.
    if (answer.status === 'approved') {
      await this.#redeem(run, answer.credential);
      return;
    }
    if (this.#run !== run) return;
    switch (answer.status) {
      case 'pending':
        this.#setAccountFull(run, false);
        this.#schedule(run);
        return;
      case 'retry':
        if (answer.slowDown) run.intervalMs = slowDownHostedApproval(run.intervalMs);
        this.#schedule(run);
        return;
      case 'expired':
      case 'mismatch':
        this.#end(run, { reason: answer.status });
        return;
      // An earlier poll redeemed it and its answer was lost on the way.
      case 'redeemed':
        this.#end(run, { reason: 'answer-lost', ...(answer.burrowId ? { burrowId: answer.burrowId } : {}) });
        return;
      // Hosted keeps an approval it refused, so a full account polls on and
      // redeems once a computer is removed; an entitlement ends it.
      case 'refused':
        if (answer.reason === 'account-full') {
          this.#setAccountFull(run, true);
          this.#schedule(run);
        } else {
          this.#end(run, { reason: answer.reason });
        }
        return;
      case 'failed':
        this.#end(run, { reason: 'failed', message: answer.message });
        return;
    }
  }

  /**
   * Offer the flow a credential a poll of `run` redeemed. **Single-use, and
   * recorded by Hosted**, so it is offered even when `run` was cancelled or
   * replaced while the poll was out; `run`, if still current, reports
   * `redeeming` until the flow is done. A flow that throws ends every code
   * with its sentence, unless another code's redemption is still landing.
   */
  async #redeem(run: Run<H>, credential: C): Promise<void> {
    const current = this.#run === run;
    if (current) {
      if (run.timer) clearTimeout(run.timer);
      run.timer = null;
      run.redeeming = true;
      this.#onChange();
    }
    let kept: boolean;
    try {
      kept = await this.#flow.redeem(credential, current);
    } catch (error) {
      if (this.#disposed) {
        this.#log(messageOf(error));
        return;
      }
      if (this.#run === run || !this.#run?.redeeming) {
        this.#seq++;
        this.#clearRun();
      }
      this.#ended = { reason: 'failed', message: messageOf(error) };
      this.#onChange();
      return;
    }
    if (!kept || this.#disposed) return;
    // Kept: whatever code is still waiting — a replacing begin's — is moot.
    this.#seq++;
    this.#clearRun();
    this.#onChange();
  }

  #setAccountFull(run: Run<H>, full: boolean): void {
    if (run.accountFull === full) return;
    run.accountFull = full;
    this.#onChange();
  }

  /** End `run` short, if it is still the one waiting. */
  #end(run: Run<H>, ended: HostedEnrollmentEnded): void {
    if (this.#run !== run) return;
    this.#clearRun();
    this.#ended = ended;
    this.#onChange();
  }
}

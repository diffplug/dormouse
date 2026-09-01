# Alert — Rationale

> Informative companion to [alert.md](alert.md): the evidence, worked failure cases, and dead-approach history behind its rules, keyed by that spec's headings (AGENTS.md → "The rationale split"). Nothing here is normative.

## Public State

**Why the detector outranks the command-exit arm.** A watched command is by definition running, so a Session with WATCHING on is almost always also command-exit armed. Ranking the arm first would therefore mask the detector's busy/quiet states for the whole run — and the detector's state is the one derived from real output, so it is the one worth showing.

## Await

**Why `quiet` includes exit and the bell.** No caller wants "wake me when it settles" and also wants to keep blocking after the thing died; without the exit signal, a peer that crashes hangs its caller until the timeout. The bell is in for the opposite reason: an explicit `OSC 9` / `BEL` is *stronger* evidence than inferred silence, so ignoring the peer saying "I need input" while waiting for it to go quiet would be perverse.

**Why `exit` excludes the bell.** Plenty of build tools ring on a warning. Being the strict one is `exit`'s whole job, so it takes only the signal it named.

**Why `--until` is never inferred.** The WATCHING rule set is a human notification preference — app-global, edited from a dialog. Binding a program's wake condition to it would mean an unrelated human edit (removing a command from the watched set to quiet the bell) silently changes what every `await` parked on that Session is waiting for.

**Why `idle` is a `cause`, not a failure.** A caller that asked for quiet and found quiet got what it asked for. Making it a distinct cause rather than a distinct failure lets a simple caller treat success as success, while a careful one can still tell "it settled" from "there was never anything there".

**Why a command-exit ring is gated on nothing running.** The ring latches past the run that raised it, so once another command has started it can only describe the previous one. That is exactly the misreport a `dor send` followed by `dor await --until exit` would act on.

**Why a WATCHING ring is gated on `outputSinceWatchingRing`.** The ring legitimately describes a long-running watched command going quiet — which is what `--until quiet` exists for — but it is an inference from silence, and nothing clears it when the peer starts talking again. Consuming it mid-turn would make the documented `await && read` idiom read a half-drawn screen. The detector cannot stand in for the flag because its post-output `NOTHING_TO_SHOW` window (`busyCandidateGap`) is longer than the two CLI round trips between a `dor send` and the await behind it, so it would still read as settled.

**Why an await never sets TODO.** Beyond being untrue, it would leak: the last await of an orchestration would strand a marker for a fully handled event. And because TODO feeds the Workspace union, an orchestration awaiting across several panes would light the whole Workspace up.

**Why nothing quieter is substituted for the absorbed ring.** A receipt the human must clear by hand is the same noise in a smaller font, and forensics after a failure come from the pane's own scrollback anyway.

**Why the claim window is left unacknowledged.** Closing the gap between a claim and the caller actually reading the outcome would need a two-phase claim on *every* completion, to cover a process that dies in the microseconds after its answer was computed.

**Why the timeout ceiling exists at all.** Like the inactivity timeout, `timeoutMs` originates a process away and ends up in `setTimeout`, whose delay is a signed 32-bit millisecond count. Anything past ~24.9 days overflows and fires immediately, turning a long park into an instant `timeout` — the opposite of what the caller asked for.

## Completion events

**Why the gate reads private detector state.** The detector runs for unwatched commands, while protocol progress and command-exit status can mask it in the public projection. The gate needs the underlying evidence, not whichever bell state wins display precedence.

**Why command finishes bypass animation deferral.** A shell-reported exit is authoritative evidence that the foreground command ended, while animation detection is only a recent-output heuristic. Letting the heuristic overrule the lifecycle event would add latency and could let unrelated background output defer a certain completion indefinitely.

**Why a deferred event is not dispatched again.** Claimants already received first refusal when the completion happened. Re-offering it at quiet time would let an await registered later consume history and would report one completion twice.

## WATCHING Track

**Why the keystroke fallback is not routed into the manager.** The fallback in `docs/specs/terminal-state.md` is renderer-side and lower confidence than a shell-reported command boundary. Wiring it in would buy integration-less shells a worse version of WATCHING at the price of a second command-tracking path to keep in sync with the real one.

## Alarm settings

**Why animation deferral defaults off.** BEL and notification OSCs explicitly ask to alert now, while continuously changing output may never become quiet. Opt-in preserves their established timing and makes indefinite deferral a deliberate choice.

## Spoken alarms

**Why the settle path cannot assume an async callback.** Chrome dispatches `start` and then `error` with `not-allowed` *synchronously* inside `speechSynthesis.speak()` when speech is invoked without a user gesture — which is exactly this call site, since an alarm fires on a timer while the user is away.

## Push notifications

**Why the Host does not ask which devices are subscribed first.** The Server intersects the Host's targets with its own subscriptions regardless, so the target set is identical either way; asking first would just cost the alarm a second round trip.

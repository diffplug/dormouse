# Alert — Rationale

> Informative companion to [alert.md](alert.md): the evidence, worked failure cases, and dead-approach history behind its rules, keyed by that spec's headings (AGENTS.md → "The rationale split"). Nothing here is normative.

## Public State

**Why the detector outranks the command-exit arm.** A watched command is by definition running, so a Session with WATCHING on is almost always also command-exit armed. Ranking the arm first would therefore mask the detector's busy/quiet states for the whole run — and the detector's state is the one derived from real output, so it is the one worth showing.

## Completion events

**Why nothing is decided at the point of detection.** Dispatching before suppression is what lets an observer see the three-second `npm test` that finished attended and would never have rung anyone. A seam that only fired the events a human would have been shown could not serve `dor await` at all.

**Why the gate reads private detector state.** The detector runs for unwatched commands, while protocol progress and command-exit status can mask it in the public projection. The gate needs the underlying evidence, not whichever bell state wins display precedence.

**Why command finishes bypass animation deferral.** A shell-reported exit is authoritative evidence that the foreground command ended, while animation detection is only a recent-output heuristic. Letting the heuristic overrule the lifecycle event would add latency and could let unrelated background output defer a certain completion indefinitely.

**Why a deferred event is not dispatched again.** Claimants already received first refusal when the completion happened. Re-offering it at quiet time would let an await registered later consume history and would report one completion twice.

## Await

**Why `quiet` includes exit and the bell.** No caller wants "wake me when it settles" and also wants to keep blocking after the thing died; without the exit signal, a peer that crashes hangs its caller until the timeout. The bell is in for the opposite reason: an explicit `OSC 9` / `BEL` is *stronger* evidence than inferred silence, so ignoring the peer saying "I need input" while waiting for it to go quiet would be perverse.

**Why `exit` excludes the bell.** Plenty of build tools ring on a warning. Being the strict one is `exit`'s whole job, so it takes only the signal it named.

**Why `--until` is never inferred.** The WATCHING rule set is a human notification preference — app-global, edited from a dialog. Binding a program's wake condition to it would mean an unrelated human edit (removing a command from the watched set to quiet the bell) silently changes what every `await` parked on that Session is waiting for.

**Why silence at a prompt is not a settle.** The detector cannot report a settle without having been BUSY first, which is what makes the `dor send` / `dor await` idiom safe: the await parks in the window before the peer's first byte instead of resolving on the quiet that was already there.

**Why `idle` is a `cause`, not a failure.** A caller that asked for quiet and found quiet got what it asked for. Making it a distinct cause rather than a distinct failure lets a simple caller treat success as success, while a careful one can still tell "it settled" from "there was never anything there".

**Why a command-exit ring is gated on nothing running.** The ring latches past the run that raised it, so once another command has started it can only describe the previous one. That is exactly the misreport a `dor send` followed by `dor await --until exit` would act on.

**Why a WATCHING ring is gated on `outputSinceWatchingRing`.** The ring legitimately describes a long-running watched command going quiet — which is what `--until quiet` exists for — but it is an inference from silence, and nothing clears it when the peer starts talking again. Consuming it mid-turn would make the documented `await && read` idiom read a half-drawn screen. The detector cannot stand in for the flag because it never latches: it reports how output looks *now*, and its post-output `NOTHING_TO_SHOW` window (`busyCandidateGap`) is longer than the two CLI round trips between a `dor send` and the await behind it, so it would still read as settled.

**Why an await never sets TODO.** TODO means a human owes this pane attention, and after an await nobody does — a program asked to be told, was told, and acted. Beyond being untrue, a TODO would leak: the last await of an orchestration would strand a marker for a fully handled event. And because TODO feeds the Workspace union, an orchestration awaiting across several panes would light the whole Workspace up. A TODO left by an *unrelated* earlier event is a different debt and stays owed.

**Why nothing quieter is substituted for the absorbed ring.** A receipt the human must clear by hand is the same noise in a smaller font, and forensics after a failure come from the pane's own scrollback anyway.

**Why the claim window is left unacknowledged.** Closing the gap between a claim and the caller actually reading the outcome would need a two-phase claim on *every* completion, to cover a process that dies in the microseconds after its answer was computed.

**Why the timeout ceiling exists at all.** Like the inactivity timeout, `timeoutMs` originates a process away and ends up in `setTimeout`, whose delay is a signed 32-bit millisecond count. Anything past ~24.9 days overflows and fires immediately, turning a long park into an instant `timeout` — the opposite of what the caller asked for.

**Why a disposing VS Code webview must answer its own parked requests, synchronously.** A caller that can no longer be answered must not go on absorbing completions the human would otherwise have been shown. The answer has to be synchronous because the cancelled outcome would otherwise arrive a microtask after the router stopped posting, and would be dropped — leaving `dor` blocked on a reply that never comes.

## WATCHING Track

**Why WATCHING keys on the command rather than the Session.** Turning alerts on while `claude` runs is a statement about `claude`, not about the pane that happened to be focused: every Session running it watches, the ones open now and the ones opened later, and turning them off anywhere removes the rule everywhere. A per-Session enable would have to be re-established by hand in every new pane, which is the opposite of what the gesture means.

**Why the alert state is retired before the PTY is killed.** A data chunk is enough to create a Session's entry, so killing first leaves output already in flight to rebuild an entry — and a `QuiesceDetector` that nothing will ever dispose. Raw output and resizes are exactly what a dying PTY emits, so they can never revive a retired id; a semantic or protocol event can, because an id may be handed to a replacement pane and its first reported command start is the evidence that somebody is home.

**Why a mid-command enable shows the current state.** The detector runs whether or not a rule matches, so the rule set only gates visibility. Starting a fresh detector when a rule is added would report `NOTHING_TO_SHOW` for a command that has been busy for ten minutes.

**Why the keystroke fallback is not routed into the manager.** The fallback in `docs/specs/terminal-state.md` is renderer-side and lower confidence than a shell-reported command boundary. Wiring it in would buy integration-less shells a worse version of WATCHING at the price of a second command-tracking path to keep in sync with the real one.

## Alarm settings

**Why animation deferral defaults off.** BEL and notification OSCs explicitly ask to alert now, while continuously changing output may never become quiet. Opt-in preserves their established timing and makes indefinite deferral a deliberate choice.

**Why the settings ride the WATCHING rule set's seed/broadcast shape.** Each VS Code webview has its own origin and therefore its own `localStorage`, while the `AlertManager` is shared. Without a host-authoritative copy, two webviews would each believe their own blob. The one difference is the whole-blob relay: an alarm setting is not a set of independent keys the way a rule list is, so a per-key delta would let two webviews disagree about whether alarms speak.

**Why both sinks share one ring machine.** "Fired on a fresh unattended ring, re-checked after the delay, once per ring, never on first observation" is a small pile of rules subtle enough to drift if speech and push each carried a copy.

**Why a first-observation ring never fires.** A restore or a reconnect replays a latched ring, and a persisted session blob can carry one from days ago. Treating that as fresh would buzz the paired phone at every launch.

## Spoken alarms

**Why the label is sanitized before it reaches the engine.** WebKit silently drops an utterance containing angle brackets **and leaves the synthesizer wedged**, so every later utterance is dropped too until the page reloads. Pane labels carry chrome like `<idle>` and terminal-supplied titles reach speech, so without the pass any program could permanently disable spoken alarms for the session by putting a `<` in its title. Substituting spaces rather than deleting also keeps adjacent words separate and prevents formatting markers such as `*` from being announced.

**Why the settle path cannot assume an async callback.** Chrome dispatches `start` and then `error` with `not-allowed` *synchronously* inside `speechSynthesis.speak()` when speech is invoked without a user gesture — which is exactly this call site, since an alarm fires on a timer while the user is away. Reading a variable the caller assigns after `speak()` returns would therefore drop the settle and pin the Session at `speaking` for the rest of the ring.

## Push notifications

**Why both halves live under `remote/host/`.** It keeps the sink inside the lazily-imported `RemotePairingModalHost` chunk, so hosts that never set `enableRemoteHost` never fetch it. The shared ring machine and the device store stay in the common bundle instead, since speech and the settings dialog need them everywhere.

**Why `toPushText` is not `toSpokenText`.** The speech sanitizer's angle-bracket rule exists only because WebKit's synthesizer wedges on them; an OS notification has no such failure. What an OS notification *does* have is bidi and zero-width formatting that can visually reorder or hide text, so the push pass strips those instead and keeps the brackets.

**Why the Host, not the Server, chooses recipients.** Nothing propagates a revocation today (`docs/specs/remote-security-model.md` → Future), so a revoked Client keeps its subscription row on the Server. A Server that picked recipients from its own rows would keep pushing Pane labels to a de-authorized phone; reading the Host's *active* ACL at send time means a revocation during the alarm delay takes effect.

**Why the Host does not ask which devices are subscribed first.** The Server intersects the Host's targets with its own subscriptions regardless, so the target set is identical either way; asking first would just cost the alarm a second round trip.

## Settings dialog

**Why the device line always says something.** A push that silently goes nowhere is indistinguishable from a broken one, so "no Host enrolled", "nothing subscribed yet", and "the server could not be asked" are each worth their own message rather than an empty list.

## Pane Header

**Why `cfg.alert.ringingPaused` suppresses the pulse.** It is the Chromatic freeze that pins the bell: an infinite opacity cycle would otherwise snapshot at an arbitrary phase and diff against itself on every run.

## Text And Security

**Why the cold-restore path is not re-sanitized.** `normalizeActivityNotification` is a shape check, so a persisted blob is re-accepted without re-applying the cap or the control strip. Reaching it requires a corrupted or hand-edited session store, and the text is rendered as plain text everywhere, so the residual exposure is layout — a very long or control-bearing string in a preview — rather than markup.

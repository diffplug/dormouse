# Alert — Rationale

> Informative companion to [alert.md](alert.md): the evidence, worked failure cases, and dead-approach history behind its rules, keyed by that spec's headings (AGENTS.md → "What, not why"). Nothing here is normative.

## Public State

**Why the detector outranks the command-exit arm.** A watched command is by definition running, so a WATCHING Session is almost always also command-exit armed; ranking the arm first would mask the detector's busy/quiet states for the whole run, and the detector's state is the one derived from real output.

## Attention

**Why attention uses the narrow reply classifier.** The prompt recorder filters every CSI/SS3 sequence because it cannot interpret them as command text. Reusing that filter for attention ignored real encoded keys, while its omission of DCS let device-query replies attend background panes; regression tests reproduced both failures in September 2026. The narrower reply classifier already used for replay and untouched-session tracking separates keys from replies without changing live PTY forwarding. Mouse-only chunks need a separate guard: the narrower classifier does not include mouse encodings, and inside programs can request hover and wheel reports without a click. Those reports otherwise dismiss a ring and cancel its pending alarms. Actual clicks already attend through the Pane’s DOM handler.

## Completion events

**Why nothing is decided at the point of detection.** Dispatching before suppression lets an observer see the three-second `npm test` that finished attended and would never have rung anyone. A seam firing only the events a human would have been shown could not serve `dor await` at all.

**Why the gate reads private detector state.** The detector runs for unwatched commands, and other tracks can mask it in the public projection; the gate needs the underlying evidence, not whichever state wins display precedence.

**Why command finishes bypass animation deferral.** A shell-reported exit is a lifecycle event; animation detection is only a recent-output heuristic. Letting the heuristic overrule the event would add latency and let unrelated background output defer a certain completion indefinitely.

**Why a deferred event is not dispatched again.** Claimants already had first refusal when the completion happened; re-offering it at quiet time would let a later-registered await consume history, and would report one completion twice.

## Await

**Why `quiet` includes exit and the bell.** No caller wants "wake me when it settles" and also wants to keep blocking after the thing died: without exit, a crashed peer hangs its caller until the timeout. The bell is in for the opposite reason — an explicit `OSC 9` / `BEL` is *stronger* evidence than inferred silence, so ignoring "I need input" while waiting for the peer to go quiet would be perverse.

**Why `exit` excludes the bell.** Plenty of build tools ring on a warning, and being the strict one is `exit`'s whole job.

**Why `--until` is never inferred.** The WATCHING rule set is a human notification preference — app-global, edited from a dialog. Binding a program's wake condition to it would let an unrelated human edit (removing a command from the watched set to quiet the bell) silently change what every `await` parked on that Session is waiting for.

**Why silence at a prompt is not a settle.** The BUSY-first precondition is what makes the `dor send` / `dor await` idiom safe: the await parks in the window before the peer's first byte instead of resolving on the quiet that was already there. The grace window answers the same question from the other side — silence alone cannot separate a peer that answered long ago from one working quietly — which is also why a running foreground command skips the window outright: a silent build resolves on its exit rather than being guessed at.

**Why `idle` is a `cause`, not a failure.** A caller that asked for quiet and found quiet got what it asked for. A distinct cause rather than a distinct failure lets a simple caller treat success as success, while a careful one can still tell "it settled" from "there was never anything there".

**Why a command-exit ring is gated on nothing running.** The ring latches past the run that raised it, so once another command has started it can only describe the previous one — exactly the misreport a `dor send` followed by `dor await --until exit` would act on.

**Why a WATCHING ring is gated on `outputSinceWatchingRing`.** The ring legitimately describes a long-running watched command going quiet — what `--until quiet` exists for — but it is an inference from silence, and a brief burst does not clear it when the peer starts talking again; consuming it mid-turn would make the documented `await && read` idiom read a half-drawn screen. The detector cannot stand in for the flag because it never latches: it reports how output looks *now*, and its post-output `NOTHING_TO_SHOW` window (`busyCandidateGap`) is longer than the two CLI round trips between a `dor send` and the await behind it, so it would still read as settled.

**Why an await never sets TODO.** TODO means a human owes this pane attention; after an await nobody does — a program asked to be told, was told, and acted. A stranded TODO also leaks: the last await of an orchestration would mark a fully handled event, and because TODO feeds the Workspace union, an orchestration awaiting across several panes would light the whole Workspace up. A TODO from an *unrelated* earlier event is a different debt and stays owed.

**Why nothing quieter is substituted for the absorbed ring.** A receipt the human must clear by hand is the same noise in a smaller font, and forensics after a failure come from the pane's own scrollback anyway.

**Why the claim window is left unacknowledged.** Closing the gap between a claim and the caller actually reading the outcome would need a two-phase claim on *every* completion, to cover a process that dies in the microseconds after its answer was computed.

**Why the timeout ceiling exists at all.** `timeoutMs` is a safety rail on a blocking call inside an agent loop, not an alert-tuning knob. Like the inactivity timeout it originates a process away and ends up in `setTimeout`, whose delay is a signed 32-bit millisecond count. Anything past ~24.9 days overflows and fires immediately, turning a long park into an instant `timeout`.

**Why a disposing VS Code webview answers its own parked requests synchronously.** A caller that can no longer be answered would otherwise go on absorbing completions the human would have been shown. Synchronously, because the cancelled outcome would arrive a microtask after the router stopped posting and be dropped, leaving `dor` blocked on a reply that never comes.

## WATCHING Track

**Why candidate history expires on arrival rather than only on its timers.** The marked `dormouse.workspaces-2` alert (2026-09-09) followed 218 seconds of silence and two chunks 62 ms apart: unconfirmed candidate history outlived its timers, which run late in hidden views, and let that short burst confirm BUSY. Measuring the gap between accepted chunks keeps idle time from counting as sustained work.

**Why WATCHING keys on the command rather than the Session.** Turning alerts on while `claude` runs is a statement about `claude`, not about the pane that happened to be focused. A per-Session enable would have to be re-established by hand in every new pane, which is the opposite of what the gesture means.

**Why the alert state is retired before the PTY is killed.** A data chunk is enough to create a Session's entry, so killing first leaves output already in flight to rebuild an entry — and a `QuiesceDetector` that nothing will ever dispose. Raw output and resizes are exactly what a dying PTY emits; a semantic or protocol event may revive an id, because an id may be handed to a replacement pane and its first reported command start is evidence that somebody is home.

**Why a mid-command enable shows the current state.** Starting a fresh detector when a rule is added would report `NOTHING_TO_SHOW` for a command that has been busy for ten minutes.

**Why the keystroke fallback is not routed into the manager.** The fallback in `docs/specs/terminal-state.md` is renderer-side and lower confidence than a shell-reported command boundary. Wiring it in would buy integration-less shells a worse version of WATCHING at the price of a second command-tracking path to keep in sync.

**Why resumed work withdraws an inferred WATCHING ring.** The marked `ttr.pgstencil-adopt` speech (2026-09-09 18:17:03) followed a WATCHING settle, resumed output, and confirmed BUSY before the speech deadline; the latched ring masked that activity, so the renderer spoke while the terminal was still animating. Withdrawing the ring lets the existing sink cancellation and fresh-ring delays follow the new busy/quiet cycle. Only the inference goes: explicit reports and command exits stay authoritative, and a redraw too brief to confirm BUSY never invalidates completion.

## Alarm settings

**Why animation deferral defaults on.** Coding agents (`claude`, `codex`) send their notification OSC while their TUI is still redrawing its spinner, so an undeferred ring summons the user to a pane that is still animating (2026-09). The gate engages only while the private detector is fully armed, so a BEL from an otherwise quiet shell still rings at once. Deferral is unbounded, so continuous output can hold a ring indefinitely; turning the switch off is the escape hatch that restores the protocols' literal timing. Installs that saved any settings blob keep the old value: the blob has no version field, and a persisted `false` cannot be told from a deliberate opt-out, so dropping it on read would leave the off position unpersistable.

**Why the settings ride the WATCHING rule set's seed/broadcast shape.** Each VS Code webview has its own origin and therefore its own `localStorage`, while the `AlertManager` is shared; without a host-authoritative copy, two webviews would each believe their own blob. The one difference is the whole-blob relay: an alarm setting is not a set of independent keys the way a rule list is.

**Why both sinks share one ring machine.** "Fresh unattended ring, re-checked after the delay, once per ring, never on first observation" is a small pile of rules subtle enough to drift if speech and push each carried a copy.

**Why a first-observation ring never fires.** A restore or a reconnect replays a latched ring, and a persisted session blob can carry one from days ago. Treating that as fresh would buzz the paired phone at every launch.

## Spoken alarms

**Why an entropy heuristic, and what it costs.** A bare token can reach a terminal-supplied title without credential-related wording. Finite samples often fall below their alphabet's maximum entropy, so the cutoffs sit below those maxima and still miss some random tokens. Conversely, `/`, `-`, and `_` are token characters: 135 of this repo's 1102 tracked paths redact (12.3%, measured 2026-09), and `vim lib/src/lib/redact-high-entropy.ts` speaks as `vim REDACTED.ts`. Speech accepts this loss of detail to reduce accidental disclosure. Redacting before punctuation cleanup and truncation prevents those transforms from hiding a token's recognizable shape while leaving its contents speakable.

**Why only hex grouping is normalized.** Grouped hex otherwise falls into the base64 tier and almost always misses its higher cutoff. In review samples of 20,000 random UUIDs, removing hex separators reduced misses from 100% to 0.01%, with no additional matches among the 1102 tracked paths (measured 2026-09). Applying separator removal to other alphabets would also redact `PostgreSQL_Connection_Manager` and `implementation_details_v2`; limiting normalization to hex keeps those identifiers unchanged.

**Why padding must end the candidate.** Absorbing an `=` separator turns `CargoBuildFinished=ok` into `REDACTEDok`. Leaving it for punctuation cleanup yields `REDACTED ok`, preserving the word boundary. Trailing padding belongs to the token and carries no useful speech content.

**Why embedded hex runs are checked.** A non-hex prefix or suffix such as `pod-` or `-log` otherwise moves an entire UUID candidate into the base64 tier, whose higher cutoff misses most such values. Checking every contiguous hex-group run preserves the hex threshold inside those candidates; replacing the enclosing token also avoids speaking credential prefixes or suffixes.

**Why base32 does not require a digit.** Letter-only values are valid base32, including short high-entropy strings that fall below the base64 tier's minimum length. A digit requirement would reduce false positives but intentionally miss those values. The accepted cost extends beyond paths: review measured 663 of 2048 distinct ASCII-letter identifiers of at least 16 characters in `lib/src/` redacting (32.4%, measured 2026-09), including `PostgreSQLConnectionManager` and `CargoBuildFinished`. The cutoff test for `ABCDEFGHJKLMABCD` records that choice.

**Why the label is sanitized before it reaches the engine.** WebKit silently drops an utterance containing angle brackets **and leaves the synthesizer wedged**, so every later utterance is dropped until the page reloads. Pane labels carry chrome like `<idle>`, and terminal-supplied titles reach speech, so any program could permanently disable spoken alarms for the session by putting a `<` in its title. Substituting spaces rather than deleting also keeps adjacent words separate and prevents formatting markers such as `*` from being announced.

**Why the settle path cannot assume an async callback.** Chrome dispatches `start` and then `error` with `not-allowed` *synchronously* inside `speechSynthesis.speak()` when speech is invoked without a user gesture — exactly this call site, since an alarm fires on a timer while the user is away. Reading a variable the caller assigns after `speak()` returns would drop the settle and pin the Session at `speaking` for the rest of the ring.

Guarding only completion leaves a stale `start` free to replace the active utterance's token. Queue-admission identity also covers old rings, collateral redispatch, and evicted callbacks after teardown; it retains one token per ringing Session without retaining each engine utterance.

## Push notifications

**Why both halves live under `remote/burrow/`.** The sink rides the lazily-imported `RemotePairingModalHost` chunk; the shared ring machine and the device store stay in the common bundle instead, since speech and the settings dialog need them everywhere.

**Why `toPushText` is not `toSpokenText`.** The angle-bracket rule exists only because WebKit's synthesizer wedges on them (Spoken alarms); an OS notification has no such failure, and instead has bidi and zero-width formatting that can visually reorder or hide text.

**Why the Burrow, not the Relay, chooses recipients.** A revoked Client keeps its subscription row on the Relay, nothing propagating a revocation today (`docs/specs/remote-security-model.md` → Future), so a Relay picking recipients from its own rows would keep pushing Pane labels to a de-authorized phone.

**Why the Burrow does not ask which devices are subscribed first.** The Relay intersects the Burrow's targets with its own subscriptions regardless, so the target set is identical either way; asking first would cost the alarm a second round trip.

## Settings dialog

**Why the device line always says something.** A push that silently goes nowhere is indistinguishable from a broken one, so each cause is worth its own message rather than an empty list.

## Pane Header

**Why `SPEAKING` may pulse unbounded and `SPOKEN` may not.** An utterance is seconds long and stops on its own, so the pulse it carries is self-bounding. `SPOKEN` persists until the ring is attended, so animating it would be exactly the per-Session animation with no end that bounding the burst exists to remove.

**Why `cfg.alert.ringingPaused` suppresses the pulse.** It is the Chromatic freeze that pins the alarm; even a bounded animation could otherwise snapshot at an arbitrary phase during its first 2.6 seconds.

**Why the unlabelled treatment pulses once per episode.** An infinite per-Session animation is expensive, and the whole-Pane treatment covers far more surface than the retired bell icon did. With four focused panes wearing an infinite animation, three minutes cost 6.89 MB of embedder memory, 1,127 style recalculations, and 3.99 seconds of renderer CPU; pausing only those animations in the same loaded document reduced that to 0.13 MB, two recalculations, and 0.025 seconds. After bounding the burst, two consecutive three-minute windows each had zero live animations, one recalculation, under 0.40 MB of non-cumulative embedder drift, and at most 0.024 seconds of renderer CPU (measured in Chrome 150, 2026-09). A handful of cycles preserves the entry cue without leaving an animation running for the lifetime of an unattended alert. The episode — not a track latch — is the key because the episode is the summons the sinks already work from: a second track latching inside one enriches an alarm the user was already shown, and re-flashing the whole Pane for it would read as a new alarm. Running the burst off `episode.startedAt` rather than from mount makes the CSS clock a property of the episode, so minimize → reattach or a Workspace switch lands past an expired burst instead of replaying it. A Session BEL-ing in a loop still cannot restart the burst, because a track that is already latched does not re-latch.

## Text And Security

**Why the cold-restore path is not re-sanitized.** Reaching it requires a corrupted or hand-edited session store, and the text is rendered as plain text everywhere, so the residual exposure is layout — a very long or control-bearing string in a preview — rather than markup.

## Live Workspace transfer

A persisted reminder intentionally forgets rings and detector history. Reusing it for a live move erased alert episodes and pending delivery; recreating them from public status could instead speak twice. The live snapshot and per-sink receipt distinguish this handoff from cold restore. Receipt consumption occurs at sink admission because there is no transactional acknowledgement tying audible sound or phone display to Workspace ownership (2026-09).

## Workspace union

A Workspace-level counter was tried first and dropped: the maximum child counter hides a new alert from a child with a smaller counter, and summing counters turns adding or removing a member into a notification. The earliest ringing member's episode replaces it because a hidden tab shows one alarm however many members are behind it, and because switching Workspaces re-derives the union from scratch — an `episode.startedAt` survives that, while a locally tracked generation had to be retained alongside it (2026-09).

"Only that interval" is load-bearing because the tab's memory of a ring is a cache the visible Workspace never refreshes. The retired `WorkspaceRingCues` observed the active Workspace too, so a ring that started and ended while its tab was visible could not leave anything behind; the union cache that replaced it can. Left in place, the stale `ringingSince` is carried forward into the next ring, whose `animationDelay` is then already past the burst's end — the tab wears a static edge for a summons that should have flashed (2026-09).

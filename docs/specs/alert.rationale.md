# Alert — Rationale

> Informative companion to [alert.md](alert.md): the evidence, worked failure cases, and dead-approach history behind its rules, keyed by that spec's headings (AGENTS.md → "What, not why"). Nothing here is normative.

## Public State

**Why one ring instead of three tracks.** Each track stored its ring differently and doubled as other state: the protocol ring shared `protocolStatus` with progress, the command-exit ring shared `commandExitStatus` with the arm, and WATCHING kept a command key. Every clearing verb, await, and restart then treated them differently — the TODO asymmetries under Clearing And TODO, progress un-ringing a report, a bell overwriting an exit code (audit, 2026-09-23). One latch with a list of sources gives every rule one place to act.

**Why the reader drops what it cannot validate, and the writer keeps to the strict sources.** Builds before the tolerant reader validate every persisted pane's notification against their own source list, and one unknown source rejects the whole session, not just the detail (`isPersistedSessionV3`). A development build and an installed one share one session file, so a source added later — `WATCHING` was the first — would empty the older build's restore. The reader now drops only the detail. The writer's allowlist is transitional: it protects the strict builds still installed, and goes once none reads the file. Until then a `WATCHING` TODO survives a restart, and only its generated `<key> went quiet` detail stays live.

**Why the detector outranks the command-exit arm.** A watched command is by definition running, so a WATCHING Session is almost always also command-exit armed; ranking the arm first would mask the detector's busy/quiet states for the whole run, and the detector's state is the one derived from real output.

## Engagement

**Why three signals instead of one attention lease.** `attend()` used to acknowledge the Session, stand in for presence, and name the focus all at once, as a 15-second keystroke lease read once at completion time. Each merge failed on its own (audit, 2026-09-23): a user who pressed `Enter` and sat back watching a build had the pane they were staring at ring 15 seconds later; a Claude Code permission prompt arriving 8 seconds after the user submitted a prompt was dropped outright because the lease was still running, and nothing re-raised it after they walked away; a click that attended one pane armed another; and a browser Surface click created a manager entry that masked its local TODO. Presence belongs to a window, focus to a Wall, acknowledgement to a Session, so each is reported where it is known.

**Why pointer movement and the wheel count as presence.** Reading output is the common way to watch a pane, and it involves scrolling and moving the mouse but no typing; only keystrokes counted before, so reading a scrolling build for 15 seconds counted as walking away.

**Why a command-mode selection is not focus.** Command mode is navigation: the selection passes over panes while the user looks for one, and none of them receives the keyboard. Treating it as focus would hold completions on whatever pane the cursor was left on.

**Why a focused iframe holds presence.** Input typed into an iframe browser Surface goes to the frame's own document, so a user typing in a browser pane lapsed `idle` after the inactivity timeout and was pushed while at the keyboard (review, 2026-09-23). The accepted cost: walking away with a browser pane focused keeps the viewer present, so a push waits until the window blurs or hides. Speech is unaffected, since a browser Surface is never focus. An application switch with the frame focused blurs only the frame, which is why the next deadline checks the window itself.

**Why the renderer computes presence.** It is the only side that sees input events, and a presence timer in the host would need an IPC message per event to refresh it; one message per transition carries the same information.

**Why each VS Code webview is its own viewer.** The webviews share one manager. With one attention slot, a webview's window blur sent an id-less clear that wiped the attention another webview had just set, arming its running build (audit, 2026-09-23).

**Why the reply classifier is the narrow one.** The prompt recorder filters every CSI/SS3 sequence because it cannot interpret them as command text. Reusing that filter here ignored real encoded keys, while its omission of DCS let device-query replies acknowledge background panes; regression tests reproduced both failures in September 2026. The narrower reply classifier already used for replay and untouched-session tracking separates keys from replies without changing live PTY forwarding. Mouse-only chunks need a separate guard: the narrower classifier does not include mouse encodings, and inside programs can request hover and wheel reports without a click. Those reports otherwise dismiss a ring and cancel its pending alarms. Actual clicks already acknowledge through the Pane's DOM handler. A Client's write carries no mark — protocol-v1's `terminal.write` is bytes alone — so a Pocket scroll in tmux or `vim` cleared the ring and TODO until the host classified the bytes itself (review, 2026-09-24).

**Why human input rides its write.** The echo of a keystroke comes back from the PTY within milliseconds, so the acknowledgement that opens the echo window has to be in effect before the bytes are written. As a separate command it would race the write across the host boundary, and an echo that won would count as the program working.

**Why the echo window.** The detector cannot tell a program's output from the echo of the user's own keys: typing a draft into a watched `claude` pane at seven keys a second built BUSY from echo alone, so leaving the pane mid-draft rang it, and a parked `dor await --until quiet` resolved on the half-typed draft (audit probes, 2026-09-23). A recorded Claude Code 2.1 session echoed each key within 10 ms. The window is 750 ms rather than the first 250 ms: a command that answers its `Enter` at once — a typo, a fast failure, a quick `git status` — finished while the user was looking at it, and slower remote echo is covered too (dogfooding, 2026-09-24). A program's real response to `Enter` counts from 750 ms on.

**Why a completion inside the echo window neither rings nor holds.** It answers the keystroke: a bell on a failed Tab completion, the exit `Ctrl-C` just caused, a `q` quitting a pager. Held, it would ring the pane the user is looking at the moment they sat back for the inactivity timeout.

## Completion events

**Why hold instead of drop.** A completion on an engaged Session used to be discarded, so a report the user never acted on was lost once they walked away — the permission prompt under Engagement is the recorded case. Holding keeps the summons owed without ringing a pane the user is looking at: acting on it answers it, and walking away rings it.

**Why dropping on an explicit disengage may be a mistake.** Moving focus to another pane, or leaving the window, is a deliberate act by someone who was looking at the completion, so ringing it then would summon them for something they just saw (decision, 2026-09-23). It also forgets a prompt the user glanced at and clicked away from to look something up. If that proves common, escalating on every disengage and letting the acknowledged-state check absorb the repeat is the alternative.

**Why nothing is decided at the point of detection.** Dispatching before suppression lets an observer see the three-second `npm test` that finished attended and would never have rung anyone. A seam firing only the events a human would have been shown could not serve `dor await` at all.

**Why the gate reads private detector state.** The detector runs for unwatched commands, and other tracks can mask it in the public projection; the gate needs the underlying evidence, not whichever state wins display precedence.

**Why command finishes bypass animation deferral.** A shell-reported exit is a lifecycle event; animation detection is only a recent-output heuristic. Letting the heuristic overrule the event would add latency and let unrelated background output defer a certain completion indefinitely.

**Why deferral has a ceiling.** Unbounded, it held an `OSC 9` behind any output that never went quiet for five seconds: a `watch -n1` pane redrawing once a second, or a dev server's heartbeat line every three seconds after its startup burst, deferred it indefinitely (audit probes, 2026-09-23). Thirty seconds is far past an agent's final spinner frames, which deferral exists to wait out, and short enough that a report behind a ticking clock still reaches its user. An escalated hold that deferred again restarted the ceiling: an `OSC 9` deferred at 0 s, held when it came due at 30 s, and escalated at 45 s while the pane still animated rang near 75 s (review, 2026-09-24).

**Why a deferred event is not dispatched again.** Claimants already had first refusal when the completion happened; re-offering it at quiet time would let a later-registered await consume history, and would report one completion twice.

## Await

**Why `quiet` includes exit and the bell.** No caller wants "wake me when it settles" and also wants to keep blocking after the thing died: without exit, a crashed peer hangs its caller until the timeout. The bell is in for the opposite reason — an explicit `OSC 9` / `BEL` is *stronger* evidence than inferred silence, so ignoring "I need input" while waiting for the peer to go quiet would be perverse.

**Why `exit` excludes the bell.** Plenty of build tools ring on a warning, and being the strict one is `exit`'s whole job.

**Why `--until` is never inferred.** The WATCHING rule set is a human notification preference — app-global, edited from a dialog. Binding a program's wake condition to it would let an unrelated human edit (removing a command from the watched set to quiet the bell) silently change what every `await` parked on that Session is waiting for.

**Why silence at a prompt is not a settle.** The BUSY-first precondition is what makes the `dor send` / `dor await` idiom safe: the await parks in the window before the peer's first byte instead of resolving on the quiet that was already there. The grace window answers the same question from the other side — silence alone cannot separate a peer that answered long ago from one working quietly — which is also why a running foreground command skips the window outright: a silent build resolves on its exit rather than being guessed at.

**Why `idle` is a `cause`, not a failure.** A caller that asked for quiet and found quiet got what it asked for. A distinct cause rather than a distinct failure lets a simple caller treat success as success, while a careful one can still tell "it settled" from "there was never anything there".

**Why a command-exit ring is gated on nothing running.** The ring latches past the run that raised it, so once another command has started it can only describe the previous one — exactly the misreport a `dor send` followed by `dor await --until exit` would act on.

**Why the `watching` source is gated on output since it joined.** The source legitimately describes a long-running watched command going quiet — what `--until quiet` exists for — but it is an inference from silence, and a brief burst does not clear it when the peer starts talking again; consuming it mid-turn would make the documented `await && read` idiom read a half-drawn screen. The detector cannot stand in for `outputSince` because it never latches: it reports how output looks *now*, its post-output `NOTHING_TO_SHOW` window (`busyCandidateGap`) is longer than the two CLI round trips between a `dor send` and the await behind it, and a burst too sparse to confirm BUSY returns it there, so it would still read as settled.

**Why an await never leaves a TODO.** TODO means a human owes this pane attention; after an await nobody does — a program asked to be told, was told, and acted. A stranded TODO also leaks: the last await of an orchestration would mark a fully handled event, and because TODO feeds the Workspace union, an orchestration awaiting across several panes would light the whole Workspace up. The answer once depended on a race: a report claimed by an await parked first left nothing, while the same report landing a moment before the await stranded its TODO (audit, 2026-09-23). A ring now sets no TODO, only a look does, so both orders agree. A TODO from an *unrelated* earlier event is a different debt and stays owed.

**Why nothing quieter is substituted for the absorbed ring.** A receipt the human must clear by hand is the same noise in a smaller font, and forensics after a failure come from the pane's own scrollback anyway.

**Why the claim window is left unacknowledged.** Closing the gap between a claim and the caller actually reading the outcome would need a two-phase claim on *every* completion, to cover a process that dies in the microseconds after its answer was computed.

**Why the timeout ceiling exists at all.** `timeoutMs` is a safety rail on a blocking call inside an agent loop, not an alert-tuning knob. Like the inactivity timeout it originates a process away and ends up in `setTimeout`, whose delay is a signed 32-bit millisecond count. Anything past ~24.9 days overflows and fires immediately, turning a long park into an instant `timeout`.

**Why an ended realm's awaits are cancelled, and answered synchronously.** A caller that can no longer be answered would otherwise go on absorbing completions the human would have been shown. Synchronously, because in VS Code the cancelled outcome would arrive a microtask after the router stopped posting and be dropped, leaving `dor` blocked on a reply that never comes. A standalone reload keeps its window label, so the window says `hello` rather than the host inferring a new realm from a label list that never changed.

## WATCHING Track

**Why candidate history expires on arrival rather than only on its timers.** The marked `dormouse.workspaces-2` alert (2026-09-09) followed 218 seconds of silence and two chunks 62 ms apart: unconfirmed candidate history outlived its timers, which run late in hidden views, and let that short burst confirm BUSY. Measuring the gap between accepted chunks keeps idle time from counting as sustained work.

**Why WATCHING keys on the command rather than the Session.** Turning alerts on while `claude` runs is a statement about `claude`, not about the pane that happened to be focused. A per-Session enable would have to be re-established by hand in every new pane, which is the opposite of what the gesture means.

**Why the alert state is retired before the PTY is killed.** A data chunk is enough to create a Session's entry, so killing first leaves output already in flight to rebuild an entry — and a `QuiesceDetector` that nothing will ever dispose. Raw output and resizes are exactly what a dying PTY emits; a semantic or protocol event may revive an id, because an id may be handed to a replacement pane and its first reported command start is evidence that somebody is home.

**Why the key is the last command of a list, past its wrappers.** The old key, argv[0] of the first simple command, named the set-up rather than the work: `cd web && pnpm dev` keyed on `cd`, `clear; claude` on `clear`, and `sudo make`, `time make`, `caffeinate -i claude` and `npx claude` on the wrapper, so a rule offered from those panes matched every other use of `cd` or `sudo` (audit, 2026-09-23). The last command of a list is the one still running when the line settles; a pipeline's first stage is the producer whose output the pane shows. An unknown wrapper flag keys the wrapper because guessing whether it swallowed the next word would key an argument as a program.

**Why reserved words and here-documents are grammar.** Command lines keep their newlines and bash reports a whole history entry, so a compound entry's last word was its closer: `for f in *; do make; done` keyed on `done`, `if x; then make; fi` on `fi`, and `python3 - <<'EOF' … EOF` on its delimiter, splitting the script's own `&&` and `;` on the way (review, 2026-09-23). A rule offered from those panes matched nothing anyone runs. The body a loop or conditional runs is what the entry waits on, as a list's last command is; a closer's trailing `< list` or `| tee log` belongs to the whole compound command, whose producer is that body. fish ≥ 4 reports its command line too, so `while true; pnpm test; end` keyed on `end` — a rule matching every fish block — and `pnpm build; and pnpm start` on `and` (review, 2026-09-24).

**Why a redirection is no word of the key.** `make > log` keyed `make >`, the operator read as a runner's script, and `make 2>&1`, its `&` kept whole, would have keyed `make 2>&1` (review, 2026-09-24).

**Why runners key by script.** `pnpm dev` never finishes and `pnpm test` does; one `pnpm` rule rang for both, so watching a dev server's pane also rang every test run. `run` is dropped because `npm run test` and `npm test` are one script under two spellings.

**Why a bare runner rule still covers every script.** Rules stored before script keys are bare runner names, and a user who watched `pnpm` asked for all of it; a new rule never loses ground an old one had.

**Why a mid-command enable shows the current state.** Starting a fresh detector when a rule is added would report `NOTHING_TO_SHOW` for a command that has been busy for ten minutes.

**Why the keystroke fallback is not routed into the manager.** The fallback in `docs/specs/terminal-state.md` is renderer-side and lower confidence than a shell-reported command boundary. Wiring it in would buy integration-less shells a worse version of WATCHING at the price of a second command-tracking path to keep in sync.

**Why resumed work withdraws an inferred WATCHING ring.** The marked `ttr.pgstencil-adopt` speech (2026-09-09 18:17:03) followed a WATCHING settle, resumed output, and confirmed BUSY before the speech deadline; the latched ring masked that activity, so the renderer spoke while the terminal was still animating. Withdrawing the ring lets the existing sink cancellation and fresh-ring delays follow the new busy/quiet cycle. Only the inference goes: explicit reports and command exits stay authoritative, and a redraw too brief to confirm BUSY never invalidates completion.

## Terminal reports

**Why progress is independent of the ring.** Progress and the report ring shared one field: an active `9;4` update while a report rang silently un-rang it, ending the episode and restarting speech and push, and a ring nulled the cycle, so the cycle's own end never rang. A cycle the program abandoned — a build killed with `Ctrl-C` — left the Session at `OSC_NOTIF_BUSY` forever, and the next program's defensive `9;4;0` then rang a phantom `Progress complete 40%` (audit, 2026-09-23). A command boundary is the one point where a cycle certainly belongs to a dead run.

**Why a progress event no longer drops a bell.** A mid-cycle update or a clear that ends no cycle summons nobody, so dropping the batch's lone `BEL` beside one lost the only ring (audit, 2026-09-23). Richness now decides detail for the batches that do both ring.

**Why the titles name the command.** The generic `Progress complete` said nothing about which run finished; the watch key is the name the user already knows the pane by, and the watch record is live exactly while a cycle can end.

**Why every Claude turn may ring.** Advertising iTerm2 3.6.6 turns on Claude Code's progress reports, one cycle per turn (the recorded turn, `a Claude Code turn` in `lib/src/lib/alert-engagement.test.ts`), so its turn end is a report completion, and reports are independent of WATCHING. Gating a cycle's end on a watched command was rejected: engagement is what spares the user who is watching, and a user who left wants the turn's end (product decision, 2026-09-23).

## Command-exit Track

**Why there is no minimum runtime.** The exit ring required 15 s of runtime, a stand-in for "the user probably watched anything quicker" from before engagement existed. Engagement answers that directly: a finish while engaged is held, and a finish after the user moved away was not watched. The stand-in only lost alarms — `sleep 15` and then selecting another pane rang, `sleep 10` and the same did not (product decision, 2026-09-24). The seen gate stays, so a command an agent or `dor send` runs in a pane the user never looked at stays silent.

## Clearing And TODO

**Why any keystroke clears TODO.** The rule was `Enter` only, and missed `Enter` sent as a win32-input-mode or kitty `CSI 13 u` sequence and a one-key answer such as `y`; it also read the renderer's copy of TODO before the attend it had just sent had come back, so a TODO that attend created survived the key (audit, 2026-09-23). Typing into the pane is dealing with it.

**Why TODO waits for acknowledgement.** Every ring set TODO as it opened (audit, 2026-09-23), so the pill sat beside an alarm nobody had seen yet, and ringing and TODO said the same thing twice. The model is two steps (product decision, 2026-09-24): the ring summons; a look without typing turns it into a TODO, "seen, still owed"; dealing with it clears that. Before the audit, WATCHING rings made TODO only when attended while report and exit rings made it at once, so every verb diverged by source; one rule for every source keeps them identical. A restart writes an unacknowledged ring as the TODO a look would leave, so an unseen alarm is not lost. With no TODO of its own to take back, a withdrawal needs no record of what the ring found.

**Why detail goes by richness.** The last writer used to win, with one special case keeping a report's text over an exit: an `OSC 9` reading `Build finished: 3 warnings` followed by a bell in the next PTY read showed `Terminal bell`, and `make; printf '\a'` showed `Terminal bell` over `make exited 2` (audit, 2026-09-23). One order covers every pair; equal ranks still take the newer text. A notification deferred behind animation used to be replaced by whatever came next, so the same bell in the next read replaced the message it followed; the deferral now keeps the richer of the two.

**Why an acknowledged state is not summoned again.** Claude Code sends an idle notification about a minute after a turn ends unless it saw input (captured from Claude Code 2.1, 2026-09-23). A user who acknowledged the WATCHING ring with a click, `a`, or a Door was summoned a second time, in a second episode, for the same completion. Output since the acknowledgement is the evidence that something new happened; settles and command exits are fresh by construction, so only reports are held to it. A command start is evidence too: a new command's echo falls in the echo window, so one silent until its report produced no output, and its report only updated TODO (2026-09-23).

## Alarm settings

**Why animation deferral defaults on.** Coding agents (`claude`, `codex`) send their notification OSC while their TUI is still redrawing its spinner, so an undeferred ring summons the user to a pane that is still animating (2026-09). The gate engages only while the private detector is fully armed, so a BEL from an otherwise quiet shell still rings at once. The deferral ceiling bounds the wait (Completion events); turning the switch off restores the protocols' literal timing. Installs that saved any settings blob keep the old value: the blob has no version field, and a persisted `false` cannot be told from a deliberate opt-out, so dropping it on read would leave the off position unpersistable.

**Why the settings ride the WATCHING rule set's seed/broadcast shape.** Each VS Code webview has its own origin and therefore its own `localStorage`, while the `AlertManager` is shared; without a host-authoritative copy, two webviews would each believe their own blob. The one difference is the whole-blob relay: an alarm setting is not a set of independent keys the way a rule list is.

**Why the host schedules delivery.** Each renderer used to run its own watcher over its activity mirror, and every realm boundary cost an alarm (audit, 2026-09-23). A recreated VS Code webview saw a latched ring go quiet-then-ringing and fired it at once, while one still inside its delay was first-observed in the new realm, seeded consumed, and never delivered; a disposed view whose PTYs lived on delivered nothing; standalone's WKWebView throttles or suspends timers when hidden; and a Workspace transfer had to carry, pause and resume receipts, and drop a refused arrival's Activity copy before releasing that pause. The host sees every episode from its start and outlives every renderer, so first-observation seeding and receipt transfer went away.

**Why a push goes from the host, and only speech from a realm.** A push is the walked-away channel, yet performing it in the renderer made it depend on the realm the user had walked away from — suspended when hidden, or disposed, when a VS Code view fell back to titling the push by its command line (2026-09-23). Only `window.speechSynthesis` needs a renderer; a push needs only the Pane label, which the realm publishes ahead of time.

**Why a publication never drops a Session with state.** Dropping an entry rechecked it against the defaults, consuming a sink only its override enabled, and enabling never replays an episode, so the realm's next, whole publication could not re-arm it. A reload, or a window mounting its Walls one at a time, publishes a partial set first (review, 2026-09-23). A Session with no state has no episode to consume; forgetting it keeps the host's copy bounded by what realms show, browser Surfaces included, which the manager never removes.

**Why labels wait on a throttle and overrides do not.** Claude Code animates its terminal title about ten times a second (2026-09), and each frame changes the label: publishing every one would cross into the host ten times a second per Session for a value read only when a push comes due. An override change goes at once because disabling a sink must consume its pending push before it fires.

**Why presence gates delivery.** The watcher rechecked only the episode and the setting, so a push went out while the user typed in the next pane, and speech named the pane they were reading (audit, 2026-09-23). Speech is heard in the room, so it only has to spare the pane being looked at; a push reaches a phone, so it waits until the user has left every viewer.

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

**Why the device-list fetch is lazy and its store is not.** The fetch is Burrow machinery and rides the lazily-imported `RemotePairingModalHost` chunk; the store and its refresh fence stay in the common bundle because the Settings dialog reads them in every host, so disarming is one call on the store.

**Why `toPushText` is not `toSpokenText`.** The angle-bracket rule exists only because WebKit's synthesizer wedges on them (Spoken alarms); an OS notification has no such failure, and instead has bidi and zero-width formatting that can visually reorder or hide text.

**Why the Burrow, not the Relay, chooses recipients.** A revoked Client keeps its subscription row on the Relay, nothing propagating a revocation today (`docs/specs/remote-security-model.md` → Future), so a Relay picking recipients from its own rows would keep pushing Pane labels to a de-authorized phone.

**Why the Burrow does not ask which devices are subscribed first.** The Relay intersects the Burrow's targets with its own subscriptions regardless, so the target set is identical either way; asking first would cost the alarm a second round trip.

## Settings dialog

**Why the device line always says something.** A push that silently goes nowhere is indistinguishable from a broken one, so each cause is worth its own message rather than an empty list.

## Pane Header

**Why a helper tracks its command before promotion.** A helper dropped every semantic event, so one promoted while running `claude` had no command watch until its next command: no WATCHING, and no command-exit arm (audit, 2026-09-23). Command state alerts no one by itself; only dispatch and publishing have to wait for promotion.

**Why `SPEAKING` may pulse unbounded and `SPOKEN` may not.** An utterance is seconds long and stops on its own, so the pulse it carries is self-bounding. `SPOKEN` persists until the ring clears, so animating it would be exactly the per-Session animation with no end that bounding the burst exists to remove.

**Why `cfg.alert.ringingPaused` suppresses the pulse.** It is the visual-snapshot freeze that pins the alarm; even a bounded animation could otherwise snapshot at an arbitrary phase during its first 2.6 seconds.

**Why the unlabelled treatment pulses once per episode.** An infinite per-Session animation is expensive, and the whole-Pane treatment covers far more surface than the retired bell icon did. With four focused panes wearing an infinite animation, three minutes cost 6.89 MB of embedder memory, 1,127 style recalculations, and 3.99 seconds of renderer CPU; pausing only those animations in the same loaded document reduced that to 0.13 MB, two recalculations, and 0.025 seconds. After bounding the burst, two consecutive three-minute windows each had zero live animations, one recalculation, under 0.40 MB of non-cumulative embedder drift, and at most 0.024 seconds of renderer CPU (measured in Chrome 150, 2026-09). A handful of cycles preserves the entry cue without leaving an animation running for the lifetime of an unattended alert. The episode — not a ring source — is the key because the episode is the summons the sinks already work from: a second source joining the ring enriches an alarm the user was already shown, and re-flashing the whole Pane for it would read as a new alarm. Running the burst off `episode.startedAt` rather than from mount makes the CSS clock a property of the episode, so minimize → reattach or a Workspace switch lands past an expired burst instead of replaying it. A Session BEL-ing in a loop still cannot restart the burst, because a source joining an active ring does not open a new one.

## Text And Security

**Why the cold-restore path is not re-sanitized.** Reaching it requires a corrupted or hand-edited session store, and the text is rendered as plain text everywhere, so the residual exposure is layout — a very long or control-bearing string in a preview — rather than markup.

## Live Workspace transfer

Nothing moves because the manager and the delivery scheduler left the standalone windows for the host process (`docs/specs/standalone.rationale.md` → Alerts; Alarm settings).

## Workspace union

A Workspace-level counter was tried first and dropped: the maximum child counter hides a new alert from a child with a smaller counter, and summing counters turns adding or removing a member into a notification. The earliest ringing member's episode replaces it because a hidden tab shows one alarm however many members are behind it, and because switching Workspaces re-derives the union from scratch — an `episode.startedAt` survives that, while a locally tracked generation had to be retained alongside it (2026-09).

"Only that interval" is load-bearing because the tab's memory of a ring is a cache. The retired `WorkspaceRingCues` observed the active Workspace too, so a ring that started and ended while its tab was visible could not leave anything behind; the union cache that replaced it at first skipped the visible Workspace, and its stale `ringingSince` was carried forward into the next ring, whose `animationDelay` was then already past the burst's end — the tab wore a static edge for a summons that should have flashed (2026-09). The visible tab now projects its union for the TODO pill, but "only while hidden" keeps it carrying no `ringingSince`: it shows no summons, so a ring attended in view must not anchor the burst it shows once left (2026-09).

**Why the visible tab shows its TODO pill.** It used to carry none, on the reasoning that its panes and Doors already say it. The pill then appeared and disappeared as the Workspace was selected, and nothing else in Dormouse changes with selection that way (product decision, 2026-09). The alarm inset stayed hidden-only: it is a summons to a Workspace the user cannot see.

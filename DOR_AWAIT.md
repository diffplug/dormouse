# `dor await` — working spec

> **Status: design.** Nothing here is implemented.
>
> This file is a staging document for the `dor-await` branch. On landing it
> dissolves into `docs/specs/dor-cli.md` (command surface) and
> `docs/specs/alert.md` (Activity-layer semantics) — see [Dissolution](#dissolution).
> It uses the Session / Pane / Surface vocabulary from `docs/specs/glossary.md`.

## Purpose

`dor await <surface> --until <signal>` blocks until a Surface finishes what it
was doing, reports why it stopped, and exits. It turns the alert system into an
agent synchronization primitive: an agent launches a peer with
`dor split -- claude`, sends it work, and parks on `dor await` instead of polling
`dor list` in a loop. Reading the result is `dor read`'s job — see
[D4](#d4-await-does-not-print-the-screen-settled).

**The caller is a program, not a human.** That single fact drives every decision
below. A human has a bell, a Pane header, and peripheral vision; a program has
one blocking call and whatever that call returns. Where the two want different
things, `dor await` serves the program and leaves the human's channels alone.

## Requirements

| | Requirement |
|---|---|
| **R1** | **Await always works.** On any live terminal Surface it parks and eventually resolves, or fails with a stated reason. It never refuses because the Surface is "in the wrong state", and never blocks forever. |
| **R2** | **The caller states the wake condition.** `--until` is required. Nothing global — least of all the user's watched-commands set — is consulted; see [D1](#d1-the-caller-states-intent-settled). |
| **R3** | **One new number.** Every window below derives from the battle-tested `cfg.alert` constants. The sole addition is `--timeout`, and it exists for a different reason than the rest; see [Timing](#timing). |
| **R4** | **The await absorbs the alert.** A completion a waiting `dor await` consumes must not ring the bell, speak an alarm, or push to a phone. The program is already handling it; summoning the human too is noise. |

## Model

### The signals

`--until` names how much evidence of completion the caller will accept. The two
values form a permissiveness ladder rather than orthogonal modes.

| `--until` | Resolves on | Use for |
|---|---|---|
| `quiet` | The Session **settled**, **or** the foreground command exited, **or** the Surface emitted an explicit bell. | Agents that never exit — `claude`, `codex`. |
| `exit` | The foreground command exited. Nothing else. | Builds, test runs, migrations. |

Rationale for each edge of that table:

- **`quiet` includes exit** because there is no caller who wants "wake me when it
  settles" and also wants to keep blocking after the thing died. Without this,
  a peer that crashes hangs the caller until `--timeout`.
- **`quiet` includes bell** because an explicit `OSC 9` / `BEL` is strictly
  stronger evidence than inferred silence. Ignoring the peer explicitly saying
  "I need input" while waiting for it to go quiet would be perverse.
- **`exit` excludes bell** deliberately. Plenty of build tools `BEL` on a
  warning; `exit`'s entire job is being the strict one, so a mid-run bell must
  not wake it.

Settling is detected by the existing output/silence machine (`ActivityMonitor`),
which has two properties `await` depends on:

- **It must go busy before it can go quiet.** A Surface at a prompt is silent,
  but silent is not settled. `enterBusy` is the only thing that arms the settle
  timers, so a Session that never sustained output can never fire a settle. This
  is what stops `dor send … && dor await --until quiet` from racing on the
  silence that precedes the peer's first byte.
- **It needs no shell integration.** On `fish`, `cmd.exe`, or any shell where
  injection did not take, settling is the only signal that still works — it is
  pure output timing. `exit` is unavailable there.

### Is there anything to wait for?

The one case `--until quiet` cannot infer from output alone is an empty
Session — a peer that already delivered its final response and is sitting idle.
Silence there means "done long ago", not "working quietly". Shell integration
answers it directly:

| At await time | Behavior |
|---|---|
| A foreground command is running | There is something to wait for. Park. Resolves on settle or exit, whichever comes first. A command that never animates — a silent build — therefore resolves correctly on its exit rather than being guessed at. |
| No foreground command | Park for one **grace window**. Under `--until quiet` the test is *output*; under `--until exit` it is a *command start*. Whichever arrives → carry on and wait for the real signal. Neither → resolve `cause: idle`. |
| No shell integration | "Is a command running" is unanswerable, so fall back to the grace window on output alone. Same degradation as every other integration-dependent feature. |

`cause: idle` **exits 0**: a caller that asked for quiet and found quiet got
what it asked for. It is a distinct `cause` rather than a distinct exit code so
that simple callers can treat 0 as 0, while a careful caller — or a human
debugging at 2am — can still tell "it settled" from "there was never anything
there, and you may have wanted `--until exit`".

### Resolution

On resolution `await` prints its `cause` and exits 0. It prints no terminal
text; the caller composes `dor read` when it wants the screen.

Resolution consumes the ring it resolved on and **touches nothing else**: no
TODO is set, no existing TODO is cleared, and `attentionSessionId` is not set — a
program waiting on a peer is not a human looking at it.

Setting a TODO was considered and rejected. TODO means *a human owes this pane
attention*, and after a successful await no human owes anything: a program asked
to be told, was told, and acted. It would also leak. The caller only clears a
TODO if it happens to send a follow-up, so the last await of every orchestration
strands a marker for an event that was fully handled, which the human then clears
by hand — worse than never setting it. And because TODO propagates into the
Workspace union status, an orchestration awaiting across several panes lights up
the whole Workspace as needing attention, degrading exactly the at-a-glance
signal R4 sets out to protect.

Not clearing a *pre-existing* TODO matters for the same reason in reverse: one
left by an unrelated earlier event is still owed to the human, and an await
resolving on a different signal has no business wiping it.

### Absorption

R4, stated precisely: **absorb the summons, keep the receipt.**

- **Absorbed:** the bell ring, the spoken alarm, the phone push. These are all
  ways of summoning a human who is not needed, because a program is already on it.
- **Not substituted:** no TODO, and no quieter marker standing in for the ring.
  A receipt the human has to clear by hand is the same noise in a smaller font.
  Forensics after a failure come from the pane's own scrollback and `dor list`,
  which cost the human nothing.
- **A failed await absorbs nothing.** If the await times out, its socket drops,
  or the caller dies, the completion must ring normally. Otherwise a crashed
  orchestration silently eats the one signal that would have told the human the
  build finished. Absorption is conditional on the await actually delivering its
  result to its caller.
- **Absorption is per-signal, not per-Session.** An await consumes the signal it
  resolved on. If the human independently holds a watched-commands rule on that
  Session, the *next* settle rings for them as usual.

Mechanically this needs the alert system to expose a completion event *before*
attention suppression and *before* the ring latches, so a waiter can claim it.
That seam does not exist today; see [G1](#g1-no-pre-suppression-completion-event)
and [G3](#g3-absorption-has-no-claim-concept).

## Timing

Every window is derived from `cfg.alert`, so `await` inherits the tuning the
bell has already had in the field and adds no second set of numbers to keep in
sync.

| Window | Value | Source |
|---|---|---|
| Grace — "did anything start?" | 2000ms | `busyCandidateGap` (1500) + `busyConfirmGap` (500) — the detector's actual floor for reaching BUSY. A shorter window would time out before the machine it is watching could possibly have reported. |
| Settle — "has it stopped?" | 5000ms | `mightNeedAttention` (2000) + `needsAttentionConfirm` (3000). |
| Ceiling | `--timeout`, default 600s | **The one new number.** |

`--timeout` is not an alert-tuning knob and is not derived from `cfg.alert`: it
is the safety rail on a blocking RPC inside an agent loop. Without a ceiling a
wedged peer hangs its caller forever. It is enforced **host-side**, so no
intermediate hop can reap a parked await early and no caller can park forever by
lying about its own deadline.

**Accepted risk:** the 5000ms settle assumes an agent animates continuously
across a whole turn. A turn is not only token generation — if a peer shells out
to a 20s test run and its indicator goes quiet during it, `--until quiet`
resolves mid-turn. A per-call settle override would fix it and was deliberately
not added; if this bites in practice, adding one is purely additive.

## Command surface

```
dor await <surface> --until <quiet|exit> [--timeout <seconds>] [--json]
```

- `--until` is **required**. See [D1](#d1-the-caller-states-intent-settled).
- No `--lines` / `--scrollback`: `await` never prints terminal text, so it
  carries none of `dor read`'s output flags. See
  [D4](#d4-await-does-not-print-the-screen-settled).
- Targets terminal Surfaces only. A browser Surface has no Session and can never
  complete; `dor await surface:browser` fails immediately with that reason rather
  than blocking (R1 means "fails with a stated reason", not "blocks politely").
- In-flight awaits are visible: `dor list` tags the Surface `[awaited]`.
- Ships with snapshot-tested help, like every `dor` command.

Exit codes — `dor` today uses only 0 and 1, so this widening is a proposal:

| Code | Meaning |
|---|---|
| 0 | Resolved. `cause` is one of `quiet` · `exit` · `bell` · `idle`. |
| 1 | Usage or target error (unknown Surface, browser Surface, bad or missing `--until`). |
| 2 | Timed out. |
| 3 | The Surface died before completing — its PTY exited, so the thing being waited on is gone rather than late. Distinct from 2 so a caller can tell "it is still out there and slow" from "it will never answer". |

### Output and errors

`await` writes to both channels on success, splitting the machine contract from
the human one. **stdout is the bare `cause` and nothing else**, so
`CAUSE=$(dor await surface:5 --until quiet)` stays the whole idiom. **stderr
carries a one-line narrative** naming the cause and how long the wait took:

```
$ dor await surface:5 --until quiet
quiet                                        # stdout
quiet: output stopped after 10m 15s          # stderr
```

Writing diagnostics to stderr on a *successful* run is deliberate and
conventional (git does it constantly): stderr is the explain-what-happened
channel regardless of exit status, and it is already where this command's
failures go. Keeping it off stdout is what lets the cause stay machine-clean.

Representative narratives:

| Outcome | stderr |
|---|---|
| `quiet` | `quiet: output stopped after 10m 15s` |
| `exit` | `exit: command exited after 3m 02s` |
| `bell` | `bell: surface rang after 45s` |
| `idle` under `--until quiet` | `idle: no output within 2s, nothing was running` |
| `idle` under `--until exit` | `idle: no command started within 2s` |
| timeout (exit 2) | `Error: timed out after 600s waiting for surface:5 to go quiet` |
| death (exit 3) | `Error: surface:5 exited after 3m 20s` |

**Duration is the await's own wall time**, from invocation to resolution — the
only span the command actually knows. It is *not* a claim about how long the
peer worked, which would require knowing when the turn began. Note this means a
`quiet` can never report less than the settle window: a resolution at `5s` says
the Surface was silent for essentially the whole wait.

**Vocabulary:** the narratives say *output*, never *animation*. A silent build
has no animation but plenty of activity, and the detector watches PTY bytes, not
motion — same reason `--until quiet` is not `--until-animation-stops`.

`--json` carries both contracts plus the raw number:

```json
{ "workspace_ref": "workspace:1", "surface_id": "…", "surface_ref": "surface:5",
  "cause": "quiet", "waited_ms": 615000,
  "detail": "output stopped after 10m 15s" }
```

`detail` is redundant with `cause` + `waited_ms` on purpose: an agent relaying
the outcome to its own user gets a ready-made phrase instead of inventing one.

**Failure** follows `dor`'s existing convention
(`dor/src/commands/shared.ts`): an `Error: <message>` line on stderr, empty
stdout, non-zero exit — with the same duration folded in, since "timed out" and
"timed out after ten minutes" are different facts to a reader.

Because stdout carries only the cause and stderr only the narrative, a caller
distinguishes every outcome without parsing terminal text — the practical payoff
of the [D4](#d4-await-does-not-print-the-screen-settled) split.

### Help text

The user-facing contract, in the shape `dor/test/snapshots/help/*.md` records.
Prose is unwrapped because stricli owns the wrapping, and flag order/rendering
is stricli's to decide.

```text
USAGE
  dor await <surface> --until condition [--json] [--timeout seconds]
  dor await --help

Waits until a terminal surface finishes what it is doing, then reports why the wait ended. Lets an agent block on a peer it launched with `dor split` instead of polling `dor list` in a loop.

Prints no terminal text. Follow with `dor read` to see the screen.

--until says what counts as finished:
  quiet  The surface settled, the running command exited, or the surface rang the bell. Use for agents that keep running, such as claude or codex.
  exit   The running command exited, and nothing else. Use for builds and test runs, which can fall silent mid-run without being finished.

Waiting absorbs the alert. A surface that finishes while awaited does not ring the bell, speak an alarm, or notify a paired phone, and is not marked TODO — the wait already delivered the news.

Text mode prints the cause alone on stdout: quiet, exit, bell, or idle. An idle result means nothing was running and nothing started, so there was never anything to wait for.

A one-line summary naming the cause and how long the wait took goes to stderr, so it stays out of the captured value: `quiet: output stopped after 10m 15s`. The duration is how long this command blocked, not how long the surface had been working.

JSON output:
  {
    "workspace_ref": "workspace:1",
    "surface_id": "...",
    "surface_ref": "surface:3",
    "cause": "quiet",
    "waited_ms": 615000,
    "detail": "output stopped after 10m 15s"
  }

Exits 0 on any resolution, 2 on timeout, and 3 if the surface died before finishing.

Examples:
  dor await surface:3 --until quiet
  dor await surface:3 --until quiet && dor read surface:3
  dor await surface:3 --until exit --timeout 1800
  CAUSE=$(dor await surface:3 --until quiet)

FLAGS
     [--json]     Print JSON output.
     [--timeout]  Seconds to wait before giving up. Default 600.
      --until     What to wait for: quiet or exit.
  -h  --help      Print help information and exit
      --          All subsequent inputs should be interpreted as arguments

ARGUMENTS
  surface  Surface to wait on.
```

## Behavior

| Situation | Outcome |
|---|---|
| Surface is already ringing when `await` is called | Resolves immediately, `cause: bell` (under `--until quiet`). |
| `--until quiet`, agent is mid-turn and animating | Detector is already BUSY. Parks, resolves on the settle. |
| `--until quiet`, agent already delivered its final response | No command running, no output within the grace window → `cause: idle`, exit 0. |
| `--until quiet`, silent build running | A command *is* running, so the grace window does not apply. Parks, resolves `cause: exit` when it exits. |
| `--until exit`, command hangs on an interactive prompt | Blocks to `--timeout`, exit 2. `--until quiet` is the answer for callers who want to be woken when a build stalls. |
| Peer emits `OSC 9` "needs input" | `--until quiet` resolves `cause: bell`. The await claims an explicitly human-directed request on the human's behalf, on the grounds that the caller is the one positioned to answer it. `--until exit` ignores it. |
| PTY exits / Surface killed | Exits 3. A command-exit ring, if armed, fires just before the PTY event, so a peer that rings on completion still resolves normally first. |
| `--timeout` expires | Exits 2. Absorbs nothing. |
| `dor` client disconnects | The host cancels the parked request and disarms whatever it armed. Absorbs nothing. |
| Several awaits on one Surface | Each resolves on the first qualifying signal after it started. All are tagged `[awaited]`. |
| `--until exit` on a shell without integration | There are no command boundaries to observe. Stated error, not a silent hang. |

## Decisions

### D1: the caller states intent — settled

`--until` is required, and the watched-commands set is never consulted.

The rejected alternative was inferring the wake condition from that set: a
watched command (`claude`) waits for quiet, anything else waits for exit. It was
rejected because the watched set is a *human notification preference* — app-global,
persisted in a webview's `localStorage`, edited from a dialog — and binding it to
a program's control flow means removing `claude` from the set to quiet the bell
silently flips every `dor await` on a claude pane from "wait until it settles" to
"wait until the process exits", which for an agent that never exits is a hang
with no error and nothing in the output to explain it. It is also the process
heuristic `alert.md`'s first non-goal forbids, one level removed: the caller of
`dor await` inherits a declaration it never made.

A union default (`await` resolves on any signal, `--until` narrows) was also
rejected: an early resolve *consumes* the wait, so a caller that does not loop
proceeds on a half-finished screen and the true completion is never observed.
Requiring the caller to state intent costs one flag and removes both failure
modes.

### D2: flag shape — settled

`--until <signal>` over `--until-exit` / `--until-animation-stops`. One flag with
a value beats N booleans that can contradict each other, and the values reuse the
`cause` vocabulary — the flag you pass and the field you read back are the same
word. "Animation" is UI vocabulary (the bell's tilt); the thing being detected is
output going quiet, so `quiet` names it directly.

Single-valued, not a list: `quiet` already subsumes `exit`, so the only
combination a list could express is the one that is already the default of the
permissive value.

### D3: absorption scope — open

Settled: absorb the summons and leave no substitute marker (see Resolution); a
failed await absorbs nothing. Still open:

- Should `--no-absorb` exist, for a caller that wants to observe without
  claiming? Probably yes eventually; not in the first cut.
- Push is the one channel where absorption is arguable, since push exists to
  reach a user who *walked away* and a long orchestration is exactly when they
  have. The answer is that absorption is safe precisely because a failed or
  timed-out await un-absorbs — the human still gets the phone buzz when the
  orchestration actually stalls.

### D4: `await` does not print the screen — settled

`await` reports only why the wait ended. The caller composes:

```
dor await surface:5 --until quiet && dor read surface:5
```

The rejected alternative bundled `dor read`'s output shape into `await`, which is
more ergonomic for the common case ("wait, then see what it said") and captures
the screen at the exact moment of resolution. It lost on three counts:

- **Mirroring cost compounds.** Bundling obliges `await` to carry `--lines`,
  `--scrollback`, `--json`, and every output flag `dor read` grows afterwards
  (`docs/specs/dor-cli.md` → Future already stages more), as a second
  implementation with a second help snapshot and a standing chance to drift.
- **It makes `cause` free.** With no terminal text on stdout, the cause *is*
  stdout — no header line to design, no format that has to survive being mixed
  with arbitrary screen content, and text mode gets the cause without `--json`.
- **Not every caller wants the screen.** An orchestrator awaiting several peers
  in sequence often needs only the fact of completion, and would otherwise
  receive and discard a screenful of terminal each time.

The cost accepted: the screen can move between `await` returning and `read`
landing. Under `--until quiet` the peer is settled by definition, so this is
near-theoretical; under `--until exit` a prompt redraw may scroll a line.

## Implementation gaps

What `main`'s alert model cannot express today, measured against the design
above. Two gaps are structural; the rest is plumbing. **This section is
scaffolding — it is deleted on landing, not promoted into a spec.**

### G1: no pre-suppression completion event

**The keystone gap.** Every completion path bakes attention suppression in at the
decision point and emits nothing beforehand, so a waiter has nothing to subscribe
to:

- **Quiesce** — `createMonitor`'s `onChange` in `lib/src/lib/alert-manager.ts`:
  on attention it calls `entry.monitor?.attend()` and returns. A silent reset; a
  waiting await never learns the Session settled.
- **Command exit** — `finishCommandExitWatch` in the same file has two silent
  returns: one for `this.hasAttention(id)`, and one for
  `Date.now() - watch.startedAt < this.inactivityTimeoutMs`.

The second is the sharp edge: **a command that ran for less than the inactivity
timeout produces no event at all**, so `--until exit` on a three-second
`npm test` could never resolve. The most ordinary case in this design is the one
the current model cannot express.

The fix is not exposing the ring earlier. The event must sit **upstream of both
the suppression checks and the qualification rules** — firing on every settle,
every command finish, and every protocol notification, whether or not a ring
follows. All existing ring logic stays downstream and unchanged.

### G2: the quiesce detector is welded to the watched-commands set

`applyWatchingRule` is the only path to a monitor:

```ts
return this.setWatching(id, entry, argv0 !== null && this.watchedCommands.has(argv0));
```

No watched command, no detector — so `--until quiet` on an unwatched Session can
never fire, and the only workaround is adding the command to the watched set,
which is precisely the coupling [D1](#d1-the-caller-states-intent-settled)
rejects.

Needs `armQuiesceWatch(id, { ownerId })` / `disarmQuiesceWatch(id, ownerId)` with
an owner set, and the monitor living while *either* the watched rule matches or
the owner set is nonempty. `setWatching`'s `if (enabled === !!entry.monitor)
return false` guard has to become a refcount: with two independent owners,
"should exist" and "does exist" stop being the same question.

This gap is independent of G1 and can land first. It also retires `main`'s
awkward "WATCHING outranks `COMMAND_EXIT_ARMED`" projection rule, since the
detector stops being synonymous with the watched set.

### G3: absorption has no claim concept

`lib/src/lib/alert-ring-watch.ts` — the shared trigger behind both spoken alarms
and push — detects rings by diffing statuses out of the activity store. By the
time it observes `ALERT_RINGING`, the ring has already latched.

Partial good news: speech and push both re-check at fire time, so an await that
clears the ring within `speakDelayMs` / `pushDelayMs` cancels them almost for
free. **The bell is the problem** — it latches instantly with no delay, so the
human sees a flash of exactly the summons absorption exists to prevent.

True absorption means the ring never latches, which means claiming at the G1
event. And [Absorption](#absorption)'s "a failed await absorbs nothing" makes the
claim two-phase: **claim → deliver**, or **claim → release** and let it ring
normally. The release path is what keeps a crashed orchestration from eating the
signal.

### G4: no adapter surface for any of it

`PlatformAdapter` (`lib/src/lib/platform/types.ts`) carries `alertRemove` /
`alertDismiss` / `alertAttend` / `alertMarkTodo` and friends, but nothing for
arming a watch or subscribing to completions.

In VS Code the `AlertManager` lives in the extension host while the `dor` control
handler lives in the webview, so this crosses the process boundary: new entries
in `vscode-ext/src/message-types.ts`, new router cases in
`vscode-ext/src/message-router.ts`, and the corresponding methods on all three
adapters.

### G5: no long-lived control requests

| Layer | Today | Needed |
|---|---|---|
| `standalone/sidecar/dor-control-server.js` | `timeoutMs = 65000`, global | Per-request deadline carried on the wire |
| `dor/src/control-client.ts` | `options.timeoutMs ?? 5000` | Deadline matching `--timeout` |
| Socket close | Reaps the server's pending entry | Must also notify the webview |

A `--timeout 600` await blows through both fixed ceilings. Worse, the existing
socket-close handler releases the server's own bookkeeping but tells the webview
nothing, so a disconnected client would leak the await's subscription **and its
armed quiesce watch** for the life of the session.

Two server implementations need the change: `standalone/sidecar/dor-control-server.js`
and `vscode-ext/src/pty-host.js`.

### G6: grace-window inputs

`--until quiet` needs "is a command running?" and `--until exit` needs "did one
start?". `entry.commandExitWatch` answers both but is private to the
`AlertManager`.

Cheaper path: the webview's terminal-state store already carries
`activity: { kind: 'running' }` (`lib/src/lib/terminal-state.ts`), so both
questions are answerable renderer-side without touching the alert model at all.

### G7: PTY exit

Exit code 3 needs the awaited Surface's PTY exit. Adapters already surface it to
the renderer per `docs/specs/transport.md`; this is wiring, not a new capability.

### G8: command surface plumbing

- `await` added to `SURFACE_CONTROL_METHODS` in `dor/src/protocol.ts`, with
  request/response types in `dor/src/commands/types.ts`.
- A handler branch in `lib/src/components/wall/use-dor-control.ts`, which also
  owns the in-flight map and the elapsed-time measurement.
- `awaited` added beside `ringing` / `todo` on `Surface` in
  `dor/src/commands/types.ts`, for the `dor list` tag.
- Snapshot-tested help, like every `dor` command.

### Dependency order

G1 unblocks G3, and both are prerequisites for the `--until quiet` and `--until
exit` resolution paths. G2 is self-contained and is the natural first landing.
G4 and G5 are the transport prerequisites and can proceed in parallel with G1.
G6 through G8 are leaves.

## Dissolution

On landing, this file is deleted and its contents move:

| Section | Destination |
|---|---|
| Purpose, Command surface, Output and errors, Behavior, Timing, exit codes | `docs/specs/dor-cli.md` — promote the staged `dor await` bullet out of `## Future` into the implemented command list. |
| The signals, Is there anything to wait for, Resolution, Absorption | `docs/specs/alert.md` — a new Await section, plus whatever seam the absorption rule requires in the Public State / Clearing And TODO sections. |
| Decisions | Deleted. The settled parts land as prose in the destination specs; the rejected alternatives stay in this branch's git history. |
| Implementation gaps | Deleted. It describes a `main` that will no longer exist once the work lands. |
| `[awaited]` tag | `docs/specs/dor-cli.md`, `dor list` output. |

Per `AGENTS.md`, promotion is not done until the text reads as present tense with
`Source of truth:` pointers, and nothing implemented remains below a `## Future`
fold.

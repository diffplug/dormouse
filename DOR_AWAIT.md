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
| No foreground command | Park for one **grace window** waiting for output. Output arrives → wait for the settle. No output → resolve `cause: idle`. |
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
That seam does not exist on `main` today — it is the main gap, and the subject of
the next pass.

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

**Success** prints the bare `cause` on stdout and nothing else, so
`CAUSE=$(dor await surface:5 --until quiet)` is the whole idiom:

```
$ dor await surface:5 --until quiet
quiet
```

`--json` gives the same fact in `dor`'s object shape:

```json
{ "workspace_ref": "workspace:1", "surface_id": "…", "surface_ref": "surface:5",
  "cause": "quiet" }
```

**Failure** follows `dor`'s existing convention
(`dor/src/commands/shared.ts`): an `Error: <message>` line on **stderr**, empty
stdout, non-zero exit. Because stdout carries only the cause and stderr only
errors, a caller distinguishes every outcome without parsing terminal text —
which is the practical payoff of the split.

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

Text mode prints the cause alone: quiet, exit, bell, or idle. An idle result means nothing was running and nothing started, so there was never anything to wait for.

JSON output:
  {
    "workspace_ref": "workspace:1",
    "surface_id": "...",
    "surface_ref": "surface:3",
    "cause": "quiet"
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

## Dissolution

On landing, this file is deleted and its contents move:

| Section | Destination |
|---|---|
| Purpose, Command surface, Output and errors, Behavior, Timing, exit codes | `docs/specs/dor-cli.md` — promote the staged `dor await` bullet out of `## Future` into the implemented command list. |
| The signals, Is there anything to wait for, Resolution, Absorption | `docs/specs/alert.md` — a new Await section, plus whatever seam the absorption rule requires in the Public State / Clearing And TODO sections. |
| Decisions | Deleted. The settled parts land as prose in the destination specs; the rejected alternatives stay in this branch's git history. |
| `[awaited]` tag | `docs/specs/dor-cli.md`, `dor list` output. |

Per `AGENTS.md`, promotion is not done until the text reads as present tense with
`Source of truth:` pointers, and nothing implemented remains below a `## Future`
fold.

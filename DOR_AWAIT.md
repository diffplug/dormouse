# `dor await` — working spec

> **Status: design.** Nothing here is implemented.
>
> This file is a staging document for the `dor-await` branch. On landing it
> dissolves into `docs/specs/dor-cli.md` (command surface) and
> `docs/specs/alert.md` (Activity-layer semantics) — see [Dissolution](#dissolution).
> It uses the Session / Pane / Surface vocabulary from `docs/specs/glossary.md`.

## Purpose

`dor await <surface>` blocks until a Surface finishes what it was doing, prints
its screen, and exits. It turns the alert system into an agent synchronization
primitive: an agent launches a peer with `dor split -- claude`, sends it work,
and parks on `dor await` instead of polling `dor list` in a loop.

**The caller is a program, not a human.** That single fact drives every decision
below. A human has a bell, a Pane header, and peripheral vision; a program has
one blocking call and whatever that call returns. Where the two want different
things, `dor await` serves the program and leaves the human's channels alone.

## Requirements

| | Requirement |
|---|---|
| **R1** | **Await always works.** On any live terminal Surface it parks and eventually resolves, or fails with a stated reason. It never refuses because the Surface is "in the wrong state", and never blocks forever. |
| **R2** | **It resolves on the right signal for what is running.** A command that never exits (`claude`) must resolve when it settles. A build must resolve when it exits. |
| **R3** | **A flag may select the wake condition.** Whether it is required, and what it is called, is [D2](#d2-flag-shape). |
| **R4** | **The await absorbs the alert.** A completion a waiting `dor await` consumes must not ring the bell, speak an alarm, or push to a phone. The program is already handling it; summoning the human too is noise. |

## Model

### Completion signals

Three kinds of thing can mean "done". They already exist in `docs/specs/alert.md`
as the three alert tracks; `await` consumes them as one stream.

| `cause` | Source | Available when |
|---|---|---|
| `bell` | An explicit terminal report: `BEL`, `OSC 9`, `OSC 777`, `OSC 99`, or an `OSC 9;4` completion/error. | Always. Pure output parsing. |
| `exit` | The foreground command finished, or the PTY exited. | Only with shell integration (`OSC 133` / `OSC 633`). |
| `quiet` | The output/silence detector confirmed the Session settled: it became busy, then stayed silent for the settle window. | Always. Pure output timing. |

Two properties of `quiet` are load-bearing rather than incidental:

- **It must go busy before it can go quiet.** A Surface sitting at a prompt is
  silent, but silent is not settled. Without the two-stage detector,
  `dor send … && dor await` races: the await would resolve on the quiet that
  precedes the peer's first byte of output. This is the difference between a
  usable primitive and one that returns wrong answers intermittently.
- **It needs no shell integration.** On `fish`, `cmd.exe`, or any shell where
  injection did not take, `quiet` is the only signal that still works. This is
  why `await` degrades rather than errors there (R1).

### Resolution

On resolution `await` prints the Surface's screen and the `cause`, then exits 0.

Resolution performs **the attending semantics without the attention**: it clears
any active ring and sets `todo = true`, but does not set `attentionSessionId` — a
program waiting on a peer is not a human looking at it. The Surface is left
carrying a TODO that the caller owns and clears with a follow-up
`dor send … --key enter`, which `docs/specs/alert.md` already defines as
human-equivalent input.

### Absorption

R4, stated precisely: **absorb the summons, keep the receipt.**

- **Absorbed:** the bell ring, the spoken alarm, the phone push. These are all
  ways of summoning a human who is not needed, because a program is already on it.
- **Kept:** the TODO. The Pane keeps a quiet marker saying "something completed
  here and a program took it". Absorption with no trace is a debugging
  nightmare — when an orchestration goes wrong, the human needs to find the pane
  where it went wrong.
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

## Command surface

```
dor await <surface> [--until <signal>…] [--timeout <seconds>]
                    [--json] [--lines <count>] [--scrollback]
```

- Reuses `dor read`'s `--lines` / `--scrollback` / `--json` output shape, plus a
  `cause` field.
- `--timeout <seconds>` is a ceiling, **enforced host-side** — the host is the
  authority, so no intermediate hop can reap a parked await early and no caller
  can park forever by lying. Default: 600.
- Targets terminal Surfaces only. A browser Surface has no Session and can never
  complete; `dor await surface:browser` fails immediately with that reason rather
  than blocking (R1 means "fails with a stated reason", not "blocks politely").
- In-flight awaits are visible: `dor list` tags the Surface `[awaited]`.
- Ships with snapshot-tested help, like every `dor` command.

Exit codes — `dor` today uses only 0 and 1, so this widening is a proposal:

| Code | Meaning |
|---|---|
| 0 | Resolved. `cause` says how. |
| 1 | Usage or target error (unknown Surface, browser Surface, bad flag). |
| 2 | Timed out. |
| 3 | The Surface died before completing. |

## Behavior

| Situation | Outcome |
|---|---|
| Surface is already ringing when `await` is called | Resolves immediately, `cause: bell`. |
| Surface is at a bare prompt, nothing running | Parks. Resolves on the next command's completion. Does **not** resolve on the pre-existing silence. |
| Peer emits `OSC 9` "needs input" | Resolves, `cause: bell`. The await claims an explicitly human-directed request on the human's behalf; the TODO receipt is what keeps that honest. |
| Foreground command exits | Resolves, `cause: exit`. |
| PTY exits / Surface killed | Exits 3. A command-exit ring, if armed, fires just before the PTY event, so a peer that rings on completion still resolves as a normal `bell`. |
| `--timeout` expires | Exits 2. Absorbs nothing. |
| `dor` client disconnects | The host cancels the parked request and disarms whatever it armed. Absorbs nothing. |
| Several awaits on one Surface | Each resolves on the first signal after it started. All are tagged `[awaited]`. |
| Shell without integration | `exit` is unavailable; `bell` and `quiet` still work. `--until exit` there is a stated error, not a silent hang. |

## Contested

Three decisions the requirements leave open. Recorded here rather than settled
silently, because each changes what callers have to know.

### D1: how the wake condition is chosen

**As commissioned (R2):** `await` consults the user's watched-commands set. A
watched command (`claude`) waits for quiet; anything else waits for exit.

**Concern — this couples a human notification preference to a program's
control flow.** The watched set is a UI setting, app-global and persisted in a
webview's `localStorage`. Three consequences:

1. **Silent, non-local semantic change.** Remove `claude` from the watched set
   because the bell got annoying, and every script doing `dor await` on a claude
   pane flips from "wait until it settles" to "wait until the process exits" —
   which for an interactive agent means *hang until timeout*. A working
   orchestration breaks from an unrelated toggle in a dialog, with no error and
   nothing in the output to explain it.
2. **It is the process heuristic `alert.md` forbids, one level removed.** The
   first non-goal is "no process heuristics". The user declaring `claude` for
   *notification* purposes is an explicit request; a *different* caller
   inheriting that declaration as control flow is not — it never declared
   anything.
3. **The caller already knows.** Whoever writes `dor await` knows whether it
   spawned a build or an agent. Inferring it from global state replaces good
   information with worse.

**Alternative — union default, narrowing filters.** `await` resolves on the
**first completion signal of any kind** and reports which one in `cause`. The
watched set is never consulted. `--until` narrows:

```
dor await surface:5                    # any signal — bell, exit, or quiet
dor await surface:5 --until exit       # only a command exit
dor await surface:5 --until quiet      # only a settle
dor await surface:5 --until bell,exit  # either
```

This satisfies R1 and R2 better than auto-adapt: `claude` settles → `quiet`
fires → resolved; a build exits → `exit` fires → resolved; a build that *hangs
on a prompt* goes quiet → resolved, which is exactly when you want to be woken
and is the case auto-adapt gets wrong. No configuration, no coupling, identical
behavior on every machine.

**Cost, stated honestly:** the union can wake early. A build that emits a `BEL`
mid-run, or completes an `OSC 9;4` progress cycle before exiting, resolves the
await before the build is done. The caller sees `cause` and can loop; a caller
that needs precision uses `--until exit`. Auto-adapt does not have this problem
for the build case, and that is the real argument in its favor.

**Recommendation:** union default. The failure mode of the union is an early
wake the caller can see and retry; the failure mode of auto-adapt is a hang the
caller cannot see at all.

### D2: flag shape

**Optional, not required.** A blocking primitive is written in the middle of
quick orchestration; a required flag is friction at exactly the wrong moment,
and under D1's union default there is a genuinely correct default to have.

**Naming:** `--until <signal>` over `--until-exit` / `--until-animation-stops`.
One flag with a value beats N boolean flags that can contradict each other, and
the values reuse the `cause` vocabulary — the flag you pass and the field you
read back are the same word. "Animation" is UI vocabulary (the bell's tilt); the
thing being detected is output going quiet, so `quiet` names it directly.

### D3: absorption scope

R4 says a consumed alert must not ring, speak, or push. Settled above as
"absorb the summons, keep the receipt", with a failed await absorbing nothing.
The parts still open:

- Should `--no-absorb` exist, for a caller that wants to observe without
  claiming? Probably yes eventually; not in the first cut.
- Push is the one channel where absorption is arguable: push exists to reach a
  user who *walked away*, and a long orchestration is exactly when they have. The
  answer here is that absorption is fine precisely because a failed or timed-out
  await un-absorbs — the human still gets the phone buzz when the orchestration
  actually stalls.

## Dissolution

On landing, this file is deleted and its contents move:

| Section | Destination |
|---|---|
| Purpose, Command surface, Behavior, exit codes | `docs/specs/dor-cli.md` — promote the staged `dor await` bullet out of `## Future` into the implemented command list. |
| Completion signals, Resolution, Absorption | `docs/specs/alert.md` — a new Await section, plus whatever seam the absorption rule requires in the Public State / Clearing And TODO sections. |
| Contested | Deleted. Decisions land as prose in the destination specs; the rejected alternatives stay in this branch's git history. |
| `[awaited]` tag | `docs/specs/dor-cli.md`, `dor list` output. |

Per `AGENTS.md`, promotion is not done until the text reads as present tense with
`Source of truth:` pointers, and nothing implemented remains below a `## Future`
fold.

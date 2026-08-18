# Alert tutorial — mockup

> Working draft. Bullets and framing only; no implementation.

## The thesis

**Dormouse never interrupts you about the pane you are looking at. It speaks up
about the work you turned away from.**

Every rule in the alert system is a consequence of that one sentence. The
section should teach the sentence first and the mechanics second.

## Why the current section falls short

- The nine steps are a feature list (enable, spreads, tilts, rings, TODO×3,
  notification, command-exit). Attention never gets a step of its own.
- Attention appears only as a warning inside the `al-ring` hint — framed as a
  way to *fail* the step, not as the point of the feature.
- Nothing teaches that attention **expires**. A user who reads "it won't ring
  while you're looking at it" will reasonably assume a pane they are parked in
  never rings. It does, after 15 seconds of not touching it.
- Nothing teaches that attention is a **single spotlight** — clicking pane B is
  what gives pane A permission to ring.

## The arc

Four beats. Beat 2 is the section; the rest is scaffolding around it.

1. **A rule, not a switch** — alerts belong to a command, not a tab.
2. **Attention** — three runs of the same task, three outcomes.
3. **Two more ways the bell rings** — neither needs a rule.
4. **Nothing gets lost** — the TODO receipt.

## Beat 1 — A rule, not a switch

| id | title | hint |
|---|---|---|
| `al-watch-cmd` | Alert me whenever `longtask` runs | Press `s` to start a fake `longtask`, then click that pane's bell. The bell says *Alert on all "longtask"* — you are describing a command, not flagging a tab. |
| `al-spreads` | One rule, every pane running it | The second fake task lit up too, and you never touched its bell. Any pane you open later that runs `longtask` will watch as well. |

## Beat 2 — Attention

Section prose:

> "Looking at it" is not focus, and it is not visibility. It is **recent
> interaction**, it belongs to **one pane at a time**, and it **wears off after
> 15 seconds**. Three runs of the same task, three different outcomes:

| id | title | hint |
|---|---|---|
| `al-quiet-attended` | Sit in the pane — it finishes silently | Press `s`, then click into the task's pane and stay there. It goes quiet and *nothing happens*. You were watching; there was nothing to tell you. |
| `al-ring-switch` | Look away — the same task rings | Press `s` and go back to reading this. You just handed your attention to the tutorial pane, so the task's pane is free to ring the moment it goes quiet. |
| `al-ring-idle` | Stay put but idle — it rings anyway | Press `x` for a longer task, click into its pane, and then don't touch anything. Attention wears off after 15 seconds, so it rings without you ever leaving. |

The three runs differ only in **what you did**, which is the whole lesson. Worth
saying out loud in the prose: *you never changed a setting between these.*

Reference table (candidate for the section prose or the dialog, not a step):

| Counts as looking | Does not |
|---|---|
| clicking a pane's body or header | the pane merely being visible |
| entering passthrough | selecting it in command mode |
| typing into it | hovering it |
| clicking a door, or `Enter` on a door | a door sitting in the baseboard |

## Beat 3 — Two more ways the bell rings

Both are rule-free, and both obey the same attention rule as Beat 2.

| id | title | hint |
|---|---|---|
| `al-notif` | A program can ring the bell itself | Press `n` for a fake build that sends a notification. No rule needed — any program that asks for attention gets it, and its message rides along on the TODO tag. |
| `al-cmd-exit` | A long command finished while you were away | Dormouse noticed you watched this command start, then left. Anything that ran longer than 15 seconds and finished after you walked away is worth a word. |

## Beat 4 — Nothing gets lost

| id | title | hint |
|---|---|---|
| `al-todo-auto` | A dismissed ring leaves a TODO | Click the bell, or just select the pane. The ring goes away but a TODO stays, so an alert you waved away mid-thought does not vanish. |
| `al-todo-clear` | Press `Enter` in the pane to clear it | Dealing with the pane is what clears the reminder — not looking at it. |
| `al-todo-manual` | Add a TODO by hand | Press `t`, or right-click the bell. Same tag, no alert required. |

## Full step list (10)

```
al-watch-cmd      Alert me whenever `longtask` runs
al-spreads        One rule, every pane running it
al-quiet-attended Sit in the pane — it finishes silently
al-ring-switch    Look away — the same task rings
al-ring-idle      Stay put but idle — it rings anyway
al-notif          A program can ring the bell itself
al-cmd-exit       A long command finished while you were away
al-todo-auto      A dismissed ring leaves a TODO
al-todo-clear     Press `Enter` in the pane to clear it
al-todo-manual    Add a TODO by hand
```

Changes from today's nine: `al-busy` ("the bell tilts while the command works")
is **cut** as a step — it is feedback, not a concept, and it is what the user is
already staring at during Beat 2. `al-ring` is **split into three** so each
attention mechanism gets its own line. Everything else keeps its id.

## Two things the mockup has to solve

**1. How do you reward a non-event?** `al-quiet-attended` is credited for
*nothing happening*, which is a weak checkbox and easy to trip by accident.
Options: credit it when the task completes with the user holding attention
throughout; have the runner narrate it in place ("← no ring: you were here");
or demote it from a step to prose and let Beat 2 be two steps. This is the crux
— the "it stayed quiet" case is the one that carries the thesis, so it deserves
to feel deliberate rather than skipped.

**2. The demo needs two task lengths.** `al-quiet-attended` only works if the
task rings *inside* the 15-second attention window (roughly: ~3s of output, then
~5s of silence, ring at ~8s), otherwise attention expires and it rings even
though the user did everything right. `al-ring-idle` needs the opposite — a task
that outlives the window. Today's single `s` demo is tuned long, so it can
demonstrate the second but not the first.

## Open questions

- Is 10 steps too many? Beat 4 could collapse to two.
- Should the "counts as looking" table live in the tutorial at all, or only in
  the alert dialog where it is reference material?
- Does `al-ring-idle` ask too much dead time (~20s of deliberately doing
  nothing) for a browser tutorial?
- Should Beat 2 explicitly name the 15 seconds, or stay qualitative ("after a
  while")? Naming it is honest and testable; it also invites "why 15?".

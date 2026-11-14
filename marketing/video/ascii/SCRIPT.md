# ascii: the whole film is one terminal

Every frame is a 96 x 27 character grid in Fira Code (20 x 40 px cells), as if the music video were a TUI program running in a terminal. A warm ANSI palette on charcoal: the icon's orange, cream, and a few soft accents; never green-on-black. Big letters are a 5x7 bitmap font drawn in half-block pixels (each pixel 20 x 20 px), with a drop shadow one pixel down and right. Two rows are always on: row 25 is the lyric line (the sung word highlighted orange, sung words cream, the rest dim, `her ▸` / `him ▸` in the break) and row 26 is a tmux-style status bar (` dor `, the sections as windows with the current one starred, beat dots, the clock).

## Intro, bars 0-4 (0.0-13.5 s): `dor sing`

- A prompt types `dor sing` before the first syllable; a "now playing" line answers.
- "Do-do-Dormouse": `DO` appears, stutters (shakes, recolors), then `DORMOUSE` fills the full width in big shadowed block letters.
- The mascot, pixel-drawn from the icon (big round ears with pink insides, blush, cream belly), pops up under the title and bops on every beat; it blinks and its mouth opens on sung hits.
- A boot log on the left ticks one line a beat (`[ ok ] tiling engine`, `[ ok ] dor cli on $PATH`, ... `[ ok ] mouse support ♥`, `ready.`); a VU meter on the right jumps on the beats; a tiny `<:3 )~` scurries along the floor every bar.
- Each later "Dormouse" hit makes the letters jump and changes the scheme: orange, then cream with an orange shadow, then per-letter rainbow. "Do-do-Dormouse" (7.0 s) re-stutters.
- On the last beat the screen `clear`s top to bottom.

## Verse 1, bars 5-6 (13.5-18.8 s): panes as sung

- A single pane's border draws itself clockwise while `$ dor split` types.
- "Agent to the left": the left pane slides open (`agent ◂ left`) with a big `AGENT` label; "another agent to the right": the right pane slides in from the right; each pane flashes orange on its own word ("left", "right").
- "Dev server at the bottom": the top panes shrink and `dev server` rises from the bottom with Vite output (`DEV SERVER` label).
- "information": output speeds up (an `information ▮▮▮▯▯` meter); "packed-in": seven panes; "tight": twelve. Every pane streams fake agent output (`● Edit src/panes/split.ts`, diffs, `✓ 244 passed`) or dev-server logs.

## Pre-chorus, bars 7-8 (18.8-24.1 s): alerts, then C-L-I

- Back to three panes. "Alerts": a yellow `ALERTS!` banner rings across the screen; the right pane stops on `? Allow edit to package.json?`, its border blinks yellow with a `[!] needs you` badge.
- "pop": a `◆ dormouse` toast slides in ("agent ▸ right needs you"); "up": a second toast and a `✓ done` badge for the left pane.
- "when I need to know": a pixel mouse pointer glides to the alert and clicks it exactly on "know"; the pane takes focus (heavy orange border), the answer `❯ y ✓ allowed` prints and output resumes.
- "C-L-I": a clean `zsh` pane; the letters C, L, I slam in one per syllable.
- "automation": `dor split --right`, `dor ensure -- pnpm dev`, `dor await`, `dor send "ship it"` type themselves, each ticking ✓.
- "build my own flow": each command becomes a node box (one per word: build, my, own, flow) joined by `───▶` arrows; on "flow" a packet runs through the chain lighting each node, captioned `◆ my own flow ◆`.

## Chorus 1, bars 9-12 (24.1-34.8 s)

Each line: on its two "Dormouse," hits, full-width `DORMOUSE` drops in letter by letter (orange), then bounces and turns cream on the second hit, over a beat-driven equalizer and a parade of tiny mice that doubles on the second hit. Then the tag line takes the whole screen:

- "multitask more": panes double every few frames (2, 4, 8, 16, 32), each with a spinner; on "more" every pane turns green ✓ and `MULTITASK MORE` completes in a big orange banner.
- "D-O-R spells dor": giant D, O, R land one per letter; "spells" brings a `D + O + R spells ↓` tag; "dor" types `$ dor` in big lowercase with a block cursor and the subcommands underneath (`split ensure await send open tool reopen`).
- "VS Code or standalone": a VS Code-ish frame (activity bar, a Dormouse tab, blue status bar) slides in from the left on "VS", an `or` chip on "or", and a plain window frame with traffic lights from the right on "standalone"; both hold live Dormouse panes.
- "from my laptop to my phone": a laptop rises with panes on its screen; on "to" the whole grid letterboxes inward between two orange bars, and on "phone" a phone frame springs open with one agent pane and an input row.

## Verse 2, bars 13-16 (34.8-45.5 s)

- "Browser repping in the front": a browser (`localhost:5173`, a little cream web page saying HELLO with Sign up / Docs buttons) slides in front of a terminal; "terminal party in the back": the terminal behind goes rainbow with confetti and `\o/` dancers on the beat; `in the front ▸` and `◂ in the back` chips.
- "A Dor Tool": `DOR TOOL` in block letters; a terminal pane rises, then a browser stacks in front of it ("a browser in front, a terminal behind").
- "is a mullet": the mascot pops up with a mullet ("◂ business in the front", "◂ party in the back" in rainbow, `a Dor Tool is a mullet`).
- "I can build with any stack": blocks labelled react, svelte, rust, python, go, vue drop and stack up on the beats; `any stack ✓`.
- "Vibe-coded in an evening": a dusk sky, the sun sets as a block clock races 18:00 → 23:59 and an editor (`vibe.ts ◆ vibe-coded`) fills itself; "but still easy to maintain": a checklist ticks `[✓] typed`, `tested`, `readable`, `easy to maintain` on the sung words.
- "Mouse and keys at my desk": a big pixel computer mouse clicks on "Mouse"; a keyboard slides in with keys lighting on "keys"; a monitor of panes appears on "desk".
- "just my thumbs on the train": cut to a parallax train scene: hills at two speeds, telegraph poles and wires rushing past, rails and sleepers; the Dormouse-orange carriage ("DORMOUSE EXPRESS") with the mascot in a window tapping a phone with both thumbs.

## Break, bars 17-19 (45.5-53.5 s): the chat

- Still on the train, the phone comes up close: `◆ #train-chat · 2 online`.
- Each line is a chat bubble (her: pink, left; him: teal, right) that shows typing dots, then fills word by word at the sung times: "What app is that?", "Oh I'm vibescrolling, girl", "Dawg, vibescrolling?", "I'm not a dog, I'm a…".
- Bar 19 (instrumental): a heavy orange dialog opens: `I'M A` in block letters over a progress bar that loads in stalls and jumps (`loading identity…`, `not a dog ✓ checking ears…`, `resolving species…`), reaching 100% `✓ identity loaded` just as chorus 2 answers "Dormouse".

## Chorus 2, bars 20-23 (53.5-64.1 s): everything bigger

Same structure, escalated: a twinkling star field behind everything, `DORMOUSE` in cycling rainbow letters that wave, confetti bursts on every hit, twice as many mice, a rainbow equalizer. Tags: 4 → 64 panes with rainbow borders and `MORE` in orange on cream; D, O, R full-height in rainbow; `$ dor` in rainbow with confetti; VS Code and standalone frames bobbing on the beat with confetti; the phone has a rainbow frame and holds the mascot in sunglasses above `DORMOUSE`.

## "Do-Dormouse.sh, baby", bar 24 (64.1-66.8 s)

- `$ open https://dormouse.sh` types itself, the domain one syllable at a time ("Dor", "mouse", ".", "s", "h"), echoed in tall block letters.
- Enter: a browser springs open on a little dormouse.sh page (mascot, "a mouse-friendly multitasking terminal", Download / VS Code / phone buttons).
- "baby": a big pink pixel heart beats, with a shower of hearts and a `baby` chip.

## Outro, bars 25-27 (66.8-74.0 s): four last "Dormouse"

- The heart keeps beating on an empty prompt until the first hit.
- Hit 1: the charcoal rounded icon tile springs open with its white `>`.
- Hit 2: the mascot drops onto the tile, big, like the icon; the `_` cursor starts blinking.
- Hit 3: `DORMOUSE` wordmark lands letter by letter, with "a mouse-friendly multitasking terminal" typing above it.
- Hit 4: the wordmark turns rainbow, `dormouse.sh` with "panes · alerts · dor" and "vs code · standalone · phone", a last confetti, and the prompt types `thanks for multitasking ♥` with a blinking cursor to the end.

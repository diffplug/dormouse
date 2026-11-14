# Review notes

For whoever changes this film next, including an agent.

## Creative calls

- **Only type and geometry.** No screenshots, no characters; the icon appears once, on the end card, from `assets/icon.svg` (a copy of `vscode-ext/icon.svg`). The end card sits on ink, not charcoal, because the icon's tile is the charcoal.
- **Palette.** The icon's orange is pushed louder (`#e8834a`) and its charcoal kept (`#43423d`); cobalt fights the orange, cream is the paper, and lime is kept for alerts, highlights and the cursor in the phone.
- **Three faces, three voices.** Archivo (variable weight and width) is the shout; JetBrains Mono is anything a terminal would say (`$ dor`, `dormouse.sh`, the small connecting words); Instrument Serif italic is "her" in the break and the business half of the mullet. The outro stacks all of them as the last four hits.
- **The width axis is a motion.** "packed-in tight" squeezes INFORMATION from 125% wide to 62%; chorus 2 stretches and squeezes DORMOUSE. Sizes in the scenes were measured against the real fonts, not guessed (see "Fitting type" below).
- **Small words are always on screen when sung.** `S.sing` in `assets/lib.js` builds a row from a lyric line's words and reveals each at its sung time; the big words are hand-placed `S.slam`s keyed to the same times. Nothing is timed by hand in seconds except where the transcript has one word for several sung syllables.
- **Hand-split words.** "Do-do-Dormouse" (intro) is one transcript word; it is split into four eighth notes from its start. "Do-Dormouse.sh" (tag) uses the raw transcript's split: "Do-Dor" at 64.46 and "mouse.sh" at 65.12 (`../../Dormouse_Multitask_eng.json`). "C-L-I" and "D-O-R" are lit 0.2–0.22 s apart from their word's start.
- **Chorus 2 escalates chorus 1** idea for idea: two hits become an explosion and a wall; four panes become sixteen; D-O-R in cells becomes D, O, R each owning the frame; stacked bands become a diagonal split; laptop-morphs-to-phone becomes laptop and phone side by side with the cursor jumping across.
- **The break's wind-up** (bar 19) is a loading bar and an ink cursor that swallows the frame, so chorus 2 can explode out of the dark.

## Fitting type

Archivo 900 is wide: DORMOUSE is 6.19 em at 100% width and 3.99 em at 62%. A quick Puppeteer page against `assets/style.css` (Chrome from hyperframes' cache) measured each big word before it was sized; to fill 1760 px, DORMOUSE needs 284 px at 100% and 441 px at 62%. Change a word or its width and re-measure, or check the snapshot: nothing here sizes type at runtime.

## Kept warnings

- `hyperframes check` passes with 0 errors and 14 `line_unread` warnings. Most are single words or letters the song itself holds for under 0.4 s ("MORE" in chorus 1, "$ dor", the PHONE and STACK letters, BACK) or the "vibescrolling" feed lines, which are texture. The end card holds "dormouse.sh" about 1.8 s before the film ends, under the 2 s the check wants: the fourth "Dormouse" is sung at 71.48, so the card can't come earlier without cutting the song's last hit.
- One contrast warning at 53.44 s: the exploding letters pass over the cream flash for a frame or two.

## Not checked

- **The sound was not heard.** Every hit is placed from `shared/lyrics.json` word times (and the raw transcript for the tag). The six words flagged `estimated` (intro3 and intro4's "Dormouse"s, c1a's and c1b's second "Dormouse", out4) were trusted with a 0.04–0.1 s lead. Watch the intro's second stutter (7.00 s) and the fourth outro hit with sound before shipping.
- Frames were reviewed as stills (contact sheets across every section), not as motion; a fast cut that reads fine in stills can still strobe. The c2d strobe is two inversions a beat apart, which should be safe, but was not watched in motion.
- Readability at phone size was not checked.

## Weakest moments

- Intro bar 1 (3.5–5.5 s) and the start of bar 4 (10.8–11.5 s) are the stillest stretches: one word drifting, or an empty charcoal field with a cursor.
- The break's "Oh I'm vibescrolling, girl" is busy: the scrolling feed sits behind the words, kept tone-on-tone to stay legible.
- c1b and c2a's "more" are short by the song's own timing, so "MORE" in chorus 1 is up for only about a quarter second.

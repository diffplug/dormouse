# Review notes

For whoever changes this film next, including an agent.

## How it works

- **One engine:** `assets/lib.js` holds a 96 x 27 grid of `{char, fg, bg}` cells plus a 96 x 54 half-block pixel layer on the same cells. `A.run(sc, draw)` clears the grid, calls `draw(g, filmTime)`, adds the lyric line (row 25) and the status bar (row 26), and writes one `<div>` per row of coalesced `<span>` runs, only where the row's HTML changed.
- **Seek-safe:** each scene's timeline has a single tween on a getter/setter property, so every seek, even with events suppressed, calls the draw with that time. A frame depends only on its time: no Math.random (a stateless integer hash instead), no accumulated state; the only caches are pure (sprite bitmaps, last row HTML). Snapshots of 8 times taken in forward and reverse order were byte-identical PNGs.
- **Cells:** Fira Code (OFL, `firacode` npm package, full glyph set in `assets/fonts/`) at 32.5 px has a 20 px advance, and its block and box glyphs fill a 40 px line exactly, so 96 x 27 cells tile 1920 x 1080 with no gaps. Full blocks and half-blocks are drawn as span backgrounds (a two-stop gradient for ▀), not glyphs, so big letters have no seams. Every span has an explicit width, so a glyph that falls back to another font can never shift its row.
- **Timing:** every cue reads a sung word's time from `shared/lyrics.json` via `A.w(lineId, word)`; nothing is hand-timed except the sub-syllable splits below. `assets/chorus.js` draws both choruses from their line ids, with `hype` for the second.

## Creative calls

- A warm palette on charcoal (icon orange, cream, and soft yellow, lime, teal, blue, lavender, pink); no green-on-black. Pane borders are a warm grey lifted to 3:1 contrast.
- The mascot is drawn from shapes (ellipses with an automatic outline), so one definition gives the intro bopper, the mullet, the train passenger, the sunglasses phone mouse and the logo mouse at any scale.
- The lyric line is the readable channel for every sung word; big block letters carry the hooks (DORMOUSE, AGENT, DEV SERVER, ALERTS!, C-L-I, MULTITASK MORE, D-O-R / `$ dor`, DOR TOOL, I'M A, dormouse.sh).
- `dor` is always lower-case as a command; "D-O-R" is spelled in capitals because it is sung as letters.
- The break stays on the train so the chat is plainly on the mouse's phone; bar 19's loading bar is the punchline set-up, and chorus 2 is the answer.
- The outro builds the app icon piece by piece, one piece per "Dormouse" hit.

## Timing guesses

- "Do-do-Dormouse" is one transcript word; its three syllables are placed on eighth notes (0.52 / 0.85 / 1.19 s and 7.00 / 7.33 / 7.67 s). The second one (intro3) and intro4's hits, c1a/c1b's second "Dormouse," and out4 are flagged `estimated` in the lyrics.
- "C-L-I" and "D-O-R" are single transcript words; their letters are spread across the word (about 0.2 s apart).
- "Do-Dormouse.sh" is one word lasting about 1.9 s; the URL pieces are spread across it by eye (Dor +0.3 s, mouse +0.6 s, dot +1.0 s, s +1.25 s, h +1.5 s).

## Kept warnings from `npx hyperframes check`

- `text_box_overflow` (errors in the layout pass): box-drawing and block glyphs ink to the very edge of their 40 px line, which is what makes them tile; the checker reads that as text leaving its box. Expected for a character grid.
- `line_unread`: the panes stream fake agent and dev-server output on purpose; it is texture, not something to read. The lyric line and the big letters hold long enough.
- `contrast_aa_failure`: what remains is decorative: the ▪ filler bars inside the 32 tiny panes, dim secondary captions, and stars.
- `content_overlap` / `text_occluded` (2 warnings, a few infos): glyph ink of neighbouring cells measured as overlapping boxes; no cell can hold two characters.

## Not checked

- **The sound was not heard.** Sync was set from the transcript's word times and the 90 BPM beat grid only; the estimated words above are the likeliest to sit a little off.
- No contrast or legibility check on a phone-sized screen; the grid text is 32.5 px at 1080p.
- The render was not compared frame by frame against the snapshots. `renders/ascii.mp4` was checked with ffprobe (1920x1080 h264 at 30 fps, AAC audio, 74.000 s), and 11 frames pulled from it with ffmpeg matched the snapshots.

## Weakest moments

- The first beat of a few cuts is sparse for a fraction of a second while things slide in (13.5-13.9 s verse 1 border, 42.8-43.2 s the desk before the keyboard, 64.1-64.5 s the empty prompt before the URL).
- Chorus 2's VS Code / standalone tag is the least escalated part of the second chorus: the same two frames bobbing, plus confetti.
- At about 38.5-38.7 s, the mullet mouse's spring-in overshoots and its ears briefly cover the "a browser in front, a terminal behind" caption.
- The train passenger is small (a 12-pixel mouse in a window) and is hidden behind the phone for the whole break.

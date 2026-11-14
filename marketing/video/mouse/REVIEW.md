# Review notes

For whoever changes this film next, including an agent.

- **Creative calls:** a flat paper world with hard ink outlines, after the selfie film; the mouse is redrawn as a rig in the logo's colors and shapes (`vscode-ext/icon.svg`), not traced from it; verses are cream, each chorus line has its own color, and the second chorus reuses those colors as party lights; the mullet is grown in verse 2, kept through the break and the party, and thrown off on "baby" so the end card matches the logo.
- **Against the product brief:** `PRODUCT.md` lists mascots and playfulness as anti-references for the product's interface. This is a music video, so it ignores that on purpose.
- **Illustrative, not real:** every pane, window and device is a drawing. The commands typed in the pre-chorus (`dor split -- claude`, `dor await --until quiet`) are real `dor` commands; "flow: ready" and "ready in 212ms" are made up. "Multitasking terminal for mice" is the tagline on `website/public/og-image.jpg`.
- **Timing:** scenes cut on bars of the 90 BPM grid in `shared/lyrics.json`, actions land on word times, and everything bops on the beat. Six words carry estimated times (`"estimated": true`): the second and third "Dormouse" groups of the intro, one "Dormouse" in each of the first two chorus lines, and the last word of the song. Moves tied to them may be early or late.
- **Sub-word timing is guessed:** the transcript gives one time for "Do-do-Dormouse" and one for "D-O-R". The intro's stutters and the three letter cards split those spans evenly.
- **Not checked:** nobody has heard this against the picture. I cannot hear audio, so sync was checked only as numbers and as still frames. Motion was checked from stills, not by watching it play.
- **Checked:** `npx hyperframes check` passes; stills of every scene and of the leaps, turns and cuts were looked at.
- **Kept warnings:** `dead_stretch` (the checker does not see motion inside elements marked `data-layout-ignore`, which is everything here); `line_unread` on the "front" and "back" signs in `mullet`, which are props beside the sung line and not text to read.
- **Known rough spots:** the mouse has no elbows, so typing and holding a phone are arms held out or in; leaps are a straight slide with a rise and fall; in `desk` the mouse stands behind a desk with a front panel in place of sitting; in `party` the lights are plain circles; the sing-along band stays up, empty, during the instrumental bar and after the last word.

## Changing it

- A scene's moves are tied to words with `w("word")` and to beats with `sc.beats`, so new timings in `shared/lyrics.json` move them. `w()` matches letters only, so `w("dor")` also matches "D-O-R": use `{ nth: 1 }` for the second.
- `S.html` appends only the first element of its markup.
- `assets/lib.js` holds the rig (`S.mouse`), the cast (`S.bot`, `S.server`, `S.crew`), the train (`S.train`, `S.trainSeat`) and the sing-along line (`S.karaoke`).

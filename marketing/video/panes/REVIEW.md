# Review notes

For whoever changes this film next, including an agent.

- **Creative calls:** no characters, only the window; one dark theme throughout, with chorus 2 changing theme on every line; the lyric as a prompt line under the window, dim until sung; the tag words of the chorus and verse 2 landing as large type over the panes; every pane move in the app's own 440 ms ease-out, and reveals as clip-paths from the side the pane appeared on.
- **Drawn from the product:** the dark theme's rough palette, bg-only chrome, the header as the tab, doors on a baseboard, the TODO pill, the alarm inset, the focus ring, `dor split`, `dor ensure`, `dor agent-browser open`, the `dor` verb list, the `-` and `|` split keys, and the `run` / `render` / `port` keys of a Tool in `dormouse.yml`.
- **Illustrative, not real:** everything is hand-drawn DOM, not the app. Sizes are about twice the product's so they read in a video. The header's `_ x` buttons, the notice popups ("claude needs you [enter]"), the VS Code frame, the party-colored header, the keycaps, the phone's key row, `created surface:12`, the "Mullet" web page, the six stack Tools and the agent, dev-server and test output are all invented. The standalone app bar's tabs and window buttons are approximations.
- **Claims with a source:** "Multitasking terminal for mice" is the line on `website/public/og-image.jpg`. The logo is `vscode-ext/icon.svg`, copied to `assets/logo.svg`.
- **Timing:** scenes cut on bars; hits come from the word times in `../shared/lyrics.json`. The syllables inside one transcript word ("Do-do-Dor-mouse", "D-O-R") are spaced evenly or on eighth notes, and the six words marked `estimated` there were never checked by ear.
- **Not checked:** nobody has heard this film. Sync was judged only from the timing data and from still frames. Motion between stills was not watched.
- **Kept warnings from `hyperframes check`:** `text_below_floor`, since terminal output is texture at 24 px and the lyric line is 50 px; `line_unread`, since lines leave when the singer moves on; info-level `text_occluded` and `content_overlap`, which are terminal rows scrolled under their own header and the notices over the panes.
- **Fonts:** Ubuntu Sans Mono and Ubuntu Mono, the website's faces, from the `@fontsource` packages, Latin subset only: a glyph outside it falls back to a system font, so none is used.

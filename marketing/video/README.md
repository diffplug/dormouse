# Music videos for "Dormouse Multitask"

Each folder beside `shared/` is one [HyperFrames](https://hyperframes.heygen.com) film for the same song: HTML and GSAP, rendered to MP4. The films share the song and its timing and nothing else, so a scene can be lifted from one into another.

| File | Owns |
|---|---|
| `../Dormouse Multitask.m4a`, `../Dormouse_Multitask_eng.json` | The song, and a transcript with the time of each sung word. |
| `shared/make-lyrics.mjs` → `shared/lyrics.json` | The lyrics as they are spelled, one line per phrase, each word with its time, plus the beat grid. Six words carry `"estimated": true`: the transcript gave them no usable time. |
| `shared/kit.js` | `S.begin(id)`: a scene's timeline, its words (`w("mullet")`), lines and beats, all in scene seconds. |
| `shared/build.mjs` | Writes a film's `index.html` from its `scenes.json`, and copies the kit and the song into its `assets/`. |
| `<film>/scenes.json` | The cuts. A scene starts at a `bar`, a `beat`, a film second (`at`) or just before a lyric `line`. |
| `<film>/compositions/<id>.html` | One scene's pictures. |
| `<film>/assets/lib.js`, `<film>/assets/style.css` | That film's art. |
| `<film>/SCRIPT.md`, `<film>/REVIEW.md` | The treatment, and notes for whoever changes the film next. |
| `_template/` | The smallest film that builds: copy it to start another. |

```sh
npm install
node shared/setup.mjs                  # once: ffmpeg into .bin/, and the AAC copy of the song
export PATH="$PWD/.bin:$PATH"
cd <film>
node ../shared/build.mjs               # after changing scenes.json
npx hyperframes check                  # lint, layout, and motion
npx hyperframes snapshot --at 25.9     # one frame, to look at
npx hyperframes preview                # edit and scrub in the browser
npx hyperframes render -o renders/<film>.mp4
```

## The song

90 BPM, 4 beats to a bar, 74 seconds. Bar `n` starts at `0.137 + 2.667 n` seconds.

| Bars | Seconds | Section |
|---|---|---|
| 0–4 | 0.1–13.5 | Intro: "Do-do-Dormouse" |
| 5–6 | 13.5–18.8 | Verse 1 |
| 7–8 | 18.8–24.1 | Pre-chorus |
| 9–12 | 24.1–34.8 | Chorus 1 |
| 13–16 | 34.8–45.5 | Verse 2 |
| 17–18 | 45.5–50.8 | Break: the dialogue |
| 19 | 50.8–53.5 | Instrumental bar after "I'm a…" |
| 20–23 | 53.5–64.1 | Chorus 2 |
| 24 | 64.1–66.8 | "Do-Dormouse.sh, baby" |
| 25–27 | 66.8–74.0 | Outro: four more "Dormouse" |

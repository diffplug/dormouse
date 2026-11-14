// Writes shared/lyrics.json: the song's lines as they are spelled, each word with the time it is sung.
// The times come from ../Dormouse_Multitask_eng.json, a transcript that hears "Dormouse" as "Door mouse",
// so each word here says how many transcript tokens it covers. Run: node shared/make-lyrics.mjs
import { readFileSync, writeFileSync } from "node:fs";

const here = new URL(".", import.meta.url);
const transcript = JSON.parse(readFileSync(new URL("../../Dormouse_Multitask_eng.json", here), "utf8"));
const tokens = transcript.segments
  .flatMap((s) => s.words)
  .filter((w) => w.text.trim() && !w.text.startsWith("["))
  .map((w) => ({ heard: w.text, start: w.start_time, end: w.end_time }));

// A word is "text" for one token or ["text", n] for n tokens. D = Dormouse, which is always two.
const D = (text = "Dormouse") => [text, 2];
const LINES = [
  ["intro1", "intro", [D("Do-do-Dormouse")]],
  ["intro2", "intro", [D()]],
  ["intro3", "intro", [D("Do-do-Dormouse")]],
  ["intro4", "intro", [D("Dormouse,"), D()]],
  ["intro5", "intro", [D("Dormouse,"), D()]],
  ["v1a", "verse1", ["Agent", "to", "the", "left,", "another", "agent", "to", "the", "right"]],
  ["v1b", "verse1", ["Dev", "server", "at", "the", "bottom,", "information", ["packed-in", 2], "tight"]],
  ["pre1", "prechorus", ["Alerts", "pop", "up", "when", "I", "need", "to", "know"]],
  ["pre2", "prechorus", ["C-L-I", "automation", "to", "build", "my", "own", "flow"]],
  ["c1a", "chorus1", [D("Dormouse,"), D("Dormouse,"), "multitask", "more"]],
  ["c1b", "chorus1", [D("Dormouse,"), D("Dormouse,"), "D-O-R", "spells", "dor"]],
  ["c1c", "chorus1", [D("Dormouse,"), D("Dormouse,"), ["VS", 2], "Code", "or", "standalone"]],
  ["c1d", "chorus1", [D("Dormouse,"), D("Dormouse,"), "from", "my", "laptop", "to", "my", "phone"]],
  ["v2a", "verse2", ["Browser", "repping", "in", "the", "front,", "terminal", "party", "in", "the", "back"]],
  ["v2b", "verse2", ["A", "Dor", "Tool", "is", "a", "mullet,", "I", "can", "build", "with", "any", "stack"]],
  ["v2c", "verse2", [["Vibe-coded", 2], "in", "an", "evening,", "but", "still", "easy", "to", "maintain"]],
  ["v2d", "verse2", ["Mouse", "and", "keys", "at", "my", "desk,", "and", "just", "my", "thumbs", "on", "the", "train"]],
  ["br1", "break", ["What", "app", "is", "that?"], "her"],
  ["br2", "break", ["Oh", "I'm", ["vibescrolling,", 2], "girl"], "him"],
  ["br3", "break", ["Dawg,", ["vibescrolling?", 2]], "her"],
  ["br4", "break", ["I'm", "not", "a", "dog,", "I'm", "a"], "him"],
  ["c2a", "chorus2", [D("Dormouse,"), D("Dormouse,"), "multitask", "more"]],
  ["c2b", "chorus2", [D("Dormouse,"), D("Dormouse,"), "D-O-R", "spells", "dor"]],
  ["c2c", "chorus2", [D("Dormouse,"), D("Dormouse,"), ["VS", 2], "Code", "or", "standalone"]],
  ["c2d", "chorus2", [D("Dormouse,"), D("Dormouse,"), "from", "my", "laptop", "to", "my", "phone"]],
  ["tag", "outro", [D("Do-Dormouse.sh,"), "baby"]],
  ["out1", "outro", [D("Dormouse,")]],
  ["out2", "outro", [D("Dormouse,")]],
  ["out3", "outro", [D("Dormouse,")]],
  ["out4", "outro", [D()]],
];

// The transcript gave these words no length or a time out of order. These are estimates from the beat grid
// and from the same phrase sung elsewhere, and nobody has checked them by ear. [line, word index, start, end].
const ESTIMATED = [
  ["intro3", 0, 7.0, 8.1],
  ["intro4", 0, 8.19, 8.9],
  ["intro4", 1, 9.52, 10.38],
  ["c1a", 1, 24.82, 25.5],
  ["c1b", 1, 27.5, 28.1],
  ["out4", 0, 71.48, 72.6],
];

let at = 0;
const lines = LINES.map(([id, section, words, voice]) => ({
  id,
  section,
  ...(voice ? { voice } : {}),
  words: words.map((w) => {
    const [text, n] = Array.isArray(w) ? w : [w, 1];
    const first = tokens[at], last = tokens[at + n - 1];
    if (!last) throw new Error(`The transcript ran out at "${text}" in ${id}`);
    at += n;
    return { text, start: first.start, end: last.end };
  }),
}));
if (at !== tokens.length) throw new Error(`The transcript has ${tokens.length - at} words after the last line, from "${tokens[at].heard}"`);

for (const [id, i, start, end] of ESTIMATED) Object.assign(lines.find((l) => l.id === id).words[i], { start, end, estimated: true });

let clock = 0;
for (const line of lines) {
  for (const w of line.words) {
    if (w.end <= w.start || w.start < clock - 0.02) throw new Error(`${line.id} "${w.text}" has a bad time: ${w.start}–${w.end} after ${clock}`);
    clock = w.end;
  }
  line.text = line.words.map((w) => w.text).join(" ");
  line.start = line.words[0].start;
  line.end = line.words.at(-1).end;
}

// The beat grid, from the onsets in the recording: 90 BPM, steady from start to end, and the chorus starts on a bar.
const song = { duration: 74, bpm: 90, firstBeat: 0.137, beatsPerBar: 4, lines };
writeFileSync(new URL("lyrics.json", here), JSON.stringify(song, null, 1).replace(/\{\n\s+"text": ([^\n]+),\n\s+"start": ([^\n]+),\n\s+"end": ([^\n,]+)(,\n\s+"estimated": true)?\n\s+\}/g, (_, t, s, e, est) => `{ "text": ${t}, "start": ${s}, "end": ${e}${est ? `, "estimated": true` : ""} }`) + "\n");
for (const l of lines) console.log(l.id.padEnd(7), l.start.toFixed(2).padStart(6), l.end.toFixed(2).padStart(6), " ", l.text);

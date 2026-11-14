// Shared timing helpers for every film. build.mjs copies this file into each film's assets/.
// Everything here is deterministic, so every render is identical. Art belongs in the film's own assets/lib.js.
(function () {
  const SONG = window.SONG; // lyrics.json, set by the generated index.html.
  const SCENES = window.SCENES; // { id: { start, dur } }, in film seconds.
  const plain = (w) => w.toLowerCase().replace(/[^a-z0-9]/g, "");
  const beatTime = (n) => SONG.firstBeat + (n * 60) / SONG.bpm;

  /** Seeded, so every render is identical. */
  function rand(seed) {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function html(parent, markup) {
    const t = document.createElement("template");
    t.innerHTML = markup.trim();
    const el = t.content.firstElementChild;
    parent.appendChild(el);
    return el;
  }

  /**
   * Starts a scene. Every time it returns is in seconds from the start of the scene, which is what its timeline wants.
   *   t(filmSeconds)        a film time, as a scene time
   *   w("word", {nth, after, line})   when the word is sung in this scene; nth counts repeats, after gives its end,
   *                         line limits the search to one line id. An unknown word is an error, so a beat can't come loose.
   *   line("c1a")           { start, end, text, words: [{ text, start, end }] } of one lyric line
   *   lines                 the lines sung during this scene, in order
   *   beats                 [{ t, n, bar, inBar }] for each beat in the scene; inBar 0 is the downbeat
   *   beat(n), bar(n)       the scene time of the song's nth beat or bar
   */
  function begin(id) {
    const scene = SCENES[id];
    if (!scene) throw new Error(`scenes.json has no scene "${id}"`);
    const t = (film) => +(film - scene.start).toFixed(3);
    const rel = (l) => ({ ...l, start: t(l.start), end: t(l.end), words: l.words.map((x) => ({ ...x, start: t(x.start), end: t(x.end) })) });
    const all = SONG.lines.map(rel);
    const lines = all.filter((l) => l.start < scene.dur && l.end > 0);
    const line = (lineId) => {
      const l = all.find((x) => x.id === lineId);
      if (!l) throw new Error(`No lyric line "${lineId}"`);
      return l;
    };
    const w = (word, { nth = 0, after = false, line: lineId } = {}) => {
      const pool = (lineId ? [line(lineId)] : lines).flatMap((l) => l.words);
      const hit = pool.filter((x) => plain(x.text) === plain(word))[nth];
      if (!hit) throw new Error(`Scene ${id} never sings "${word}"${nth ? ` ${nth + 1} times` : ""}`);
      return after ? hit.end : hit.start;
    };
    const beats = [];
    for (let n = 0; beatTime(n) < scene.start + scene.dur; n++) {
      const at = t(beatTime(n));
      if (at >= -0.001) beats.push({ t: Math.max(0, at), n, bar: Math.floor(n / SONG.beatsPerBar), inBar: n % SONG.beatsPerBar });
    }
    return {
      tl: gsap.timeline({ paused: true }),
      id, dur: scene.dur, start: scene.start, stage: document.getElementById(`${id}-stage`),
      t, w, line, lines, beats,
      beat: (n) => t(beatTime(n)),
      bar: (n) => t(beatTime(n * SONG.beatsPerBar)),
    };
  }

  window.S = { SONG, SCENES, begin, rand, html, plain };
})();

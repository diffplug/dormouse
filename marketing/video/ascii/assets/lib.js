// The ascii film: every frame is a 96x27 character grid, redrawn from scratch as a pure function of film time.
// A scene calls A.run(sc, draw); draw(g, ft) paints one frame into a cleared Grid, then the chrome (lyric line, status bar) goes on top.
// Nothing here keeps state between frames except the memo of sprite bitmaps and the last HTML per row, both pure caches.
(function () {
  const COLS = 96, ROWS = 27, CH = 40;
  const SONG = window.SONG;
  const BEAT = 60 / SONG.bpm;

  const C = {
    bg: "#24201e", ink: "#2f2a27", ink2: "#3b3531", line: "#736a63", dim: "#8f8278",
    cream: "#f4e8d4", white: "#fffaf0", or: "#e8935c", or2: "#ffbe8c", ord: "#94502c",
    brown: "#4a2c1e", pink: "#f49cab", teal: "#71c9b8", blue: "#86aee8", yel: "#f5cb62",
    lime: "#b5d77a", lav: "#b9a3e6", red: "#ec6a5e", tile: "#3e3a37", hair: "#7a4524",
  };
  const RAINBOW = [C.or, C.yel, C.lime, C.teal, C.blue, C.lav, C.pink];
  const KEY = { o: C.or, O: C.or2, c: C.cream, w: C.white, b: C.blue, t: C.teal, p: C.pink, y: C.yel, l: C.lime, d: C.dim, r: C.red, v: C.lav, n: C.line, k: C.bg };

  // ---------- math and time ----------
  const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
  const seg = (t, a, b) => clamp((t - a) / (b - a));
  const lerp = (a, b, x) => a + (b - a) * x;
  const outCubic = (x) => 1 - Math.pow(1 - x, 3);
  const inCubic = (x) => x * x * x;
  const outBack = (x) => { const c = 1.9; return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2); };
  function hash(...n) {
    let h = 2166136261 >>> 0;
    for (const v of n) {
      h ^= (v | 0) + 0x9e3779b9;
      h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
      h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
      h ^= h >>> 16;
    }
    return (h >>> 0) / 4294967296;
  }
  const beatAt = (n) => SONG.firstBeat + n * BEAT;
  const barAt = (n) => beatAt(n * 4);
  function beat(ft) {
    const x = (ft - SONG.firstBeat) / BEAT;
    const n = Math.floor(x);
    return { n, frac: x - n, since: (x - n) * BEAT, bar: Math.floor(n / 4), inBar: ((n % 4) + 4) % 4 };
  }
  /** 1 on each beat, falling to 0 over `decay` seconds. */
  const pulse = (ft, decay = 0.3) => { const b = beat(ft); return b.n < 0 ? 0 : Math.pow(clamp(1 - b.since / decay), 2); };
  /** 1 at time `at`, falling to 0 over `decay` seconds; 0 before. */
  const hit = (ft, at, decay = 0.3) => (ft < at ? 0 : Math.pow(clamp(1 - (ft - at) / decay), 2));

  const LINES = SONG.lines;
  const plain = (w) => w.toLowerCase().replace(/[^a-z0-9]/g, "");
  function line(id) { const l = LINES.find((x) => x.id === id); if (!l) throw new Error(`No line ${id}`); return l; }
  /** Film time a word of a line is sung. */
  function w(id, word, nth = 0) {
    const hits = line(id).words.filter((x) => plain(x.text) === plain(word));
    if (!hits[nth]) throw new Error(`Line ${id} has no "${word}"`);
    return hits[nth].start;
  }
  /** The text typed so far, at `cps` characters per second from `t0`. */
  const typed = (str, t0, cps, ft) => (ft < t0 ? "" : str.slice(0, Math.floor((ft - t0) * cps)));

  // ---------- the 5x7 font ----------
  const FONT_SRC = {
    A: ".###.|#...#|#...#|#####|#...#|#...#|#...#", B: "####.|#...#|#...#|####.|#...#|#...#|####.",
    C: ".###.|#...#|#....|#....|#....|#...#|.###.", D: "####.|#...#|#...#|#...#|#...#|#...#|####.",
    E: "#####|#....|#....|####.|#....|#....|#####", F: "#####|#....|#....|####.|#....|#....|#....",
    G: ".###.|#...#|#....|#.###|#...#|#...#|.####", H: "#...#|#...#|#...#|#####|#...#|#...#|#...#",
    I: "###|.#.|.#.|.#.|.#.|.#.|###", J: "..###|...#.|...#.|...#.|...#.|#..#.|.##..",
    K: "#...#|#..#.|#.#..|##...|#.#..|#..#.|#...#", L: "#....|#....|#....|#....|#....|#....|#####",
    M: "#...#|##.##|#.#.#|#.#.#|#...#|#...#|#...#", N: "#...#|#...#|##..#|#.#.#|#..##|#...#|#...#",
    O: ".###.|#...#|#...#|#...#|#...#|#...#|.###.", P: "####.|#...#|#...#|####.|#....|#....|#....",
    Q: ".###.|#...#|#...#|#...#|#.#.#|#..#.|.##.#", R: "####.|#...#|#...#|####.|#.#..|#..#.|#...#",
    S: ".####|#....|#....|.###.|....#|....#|####.", T: "#####|..#..|..#..|..#..|..#..|..#..|..#..",
    U: "#...#|#...#|#...#|#...#|#...#|#...#|.###.", V: "#...#|#...#|#...#|#...#|#...#|.#.#.|..#..",
    W: "#...#|#...#|#...#|#.#.#|#.#.#|#.#.#|.#.#.", X: "#...#|#...#|.#.#.|..#..|.#.#.|#...#|#...#",
    Y: "#...#|#...#|.#.#.|..#..|..#..|..#..|..#..", Z: "#####|....#|...#.|..#..|.#...|#....|#####",
    a: ".....|.....|.###.|....#|.####|#...#|.####", c: ".....|.....|.###.|#....|#....|#...#|.###.",
    d: "....#|....#|.####|#...#|#...#|#...#|.####", e: ".....|.....|.###.|#...#|#####|#....|.###.",
    h: "#....|#....|#.##.|##..#|#...#|#...#|#...#", i: ".#.|...|##.|.#.|.#.|.#.|###",
    k: "#....|#....|#..#.|#.#..|##...|#.#..|#..#.", l: "##.|.#.|.#.|.#.|.#.|.#.|###",
    m: ".....|.....|##.#.|#.#.#|#.#.#|#.#.#|#.#.#", n: ".....|.....|#.##.|##..#|#...#|#...#|#...#",
    o: ".....|.....|.###.|#...#|#...#|#...#|.###.", p: ".....|####.|#...#|#...#|####.|#....|#....",
    r: ".....|.....|#.##.|##..#|#....|#....|#....", s: ".....|.....|.####|#....|.###.|....#|####.",
    t: ".#...|.#...|###..|.#...|.#...|.#..#|..##.", u: ".....|.....|#...#|#...#|#...#|#..##|.##.#",
    y: ".....|#...#|#...#|.####|....#|#...#|.###.", v: ".....|.....|#...#|#...#|#...#|.#.#.|..#..",
    0: ".###.|#...#|#..##|#.#.#|##..#|#...#|.###.", 1: "..#..|.##..|..#..|..#..|..#..|..#..|.###.",
    2: ".###.|#...#|....#|...#.|..#..|.#...|#####", 3: "####.|....#|....#|.###.|....#|....#|####.",
    4: "...#.|..##.|.#.#.|#..#.|#####|...#.|...#.", 5: "#####|#....|####.|....#|....#|#...#|.###.",
    6: ".###.|#....|#....|####.|#...#|#...#|.###.", 7: "#####|....#|...#.|..#..|.#...|.#...|.#...",
    8: ".###.|#...#|#...#|.###.|#...#|#...#|.###.", 9: ".###.|#...#|#...#|.####|....#|....#|.###.",
    ".": "..|..|..|..|..|##|##", ",": "..|..|..|..|##|.#|#.", "!": "##|##|##|##|##|..|##", "'": "##|.#|#.|..|..|..|..",
    ":": "..|##|##|..|##|##|..", "-": "....|....|....|####|....|....|....", "?": ".###.|#...#|....#|...#.|..#..|.....|..#..",
    ">": "#....|.#...|..#..|...#.|..#..|.#...|#....", _: ".....|.....|.....|.....|.....|.....|#####",
    "$": "..#..|.####|#.#..|.###.|..#.#|####.|..#..", "/": "....#|....#|...#.|..#..|.#...|#....|#....",
    " ": "...|...|...|...|...|...|...", "♥": ".#.#.|#####|#####|#####|.###.|..#..|.....",
  };
  const FONT = {};
  for (const [k, v] of Object.entries(FONT_SRC)) { const rows = v.split("|"); FONT[k] = { w: rows[0].length, rows }; }
  const glyph = (ch) => FONT[ch] || FONT[ch.toUpperCase()] || FONT[" "];
  function bigWidth(str, sx = 1, gap = 1, gapPx) { const adv = gapPx ?? gap * sx; let w = 0; for (const ch of str) w += glyph(ch).w * sx + adv; return w - adv; }

  // ---------- the grid ----------
  const BOX = { single: "┌┐└┘─│", round: "╭╮╰╯─│", double: "╔╗╚╝═║", heavy: "┏┓┗┛━┃" };
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  class Grid {
    constructor(stage) {
      this.el = document.createElement("div");
      this.el.className = "grid";
      stage.appendChild(this.el);
      this.rowEls = [];
      this.prev = [];
      for (let y = 0; y < ROWS; y++) {
        const r = document.createElement("div");
        r.className = "row";
        r.style.top = `${y * CH}px`;
        this.el.appendChild(r);
        this.rowEls.push(r);
        this.prev.push(null);
      }
      const n = COLS * ROWS;
      this.ch = new Array(n); this.fg = new Array(n); this.bg = new Array(n); this.b = new Uint8Array(n);
      this.pt = new Array(n); this.pb = new Array(n);
      this.clear();
    }
    clear(bg = null) {
      for (let i = 0; i < this.ch.length; i++) { this.ch[i] = " "; this.fg[i] = C.cream; this.bg[i] = bg; this.b[i] = 0; this.pt[i] = undefined; this.pb[i] = undefined; }
    }
    idx(x, y) { x = Math.floor(x); y = Math.floor(y); return x < 0 || y < 0 || x >= COLS || y >= ROWS ? -1 : y * COLS + x; }
    /** One cell. fg/bg undefined keep what is there; bg null is see-through. */
    put(x, y, ch, fg, bg, bold) {
      const i = this.idx(x, y); if (i < 0) return;
      this.ch[i] = ch; if (fg !== undefined) this.fg[i] = fg; if (bg !== undefined) this.bg[i] = bg;
      this.b[i] = bold ? 1 : 0; this.pt[i] = undefined; this.pb[i] = undefined;
    }
    text(x, y, str, fg, bg, bold) { let i = 0; for (const ch of str) this.put(x + i++, y, ch, fg, bg, bold); return i; }
    /** Text with {o}color{c}switches, see KEY. */
    rich(x, y, str, maxW = 999, bg) {
      let fg = C.cream, n = 0;
      for (let k = 0; k < str.length; k++) {
        if (str[k] === "{" && str[k + 2] === "}") { fg = KEY[str[k + 1]] || fg; k += 2; continue; }
        if (n < maxW) this.put(x + n, y, str[k], fg, bg);
        n++;
      }
      return n;
    }
    center(y, str, fg, bg, bold, x0 = 0, w = COLS) { const x = x0 + Math.floor((w - [...str].length) / 2); this.text(x, y, str, fg, bg, bold); return x; }
    fill(x, y, w, h, ch, fg, bg) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.put(x + i, y + j, ch, fg, bg); }
    rect(x, y, w, h, bg) { this.fill(x, y, w, h, " ", undefined, bg); }
    box(x, y, w, h, o = {}) {
      const s = BOX[o.style || "single"], fg = o.fg || C.line;
      if (w < 2 || h < 2) return;
      if (o.bg !== undefined) this.rect(x + 1, y + 1, w - 2, h - 2, o.bg);
      for (let i = 1; i < w - 1; i++) { this.put(x + i, y, s[4], fg, o.bbg); this.put(x + i, y + h - 1, s[4], fg, o.bbg); }
      for (let j = 1; j < h - 1; j++) { this.put(x, y + j, s[5], fg, o.bbg); this.put(x + w - 1, y + j, s[5], fg, o.bbg); }
      this.put(x, y, s[0], fg, o.bbg); this.put(x + w - 1, y, s[1], fg, o.bbg);
      this.put(x, y + h - 1, s[2], fg, o.bbg); this.put(x + w - 1, y + h - 1, s[3], fg, o.bbg);
      if (o.title) this.text(x + 2, y, ` ${o.title} `.slice(0, Math.max(0, w - 4)), o.titleFg || fg, o.titleBg ?? o.bbg, true);
    }
    // Half-block pixels: 96 x 54, each 20 x 20 px.
    px(x, y, c) {
      x = Math.floor(x); y = Math.floor(y);
      if (x < 0 || y < 0 || x >= COLS || y >= ROWS * 2) return;
      const i = (y >> 1) * COLS + x;
      if (this.pt[i] === undefined && this.pb[i] === undefined) { this.pt[i] = null; this.pb[i] = null; }
      if (y & 1) this.pb[i] = c; else this.pt[i] = c;
    }
    pxRect(x, y, w, h, c) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.px(x + i, y + j, c); }
    /** Rows of chars, each looked up in pal; "." and missing keys are see-through. */
    sprite(x, y, rows, pal, sx = 1, sy = 1) {
      rows.forEach((r, j) => { for (let i = 0; i < r.length; i++) { const c = pal[r[i]]; if (c) this.pxRect(x + i * sx, y + j * sy, sx, sy, c); } });
    }
    /** Big 5x7 text in pixels. color: a color or (i, ch) => color|null. yoff: (i) => pixel offset. */
    big(x, y, str, o = {}) {
      const sx = o.sx || 1, sy = o.sy || 1, gap = o.gap ?? 1, adv = o.gapPx ?? gap * sx;
      const chars = [...str];
      const passes = o.shadow ? ["s", "f"] : ["f"];
      for (const pass of passes) {
        let cx = x;
        chars.forEach((ch, i) => {
          const gl = glyph(ch);
          let col = typeof o.color === "function" ? o.color(i, ch) : o.color || C.or;
          if (pass === "s") col = col ? (typeof o.shadow === "function" ? o.shadow(i, ch) : o.shadow) : null;
          const oy = o.yoff ? o.yoff(i) : 0, ox = o.xoff ? o.xoff(i) : 0;
          if (col) {
            const dx = pass === "s" ? o.sdx ?? 1 : 0, dy = pass === "s" ? o.sdy ?? 1 : 0;
            gl.rows.forEach((r, j) => { for (let k = 0; k < r.length; k++) if (r[k] === "#") this.pxRect(cx + ox + k * sx + dx, y + oy + j * sy + dy, sx, sy, col); });
          }
          cx += gl.w * sx + adv;
        });
      }
      return bigWidth(str, sx, gap, o.gapPx);
    }
    bigCenter(y, str, o = {}) { const wd = bigWidth(str, o.sx || 1, o.gap ?? 1, o.gapPx) + (o.shadow ? o.sdx ?? 1 : 0); return this.big(Math.floor((COLS - wd) / 2) + (o.dx || 0), y, str, o); }
    /** Blanks every cell outside the rectangle, for letterboxing. */
    keepOnly(x0, y0, x1, y1, bg = C.bg) {
      for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) if (x < x0 || x >= x1 || y < y0 || y >= y1) this.put(x, y, " ", C.cream, bg);
    }
    render() {
      for (let y = 0; y < ROWS; y++) {
        let html = "", key = null, run = "", style = "";
        const flush = () => { if (run) html += `<span style="width:${run.length * 20}px${style ? ";" + style : ""}">${esc(run)}</span>`; run = ""; };
        for (let x = 0; x < COLS; x++) {
          const i = y * COLS + x;
          let k, st, ch;
          if (this.pt[i] !== undefined) {
            const top = this.pt[i] || this.bg[i] || "transparent", bot = this.pb[i] || this.bg[i] || "transparent";
            ch = " ";
            if (top === bot) { k = "b" + top; st = top === "transparent" ? "" : `background:${top}`; }
            else { k = "h" + top + bot; st = `background:linear-gradient(${top} 50%,${bot} 50%)`; }
          } else if (this.ch[i] === "█") {
            ch = " "; k = "b" + this.fg[i]; st = `background:${this.fg[i]}`;
          } else if (this.ch[i] === " " && key && key[0] === "t" && key.endsWith("|" + (this.bg[i] || ""))) {
            run += " "; continue; // a space joins the text run with its background
          } else if (this.ch[i] === " ") {
            ch = " "; const bg = this.bg[i]; k = "b" + (bg || "transparent"); st = bg ? `background:${bg}` : "";
          } else {
            ch = this.ch[i]; const bg = this.bg[i] || "";
            k = "t" + this.fg[i] + "|" + this.b[i] + "|" + bg;
            st = `color:${this.fg[i]}${bg ? `;background:${bg}` : ""}${this.b[i] ? ";font-weight:700" : ""}`;
          }
          if (k !== key) { flush(); key = k; style = st; }
          run += ch;
        }
        flush();
        if (html !== this.prev[y]) { this.rowEls[y].innerHTML = html; this.prev[y] = html; }
      }
    }
  }

  // ---------- chrome: the lyric line and the tmux-style status bar ----------
  const SECTIONS = [[0, "intro"], [5, "panes"], [7, "alerts"], [9, "chorus"], [13, "stack"], [17, "chat"], [20, "CHORUS"], [24, ".sh"], [25, "outro"]];
  function lyricAt(ft) {
    let cur = null;
    LINES.forEach((l, i) => {
      const next = LINES[i + 1];
      const on = l.start - 0.3, off = Math.min(next ? next.start - 0.3 : 99, l.end + 1.4);
      if (ft >= on && ft < off) cur = l;
    });
    return cur;
  }
  function lyric(g, ft, y = 25) {
    g.rect(0, y, COLS, 1, C.bg);
    const l = lyricAt(ft);
    if (!l) return;
    const pre = l.voice === "her" ? "her ▸ " : l.voice === "him" ? "him ▸ " : "♪ ";
    const preFg = l.voice === "her" ? C.pink : l.voice === "him" ? C.teal : C.or;
    const text = l.words.map((x) => x.text).join(" ");
    let x = Math.floor((COLS - pre.length - text.length) / 2);
    x += g.text(x, y, pre, preFg, C.bg, true);
    l.words.forEach((wd, i) => {
      const next = l.words[i + 1];
      const until = next ? next.start : wd.end + 0.25;
      let fg = C.dim, bg = C.bg, bold = false;
      if (ft >= wd.start && ft < until) { fg = C.bg; bg = C.or; bold = true; }
      else if (ft >= wd.start) { fg = C.cream; }
      x += g.text(x, y, wd.text, fg, bg, bold);
      if (next) x += g.text(x, y, " ", C.dim, C.bg);
    });
  }
  function status(g, ft, y = 26) {
    g.rect(0, y, COLS, 1, C.ink2);
    let x = g.text(0, y, " dor ", C.bg, C.or, true);
    const bar = beat(ft).bar;
    let cur = 0;
    SECTIONS.forEach(([b], i) => { if (bar >= b) cur = i; });
    x += 1;
    SECTIONS.forEach(([, name], i) => {
      const label = `${i}:${name}${i === cur ? "*" : ""}`;
      x += g.text(x, y, label, i === cur ? C.bg : C.dim, i === cur ? C.cream : C.ink2, i === cur) + 1;
    });
    const b = beat(ft);
    const dots = [0, 1, 2, 3].map((i) => (b.n >= 0 && i === b.inBar ? "●" : "○")).join("");
    const secs = Math.max(0, Math.floor(ft));
    const clock = ` ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")} `;
    const right = `♪ ${dots} `;
    g.text(COLS - clock.length - right.length, y, right, C.cream, C.ink2);
    g.text(COLS - clock.length, y, clock, C.bg, C.or, true);
  }

  // ---------- running a scene ----------
  /** Draws every frame of a scene from its time alone: a tween drives a getter/setter, so a seek always redraws. */
  function run(sc, draw, o = {}) {
    const g = new Grid(sc.stage);
    let cur = -1;
    const frame = (t) => {
      g.clear();
      const ft = sc.start + t;
      draw(g, ft, t);
      if (!o.noLyric) lyric(g, ft);
      if (!o.noStatus) status(g, ft);
      g.render();
    };
    const proxy = { t(v) { if (v === undefined) return cur; cur = v; frame(v); } };
    frame(0);
    sc.tl.fromTo(proxy, { t: 0 }, { t: sc.dur, duration: sc.dur, ease: "none", immediateRender: false }, 0);
    window.__timelines[sc.id] = sc.tl;
    return g;
  }

  // ---------- the mouse, drawn from shapes at any scale ----------
  const memo = {};
  /** A pixel bitmap of the mascot: k pixels per design unit; the design is 24 units wide. */
  function mouseBitmap(k = 1, o = {}) {
    const key = JSON.stringify([k, o]);
    if (memo[key]) return memo[key];
    const W = Math.round(24 * k), H = Math.round(27 * k);
    // Shapes, back to front: [layer, test(x, y), color]. Design units, x centered on 0, y from 0 at the top.
    const ell = (cx, cy, rx, ry) => (x, y) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
    const shapes = [];
    if (o.mullet) shapes.push([0, ell(0, 16.5, 9.4, 7), C.hair]);
    shapes.push([1, ell(-6.8, 5, 4.6, 4.6), C.or], [1, ell(6.8, 5, 4.6, 4.6), C.or]);
    shapes.push([2, ell(0, 20.5, 5.6, 5.2), C.or]);
    shapes.push([3, ell(0, 11, 7.6, 6.2), C.or]);
    if (o.mullet) shapes.push([4, (x, y) => y >= 3.6 && y < 6.6 && Math.abs(x) < 5.2 - (6.6 - y) * 0.4, C.hair]);
    const at = (x, y) => { let hitS = null; for (const s of shapes) if (s[1](x, y)) hitS = s; return hitS; };
    const px = [];
    for (let j = 0; j < H; j++) {
      px.push([]);
      for (let i = 0; i < W; i++) {
        const x = (i + 0.5) / k - 12, y = (j + 0.5) / k;
        const s = at(x, y);
        px[j].push(s ? { l: s[0], c: s[2] } : null);
      }
    }
    // Outline: an empty pixel touching a shape, or a back pixel touching a front one.
    const out = px.map((r) => r.map((p) => (p ? p.c : null)));
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const p = px[j][i];
      const nb = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([a, b]) => (px[j + b] || [])[i + a]);
      if (!p && nb.some((q) => q)) out[j][i] = C.brown;
      else if (p && nb.some((q) => q && q.l > p.l && !(q.l === 4 && p.l === 3))) out[j][i] = C.brown;
    }
    // Ear insides, belly, face: painted in design units.
    const paint = (test, c) => { for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) { const x = (i + 0.5) / k - 12, y = (j + 0.5) / k; if (px[j][i] && out[j][i] !== C.brown && test(x, y)) out[j][i] = c; } };
    paint((x, y) => px[Math.floor(y * k)][Math.floor((x + 12) * k)].l === 1 && (ell(-6.8, 5.4, 2.6, 2.6)(x, y) || ell(6.8, 5.4, 2.6, 2.6)(x, y)), C.pink);
    paint((x, y) => px[Math.floor(y * k)][Math.floor((x + 12) * k)].l === 2 && ell(0, 21.4, 3.4, 3.4)(x, y), C.cream);
    const rectU = (x0, y0, x1, y1, c) => paint((x, y) => x >= x0 && x < x1 && y >= y0 && y < y1, c);
    if (o.shades) { rectU(-5.5, 9, -0.6, 11, C.bg); rectU(0.6, 9, 5.5, 11, C.bg); rectU(-0.6, 9, 0.6, 9.6, C.bg); }
    else if (o.blink) { rectU(-4.6, 10, -2.6, 11, C.brown); rectU(2.6, 10, 4.6, 11, C.brown); }
    else { rectU(-4.4, 8.6, -2.8, 11, C.bg); rectU(2.8, 8.6, 4.4, 11, C.bg); if (k >= 2) { rectU(-4.4, 8.6, -3.6, 9.4, C.white); rectU(2.8, 8.6, 3.6, 9.4, C.white); } }
    rectU(-6.6, 12, -4.8, 13, C.pink); rectU(4.8, 12, 6.6, 13, C.pink);
    rectU(-1, 12, 1, 13, C.brown);
    if (o.open) rectU(-1.4, 13.6, 1.4, 15.4, C.brown);
    else { rectU(-2, 14, -1, 15, C.brown); rectU(1, 14, 2, 15, C.brown); rectU(-1, 15, 1, 16, C.brown); }
    const bm = { w: W, h: H, px: out };
    memo[key] = bm;
    return bm;
  }
  /** Draws the mouse with its top-left at pixel (x, y), plus a tail that curls on the beat. */
  function mouse(g, x, y, o = {}) {
    const k = o.k || 1;
    const bm = mouseBitmap(k, { blink: !!o.blink, mullet: !!o.mullet, shades: !!o.shades, open: !!o.open });
    // Tail behind the body, to the right.
    const sway = o.sway || 0;
    for (let s = 0; s <= 10; s++) {
      const u = s / 10;
      const tx = x + Math.round((17 + u * 6) * k), ty = y + Math.round((24 - u * 6 + Math.sin(u * 3 + sway) * 2) * k);
      g.pxRect(tx, ty, Math.max(1, Math.round(k * 0.8)), Math.max(1, Math.round(k * 0.8)), C.brown);
    }
    for (let j = 0; j < bm.h; j++) for (let i = 0; i < bm.w; i++) { const c = bm.px[j][i]; if (c) g.px(x + i, y + j, c); }
    return bm;
  }

  // ---------- fake terminal output ----------
  const FILES = ["src/panes/split.ts", "src/alerts/bell.ts", "lib/lath/tree.ts", "src/dor/await.ts", "src/app.tsx", "src/theme.css", "src/remote/pair.ts", "docs/flow.md", "src/tools/mullet.ts", "test/split.test.ts"];
  const CODE = ["export function splitRight(pane) {", "  return lath.split(pane, 'right');", "const alert = bell.ring(pane.id);", "await dor.await({ idle: true });", "if (pane.needsYou) notify(pane);", "  panes.push(tail);", "return <Wall panes={panes} />;", "const flow = [split, ensure, await];", "  mouse.click(pane.header);", "export default multitask;"];
  function agentLines(seed, n) {
    const out = [];
    for (let i = 0; i < n; i++) {
      const r = hash(seed, i), f = FILES[Math.floor(hash(seed, i, 1) * FILES.length)], c = CODE[Math.floor(hash(seed, i, 2) * CODE.length)];
      const k = Math.floor(r * 9);
      if (k === 0) out.push(`{o}● {c}Read {b}${f}`);
      else if (k === 1) out.push(`{o}● {c}Edit {b}${f}`);
      else if (k === 2) out.push(`{d}  └ {l}+${2 + Math.floor(hash(seed, i, 3) * 40)} {r}-${Math.floor(hash(seed, i, 4) * 9)}`);
      else if (k === 3 || k === 4) out.push(`{l}  + {c}${c}`);
      else if (k === 5) out.push(`{r}  - {d}${c}`);
      else if (k === 6) out.push(`{o}● {c}Bash{d}(pnpm test)`);
      else if (k === 7) out.push(`{d}  └ {l}✓ ${100 + Math.floor(hash(seed, i, 5) * 300)} passed`);
      else out.push(`{y}* {d}Thinking…`);
    }
    return out;
  }
  function devLines(seed, n) {
    const out = ["{d}$ {c}pnpm dev", "", "{l}  VITE v7.1 {d}ready in {c}212 ms", "{d}  ➜ {c}Local: {t}http://localhost:5173/"];
    const paths = ["/", "/src/app.tsx", "/src/panes/split.ts", "/@vite/client", "/src/theme.css", "/assets/mouse.svg", "/api/panes", "/src/alerts/bell.ts"];
    for (let i = 0; i < n; i++) {
      const p = paths[Math.floor(hash(seed, i) * paths.length)], ms = 1 + Math.floor(hash(seed, i, 1) * 40);
      const k = hash(seed, i, 2);
      if (k < 0.18) out.push(`{d}${String(9 + (i % 3)).padStart(2, "0")}:4${i % 10} {t}[vite] {l}hmr update {c}${p}`);
      else out.push(`{d}GET {c}${p} {l}200 {d}${ms}ms`);
    }
    return out;
  }
  /** The last h lines of `lines` once `n` of them have printed; a fractional n types the newest line. */
  function stream(g, x, y, w, h, lines, n, bg) {
    const shown = Math.max(0, Math.min(lines.length, Math.floor(n)));
    const first = Math.max(0, shown - h);
    for (let j = 0; j < h && first + j < shown; j++) g.rich(x, y + j, lines[first + j], w, bg);
  }
  const SPIN = "▖▘▝▗";
  const spin = (ft, speed = 12, off = 0) => SPIN[(Math.floor(ft * speed) + off) % SPIN.length];

  /** A titled pane with output streaming into it. */
  function pane(g, x, y, w, h, o = {}) {
    const bc = o.border || (o.focus ? C.or : C.line);
    g.box(x, y, w, h, { style: o.focus ? "heavy" : o.style || "single", fg: bc, bg: o.bg ?? C.bg, title: o.title, titleFg: o.titleFg || (o.focus ? C.or : C.cream), titleBg: o.titleBg });
    if (o.badge) g.text(x + w - o.badge.length - 2, y, o.badge, o.badgeFg || C.bg, o.badgeBg || C.yel, true);
    if (o.lines) stream(g, x + 2, y + 1, w - 4, h - 2, o.lines, o.n || 0);
  }

  // ---------- frames: VS Code, a plain window, a laptop, a phone, a browser ----------
  /** A small three-pane Dormouse layout, streaming. */
  function miniPanes(g, x, y, w, h, ft, seed = 1, o = {}) {
    const lw = Math.floor(w / 2), th = Math.max(3, Math.floor(h * 0.62));
    const L = agentLines(seed, 200), R = agentLines(seed + 7, 200), D = devLines(seed + 3, 200);
    const rate = o.rate || 6;
    pane(g, x, y, lw, th, { title: "agent", lines: L, n: 4 + ft * rate, focus: o.focusL, border: o.alertL ? C.yel : undefined });
    pane(g, x + lw, y, w - lw, th, { title: "agent", lines: R, n: 6 + ft * rate * 1.2, border: o.alertR ? C.yel : undefined });
    pane(g, x, y + th, w, h - th, { title: "dev", lines: D, n: 3 + ft * rate * 0.8 });
  }
  function vscode(g, x, y, w, h, ft) {
    g.rect(x, y, w, h, C.ink);
    g.rect(x, y, w, 1, C.ink2);
    g.text(x + 1, y, "≡", C.dim, C.ink2);
    g.center(y, "dormouse — Visual Studio Code", C.cream, C.ink2, false, x, w);
    g.rect(x, y + 1, 3, h - 2, C.ink2);
    ["⑂", "⌕", "▤", "◆"].forEach((c, i) => g.put(x + 1, y + 2 + i * 2, c, i === 3 ? C.or : C.dim, C.ink2));
    g.text(x + 3, y + 1, " app.tsx  ", C.dim, C.ink);
    g.text(x + 13, y + 1, " ◆ Dormouse × ", C.cream, C.bg, true);
    miniPanes(g, x + 3, y + 2, w - 3, h - 3, ft, 11);
    g.rect(x, y + h - 1, w, 1, C.blue);
    g.text(x + 1, y + h - 1, "⎇ main  ✓ 0  ⚠ 0", C.bg, C.blue);
  }
  function appWindow(g, x, y, w, h, ft, title = "Dormouse") {
    g.box(x, y, w, h, { style: "round", fg: C.line, bg: C.bg });
    g.rect(x + 1, y + 1, w - 2, 1, C.ink2);
    g.put(x + 2, y + 1, "●", C.red, C.ink2); g.put(x + 4, y + 1, "●", C.yel, C.ink2); g.put(x + 6, y + 1, "●", C.lime, C.ink2);
    g.center(y + 1, title, C.cream, C.ink2, true, x, w);
    miniPanes(g, x + 1, y + 2, w - 2, h - 3, ft, 23);
  }
  function laptop(g, x, y, w, h, ft) {
    g.box(x, y, w, h - 1, { style: "round", fg: C.line, bg: C.ink });
    miniPanes(g, x + 2, y + 1, w - 4, h - 3, ft, 31);
    // The base: a keyboard deck, a little wider than the screen.
    g.rect(x - 3, y + h - 1, w + 6, 1, C.tile);
    for (let i = 0; i < w + 2; i += 2) g.put(x - 2 + i, y + h - 1, "▪", C.line, C.tile);
    g.pxRect(x - 4, (y + h) * 2, w + 8, 1, C.line);
    g.pxRect(x + Math.floor(w / 2) - 6, (y + h) * 2, 12, 1, C.dim);
  }
  function phone(g, x, y, w, h, ft, o = {}) {
    g.box(x, y, w, h, { style: "round", fg: o.frame || C.cream, bg: C.ink });
    g.text(x + Math.floor(w / 2) - 2, y, "▬▬▬▬", o.frame || C.cream);
    if (o.content) o.content(x + 1, y + 1, w - 2, h - 2);
    else {
      const L = agentLines(41, 200);
      g.rect(x + 1, y + 1, w - 2, 1, C.or);
      g.text(x + 2, y + 1, "agent", C.bg, C.or, true);
      stream(g, x + 1, y + 2, w - 2, h - 5, L, 6 + ft * 5);
      g.rect(x + 1, y + h - 3, w - 2, 2, C.ink2);
      g.text(x + 2, y + h - 3, "▸ type…", C.dim, C.ink2);
    }
  }
  function browser(g, x, y, w, h, url, o = {}) {
    g.box(x, y, w, h, { style: "round", fg: o.frame || C.blue, bg: C.cream });
    g.rect(x + 1, y + 1, w - 2, 1, C.ink2);
    g.text(x + 2, y + 1, "◀ ▶ ↻ ", C.dim, C.ink2);
    g.text(x + 8, y + 1, ` ${url} `.padEnd(Math.max(0, w - 10)), C.cream, C.ink, false);
  }

  // ---------- effects ----------
  /** Characters thrown upward from the bottom and falling back, a pure function of time. */
  function confetti(g, ft, t0, o = {}) {
    const n = o.n || 60, chars = o.chars || "*+✶✦•◆♥▪", dur = o.dur || 2.2;
    for (let i = 0; i < n; i++) {
      const born = t0 + hash(i, 7) * (o.spread ?? 0.5);
      const age = ft - born;
      if (age < 0 || age > dur) continue;
      const x0 = (o.x0 ?? 0) + hash(i, 1) * (o.w ?? COLS), vx = (hash(i, 2) - 0.5) * 30, vy = -(14 + hash(i, 3) * 22);
      const x = x0 + vx * age, y = (o.y0 ?? 25) + vy * age + 18 * age * age;
      if (y < 0 || y >= (o.yMax ?? 25)) continue;
      g.put(x, y, chars[Math.floor(hash(i, 4) * chars.length)], RAINBOW[(i + Math.floor(ft * 8)) % RAINBOW.length], undefined, true);
    }
  }
  /** Bars that jump on each beat: two columns wide, one apart. */
  function eq(g, ft, x, y, w, h, o = {}) {
    const b = beat(ft), p = pulse(ft, o.decay || 0.5);
    const n = Math.floor((w + 1) / 3), H = h * 2;
    for (let i = 0; i < n; i++) {
      const idle = 0.12 + 0.12 * (0.5 + 0.5 * Math.sin(i * 1.3 + ft * 5));
      const kick = (0.25 + 0.6 * hash(b.n, i)) * p * (o.gain || 1) + (b.inBar === 0 ? 0.12 * p : 0);
      const lv = Math.round(clamp(idle + kick) * H);
      for (let j = 0; j < lv; j++) {
        const f = j / H;
        const c = o.color ? o.color(i, f) : f < 0.35 ? C.or : f < 0.6 ? C.yel : f < 0.8 ? C.lime : C.teal;
        g.pxRect(x + i * 3, y * 2 + H - 1 - j, 2, 1, c);
      }
    }
  }


  // ---------- the train: parallax hills, telegraph poles, a Dormouse-orange carriage, and a mouse on its phone ----------
  function train(g, ft, o = {}) {
    const SKY = ["#2b2638", "#2f2a3c", "#352d40", "#3d3143", "#463545", "#4f3a46"];
    for (let py = 0; py < 36; py++) g.pxRect(0, py, COLS, 1, SKY[Math.min(SKY.length - 1, Math.floor(py / 6))]);
    for (let i = 0; i < 18; i++) g.px(Math.floor(hash(i, 9) * COLS), Math.floor(hash(i, 8) * 14), i % 3 ? C.line : C.cream);
    // Far hills scroll slowly, near hills faster.
    for (let x = 0; x < COLS; x++) {
      const u = x + ft * 6, v = x + ft * 18;
      const far = 22 + Math.round(4 * Math.sin(u * 0.09) + 2 * Math.sin(u * 0.23));
      for (let py = far; py < 36; py++) g.px(x, py, "#3a3146");
      const near = 29 + Math.round(3 * Math.sin(v * 0.13 + 1) + 1.5 * Math.sin(v * 0.31));
      for (let py = near; py < 36; py++) g.px(x, py, "#2a2430");
    }
    g.rect(0, 18, COLS, 7, C.ink);
    // Telegraph poles and their wire rush past.
    for (let x = 0; x < COLS; x++) { const sag = Math.round(Math.cos(((x + ft * 70) % 40) / 40 * Math.PI * 2) * 0.8); g.px(x, 7 + sag, C.line); }
    for (let i = 0; i < 4; i++) {
      const x = Math.floor(((i * 40 - ft * 70) % 160 + 160) % 160) - 20;
      for (let py = 6; py < 36; py++) g.px(x, py, "#6b5a4c");
      g.pxRect(x - 2, 6, 5, 1, "#6b5a4c");
    }
    // The carriage.
    const X0 = 3, X1 = 93, bounce = beat(ft).inBar % 2 && pulse(ft, 0.15) > 0.3 ? 1 : 0;
    const top = 19 + bounce;
    g.pxRect(X0 + 1, top, X1 - X0 - 2, 1, C.ord);
    g.pxRect(X0, top + 1, X1 - X0, 15, C.or);
    g.pxRect(X0, top + 16, X1 - X0, 1, C.cream);
    g.pxRect(X0, top + 17, X1 - X0, 2, C.ord);
    // Windows, and one with the mouse in it.
    const wins = [[7, 14], [24, 22], [49, 14], [66, 14], [83, 6]];
    wins.forEach(([wx, ww], i) => {
      g.pxRect(wx, top + 3, ww, 9, "#33404d");
      g.pxRect(wx, top + 3, ww, 1, "#46586a");
      if (i !== 1) for (let k = 0; k < 3; k++) g.px(wx + 2 + k + ((Math.floor(ft * 2) + i) % 4), top + 9 - k, "#56697c");
    });
    const mx = 30, my = top + 3;
    mouse(g, mx, my, { k: 0.5, blink: ft % 2.7 < 0.12, sway: ft * 5 });
    // Phone in both hands, thumbs tapping.
    g.pxRect(24, top + 12, 22, 4, C.or);
    g.pxRect(mx + 9, my + 4, 4, 5, C.ink);
    g.pxRect(mx + 10, my + 5, 2, 3, C.teal);
    const tap = Math.floor(ft * 6) % 2;
    g.px(mx + 9 + (tap ? 0 : 1), my + 7, C.or2); g.px(mx + 12 - (tap ? 1 : 0), my + 7, C.or2);
    g.text(X0 + 4, Math.floor((top + 16) / 2) - 1, " DORMOUSE EXPRESS ", C.or, C.cream, true);
    // Wheels, rails, sleepers rushing by.
    for (let i = 0; i < 8; i++) g.put(X0 + 6 + i * 12, 18, "◉◎"[Math.floor(ft * 10 + i) % 2], C.cream, C.ink);
    g.fill(0, 19, COLS, 1, "═", C.dim, C.ink);
    for (let x = 0; x < COLS; x++) if (((x + Math.floor(ft * 50)) % 5) === 0) g.put(x, 20, "▀", C.line, C.ink);
    for (let i = 0; i < 12; i++) { const x = Math.floor(((hash(i, 3) * 120 - ft * 90) % 120 + 120) % 120) - 10; g.text(x, 21 + (i % 4), "────", C.ink2); }
  }

  window.A = {
    COLS, ROWS, C, RAINBOW, KEY, Grid, run, clamp, seg, lerp, outCubic, inCubic, outBack, hash,
    beatAt, barAt, beat, pulse, hit, line, w, typed, bigWidth, glyph,
    mouse, mouseBitmap, agentLines, devLines, stream, spin, pane, miniPanes, vscode, appWindow, laptop, phone, browser, confetti, eq, lyric, status, train,
  };
})();

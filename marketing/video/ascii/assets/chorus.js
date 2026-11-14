// The chorus, drawn once for both choruses. Each line is two "Dormouse," hits (the title) and then its tag line (a picture).
// hype = the second chorus: rainbow letters, confetti, twice the panes, giant letters. Escalate, don't repeat.
(function () {
  const { C, RAINBOW, seg, outBack, outCubic, lerp, hit, clamp, hash, beat } = A;
  const memo = {};
  function phases(ids) {
    const key = ids.join();
    if (memo[key]) return memo[key];
    memo[key] = ids.map((id, i) => {
      const l = A.line(id);
      return { id, i, l, words: l.words, h1: l.words[0].start, h2: l.words[1].start, tag: l.words[2].start };
    });
    return memo[key];
  }
  const rb = (i, ft, speed = 6) => RAINBOW[(((i + Math.floor(ft * speed)) % RAINBOW.length) + RAINBOW.length) % RAINBOW.length];

  /** Twinkling dots in the background, for the second chorus. */
  function stars(g, ft) {
    for (let i = 0; i < 70; i++) {
      const x = Math.floor(hash(i, 1) * A.COLS), speed = 2 + hash(i, 2) * 5;
      const y = Math.floor((hash(i, 3) * 25 + ft * speed) % 25);
      g.put(x, y, "·+*"[i % 3], i % 4 ? C.line : rb(i, ft, 3));
    }
  }

  function title(g, ft, p, hype) {
    if (hype) stars(g, ft);
    const second = ft >= p.h2;
    const color = (i) => (hype ? rb(i, ft) : second ? C.cream : C.or);
    const shadow = hype ? C.brown : second ? C.or : C.ord;
    const yoff = (i) => {
      const t0 = p.h1 + i * 0.025;
      const drop = -Math.round((1 - outBack(seg(ft, t0, t0 + 0.2))) * 18);
      const bounce = -Math.round(2 * hit(ft, p.h2 + i * 0.02, 0.25));
      const wave = hype ? Math.round(Math.sin(ft * 8 + i * 0.9) * 1.5) : 0;
      return drop + bounce + wave;
    };
    // A parade of tiny mice, one more on each hit.
    const n = (hype ? 4 : 2) * (second ? 2 : 1);
    const b = beat(ft);
    for (let k = 0; k < n; k++) {
      const x = Math.floor(((k + 0.5) * A.COLS) / n) - 3;
      g.text(x, 3 + ((b.n + k) % 2), "<:3 )~", hype ? rb(k, ft, 4) : C.or, undefined, true);
    }
    g.bigCenter(16, "DORMOUSE", { sx: 2, sy: 2, color, shadow, yoff });
    A.eq(g, ft, 1, 17, 95, 6, hype ? { gain: 1.3, color: (i, f) => rb(i + Math.floor(f * 4), ft, 4) } : {});
    if (hype) { A.confetti(g, ft, p.h1, { n: 50, y0: 16 }); A.confetti(g, ft, p.h2, { n: 50, y0: 16 }); }
  }

  /** "multitask more": panes double every few frames, then all finish at once. */
  function multitask(g, ft, p, hype) {
    const t0 = p.tag, tMore = p.words[3].start;
    const steps = hype ? [4, 8, 16, 32, 64] : [2, 4, 8, 16, 32];
    const n = steps[clamp(Math.floor((ft - t0) / 0.15), 0, steps.length - 1)];
    const cols = n >= 64 ? 16 : n >= 32 ? 8 : n >= 8 ? 4 : 2, rows = n / cols;
    const pw = Math.floor(A.COLS / cols), ph = Math.floor(25 / rows);
    const done = ft >= tMore;
    for (let j = 0; j < n; j++) {
      const x = (j % cols) * pw, y = Math.floor(j / cols) * ph;
      const fg = hype ? rb(j, ft, 5) : done ? C.lime : C.line;
      g.box(x, y, pw, ph, { fg, style: done && !hype ? "heavy" : "single" });
      if (ph >= 3 && pw >= 6) {
        g.put(x + 2, y + 1, done ? "✓" : A.spin(ft, 10, j), done ? C.lime : C.teal);
        if (pw >= 12) g.text(x + 4, y + 1, `agent ${j + 1}`.slice(0, pw - 6), C.cream);
        for (let r = 2; r < ph - 1; r++) { const len = Math.floor(hash(j, r, Math.floor(ft * 6)) * (pw - 5)); g.text(x + 2, y + r, "▪".repeat(Math.max(0, len)).slice(0, pw - 4), C.ink2); }
      }
    }
    const text = done ? "MULTITASK MORE" : "MULTITASK";
    const bw = A.bigWidth(text) + 6;
    const bx = Math.floor((A.COLS - bw) / 2);
    g.rect(bx, 10, bw, 6, hype ? C.cream : C.or);
    g.big(bx + 3, 22, text, { color: hype ? (i) => (i > 9 ? C.or : C.bg) : C.bg });
    if (hype) A.confetti(g, ft, tMore, { n: 80 });
  }

  /** "D-O-R spells dor": giant letters, then the command. */
  function spell(g, ft, p, hype) {
    const t0 = p.words[2].start, tSp = p.words[3].start, tDor = p.words[4].start;
    const subs = [t0, t0 + 0.19, t0 + 0.38];
    if (hype) stars(g, ft);
    if (ft < tDor) {
      const sx = hype ? 5 : 4, sy = hype ? 6 : 4;
      const wd = A.bigWidth("DOR", sx, 1);
      let x = Math.floor((A.COLS - wd) / 2);
      "DOR".split("").forEach((ch, i) => {
        if (ft >= subs[i]) {
          const drop = Math.round((1 - outBack(seg(ft, subs[i], subs[i] + 0.16))) * -20);
          const col = hype ? rb(i * 2, ft, 8) : [C.or, C.cream, C.yel][i];
          const dim = ft >= tSp ? 0.5 : 1;
          g.big(x, 2 + drop, ch, { sx, sy, color: dim < 1 && !hype ? C.cream : col, shadow: hype ? C.brown : C.ord, sdx: 1, sdy: 1 });
        }
        x += (5 + 1) * sx;
      });
      if (ft >= tSp) {
        const y = hype ? 11 : 17;
        g.rect(30, y, 36, 3, C.or);
        g.center(y + 1, "D + O + R  spells  ↓", C.bg, C.or, true);
      }
      return;
    }
    // `$ dor`, typed big, with its commands underneath.
    const sx = 3, sy = 4;
    const str = "$ dor";
    const wd = A.bigWidth(str, sx, 1);
    const x0 = Math.floor((A.COLS - wd - 6) / 2);
    const k = clamp(Math.floor((ft - tDor) / 0.06) + 3, 3, 5);
    g.big(x0, 3, str.slice(0, k), { sx, sy, color: (i) => (i === 0 ? C.dim : hype ? rb(i, ft, 8) : C.or), shadow: C.ord });
    if (Math.floor(ft * 3) % 2 === 0) g.pxRect(x0 + wd + 3, 3, sx * 4, 28, C.cream);
    const help = ["split", "ensure", "await", "send", "open", "tool", "reopen"];
    g.center(19, "usage: dor <command>", C.dim);
    let hx = Math.floor((A.COLS - help.join("   ").length) / 2);
    help.forEach((h, i) => { if (ft >= tDor + 0.08 + i * 0.05) g.text(hx, 21, h, hype ? rb(i, ft, 4) : C.cream, undefined, true); hx += h.length + 3; });
    if (hype) A.confetti(g, ft, tDor, { n: 90 });
  }

  /** "VS Code or standalone": both frames, side by side. */
  function hosts(g, ft, p, hype) {
    const tVS = p.words[2].start, tOr = p.words[4].start, tSt = p.words[5].start;
    const bob = (k) => (hype ? -Math.round(A.pulse(ft + k * 0.33, 0.2)) : 0);
    const xl = Math.round(lerp(-50, 1, outCubic(seg(ft, tVS - 0.05, tVS + 0.2))));
    A.vscode(g, xl, 1 + bob(0), 46, 20, ft);
    if (hype) A.confetti(g, ft, tSt, { n: 70, yMax: 22 });
    g.center(22, " VS Code ", C.bg, C.blue, true, xl, 46);
    if (ft >= tSt - 0.05) {
      const xr = Math.round(lerp(98, 49, outCubic(seg(ft, tSt - 0.05, tSt + 0.2))));
      A.appWindow(g, xr, 1 + bob(1), 46, 20, ft);
      g.center(22, " standalone ", C.bg, C.or, true, xr, 46);
    }
    if (ft >= tOr) { const s = hit(ft, tOr, 0.3); g.rect(45, 10, 6, 3, s > 0.3 ? C.yel : C.cream); g.text(47, 11, "or", C.bg, undefined, true); }
  }

  /** "from my laptop to my phone": the laptop, then the whole grid letterboxes down to a phone. */
  function phone(g, ft, p, hype) {
    const tFrom = p.words[2].start, tLap = p.words[4].start, tTo = p.words[5].start, tPh = p.words[7].start;
    const rise = outCubic(seg(ft, tFrom - 0.05, tFrom + 0.25));
    if (ft < tPh) {
      const y = Math.round(lerp(25, 1, rise));
      A.laptop(g, 18, y, 60, 21, ft);
      if (ft >= tLap && ft < tTo) g.center(23, " laptop ", C.bg, C.or, true);
      if (ft >= tTo) {
        const hw = Math.round(lerp(48, 13, outCubic(seg(ft, tTo, tPh))));
        g.keepOnly(48 - hw, 0, 48 + hw, 25);
        for (let y2 = 0; y2 < 25; y2++) { g.put(48 - hw - 1, y2, "▐", C.or); g.put(48 + hw, y2, "▌", C.or); }
      }
      return;
    }
    const k = outBack(seg(ft, tPh, tPh + 0.2));
    const h = Math.max(3, Math.round(23 * k));
    if (hype) stars(g, ft);
    A.phone(g, 36, 1 + Math.floor((23 - h) / 2), 24, h, ft, hype ? {
      frame: rb(0, ft, 6),
      content: (x, y, wd, hh) => { if (hh > 14) { A.mouse(g, x + 2, (y + 2) * 2, { k: 0.75, shades: true, sway: ft * 6 }); g.center(y + hh - 2, "DORMOUSE", C.or, undefined, true, x, wd); } },
    } : {});
    if (ft >= tPh) g.text(62, 12, "◂ phone", C.or, undefined, true);
    if (hype) A.confetti(g, ft, tPh, { n: 90 });
  }

  const TAGS = [multitask, spell, hosts, phone];
  A.chorus = function (g, ft, ids, hype) {
    const ps = phases(ids);
    let p = ps[0];
    for (const q of ps) if (ft >= q.l.start - 0.12) p = q;
    if (ft < p.tag - 0.03) title(g, ft, p, hype);
    else TAGS[p.i](g, ft, p, hype);
  };
})();

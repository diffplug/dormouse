// The film's art: a Dormouse window drawn in plain DOM, and the moves its panes make. Deterministic, so every render is identical.
(function () {
  const HEAD = 44, LH = 32, PAD = 12, GAP = 8;
  const WALL = { x: 8, y: 4, w: 1904, h: 860 }; // The room panes tile, inside .wall.
  const EASE = "expo.out", MOVE = 0.44; // The app's pane motion: 440 ms, exponential ease-out.
  const LOGO = "assets/logo.svg";

  // ---- Rectangles ----
  const inset = (r, d) => ({ x: r.x + d, y: r.y + d, w: r.w - 2 * d, h: r.h - 2 * d });
  /** Splits a rect into a grid, row by row. */
  function grid(r, cols, rows, gap = GAP) {
    const w = (r.w - gap * (cols - 1)) / cols, h = (r.h - gap * (rows - 1)) / rows, out = [];
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) out.push({ x: r.x + i * (w + gap), y: r.y + j * (h + gap), w, h });
    return out;
  }
  /** Splits a rect in two, side by side ("h") or stacked ("v"), the first taking frac of it. */
  function split(r, dir, frac = 0.5, gap = GAP) {
    if (dir === "h") { const w = (r.w - gap) * frac; return [{ ...r, w }, { ...r, x: r.x + w + gap, w: r.w - gap - w }]; }
    const h = (r.h - gap) * frac;
    return [{ ...r, h }, { ...r, y: r.y + h + gap, h: r.h - gap - h }];
  }
  const css = (r) => ({ left: r.x, top: r.y, width: r.w, height: r.h });

  // ---- The window ----
  function chrome(stage, { theme = "dark", tabs = ["dormouse", "website", "+"], on = 0 } = {}) {
    const win = S.html(stage, `<div class="win theme-${theme}">
      <div class="appbar"><img class="logo" src="${LOGO}" alt="" />${tabs.map((t, i) => `<div class="wtab${i === on ? " on" : ""}">${t}</div>`).join("")}</div>
      <div class="wctl"><i class="min"></i><i></i><i class="close"></i></div>
      <div class="wall"></div><div class="baseboard"></div></div>`);
    return { win, wall: win.querySelector(".wall"), base: win.querySelector(".baseboard"), appbar: win.querySelector(".appbar"), ctl: win.querySelector(".wctl") };
  }
  function door(base, title, { todo = false } = {}) {
    const el = S.html(base, `<div class="door"><span>${title}</span>${todo ? `<span class="todo">TODO</span>` : ""}<div class="alarm"></div></div>`);
    return { el, alarm: el.querySelector(".alarm") };
  }

  // ---- Panes ----
  /** A pane at a rect. lines are HTML strings, one per terminal row; shown says how many are already printed. */
  function pane(wall, rect, { title = "zsh", lines = [], shown = lines.length, active = false, todo = false, fs = 24 } = {}) {
    const el = S.html(wall, `<div class="pane"><div class="pb"><div class="scroll"></div></div>
      <div class="ph"><div class="on"></div><span class="pt">${title}</span><span class="todo" style="opacity:${todo ? 1 : 0}">TODO</span><span class="grow"></span><span class="act">_ x</span></div>
      <div class="alarm"></div><div class="alarm sel" style="box-shadow: inset 0 0 0 3px var(--ring)"></div></div>`);
    gsap.set(el, css(rect));
    const p = { el, rect, head: el.querySelector(".ph"), on: el.querySelector(".on"), title: el.querySelector(".pt"), todo: el.querySelector(".todo"), body: el.querySelector(".pb"), scroll: el.querySelector(".scroll"), alarm: el.querySelector(".alarm"), sel: el.querySelector(".sel"), lines: [], lh: (LH * fs) / 24 };
    if (fs !== 24) p.body.style.font = `400 ${fs}px/${p.lh}px "Ubuntu Mono", monospace`;
    add(p, lines, shown);
    if (active) gsap.set([p.on, p.sel], { opacity: 1 }), (p.head.style.color = "var(--head-on-fg)");
    return p;
  }
  const rowsOf = (p, rect = p.rect) => Math.max(1, Math.floor((rect.h - HEAD - PAD * 2) / p.lh));
  /** Appends terminal rows. Rows past shown stay invisible until stream() prints them. */
  function add(p, lines, shown = lines.length) {
    const first = p.lines.length;
    lines.forEach((markup, i) => {
      const ln = S.html(p.scroll, `<div class="ln" style="height:${p.lh}px">${markup || " "}</div>`);
      if (i >= shown) gsap.set(ln, { opacity: 0 });
      p.lines.push(ln);
    });
    p.printed = first + shown;
    gsap.set(p.scroll, { y: -Math.max(0, p.printed - rowsOf(p)) * p.lh });
    return p.lines.slice(first);
  }
  /** Prints the pane's remaining rows between t0 and t1, scrolling like a terminal once it is full. */
  function stream(tl, p, t0, t1, { to = p.lines.length, rect = p.rect } = {}) {
    const from = p.printed, n = to - from, rows = rowsOf(p, rect);
    for (let i = 0; i < n; i++) {
      const t = t0 + ((t1 - t0) * i) / Math.max(1, n - 1 || 1);
      tl.set(p.lines[from + i], { opacity: 1 }, t);
      const over = from + i + 1 - rows;
      if (over > 0) tl.set(p.scroll, { y: -over * p.lh }, t);
    }
    p.printed = to;
  }
  /** Types text into an element, one character at a time, between t0 and t1. Returns the cursor it leaves at the end. */
  function type(tl, el, text, t0, t1, { cls = "", cursor = true } = {}) {
    const chars = [...text].map((ch) => {
      const s = document.createElement("span");
      if (cls) s.className = cls;
      s.textContent = ch;
      s.style.display = "none";
      el.appendChild(s);
      return s;
    });
    chars.forEach((s, i) => tl.set(s, { display: "inline" }, t0 + ((t1 - t0) * i) / Math.max(1, chars.length)));
    const cur = cursor ? S.html(el, `<span class="cur"></span>`) : null;
    return { chars, cur };
  }
  /** The clip-path reveal a new pane makes, from the side it appeared on. */
  function spawn(tl, p, t, from = "left", dur = MOVE) {
    const hidden = { left: "inset(0% 100% 0% 0%)", right: "inset(0% 0% 0% 100%)", top: "inset(0% 0% 100% 0%)", bottom: "inset(100% 0% 0% 0%)", corner: "inset(0% 100% 100% 0%)" }[from];
    tl.fromTo(p.el, { clipPath: hidden }, { clipPath: "inset(0% 0% 0% 0%)", duration: dur, ease: EASE, immediateRender: true }, t);
  }
  function kill(tl, p, t, dur = 0.3) { tl.to(p.el, { opacity: 0, duration: dur, ease: "power2.out" }, t); }
  function move(tl, p, rect, t, dur = MOVE, ease = EASE) { tl.to(p.el, { ...css(rect), duration: dur, ease }, t); p.rect = rect; }
  /** Moves focus: the header palettes crossfade and the ring travels, over 220 ms. */
  function focus(tl, panes, target, t, dur = 0.22) {
    panes.forEach((p) => {
      tl.to([p.on, p.sel], { opacity: p === target ? 1 : 0, duration: dur, ease: EASE }, t);
      tl.set(p.head, { color: p === target ? "var(--head-on-fg)" : "var(--head-fg)" }, t);
    });
  }
  /** An alert rings: the alarm inset flashes on, pulses, and stays for hold seconds. Works on panes and doors. */
  function ring(tl, target, t, { hold = 0.5, pulses = 1 } = {}) {
    for (let i = 0; i < pulses; i++) {
      tl.fromTo(target.alarm, { opacity: 0 }, { opacity: 1, duration: 0.05, ease: "none" }, t + i * 0.16);
      if (i < pulses - 1) tl.to(target.alarm, { opacity: 0.15, duration: 0.09, ease: "none" }, t + i * 0.16 + 0.06);
    }
    tl.to(target.alarm, { opacity: 0, duration: 0.25, ease: "power2.out" }, t + (pulses - 1) * 0.16 + hold);
  }
  function todoOn(tl, p, t) { tl.fromTo(p.todo, { opacity: 0, scale: 0.6 }, { opacity: 1, scale: 1, duration: 0.25, ease: "back.out(2.5)" }, t); }
  /** A small squash a pane makes on a beat. */
  function bump(tl, el, t, amt = 0.03) {
    tl.fromTo(el, { scale: 1 - amt }, { scale: 1, duration: 0.32, ease: "back.out(3)", immediateRender: false }, t);
  }

  /** Big type centered in a pane's body, for the words the panes spell. */
  function big(p, text, size = 150, color = "var(--fg)") {
    return S.html(p.body, `<div class="big" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:${size}px;color:${color}">${text}</div>`);
  }

  // ---- The lyric line ----
  /** The words of the song under the window. Each line waits dim, and each word lights as it is sung. */
  function lyrics(sc, stage) {
    const strip = S.html(stage, `<div class="lyrics" data-layout-allow-caption-zone></div>`);
    const all = S.SONG.lines;
    sc.lines.forEach((l) => {
      const i = all.findIndex((x) => x.id === l.id), next = all[i + 1];
      const el = S.html(strip, `<div class="lyr"><span class="pr">&gt; </span>${l.voice ? `<span class="who">[${l.voice}] </span>` : ""}${l.words.map((w) => `<span class="lw">${w.text}</span>`).join(" ")}</div>`);
      const from = Math.max(0, l.start - 0.3);
      const until = Math.min(sc.dur, next ? Math.min(sc.t(next.start) - 0.3, l.end + 1.6) : l.end + 1.6);
      if (until - from < 0.4) return; // A line that only has a blink left before the cut is not shown.
      sc.tl.set(el, { opacity: 1 }, from);
      if (until < sc.dur) sc.tl.set(el, { opacity: 0 }, until);
      el.querySelectorAll(".lw").forEach((span, k) => {
        const w = l.words[k];
        sc.tl.set(span, { color: "#ffcf87" }, Math.max(0, w.start));
        sc.tl.set(span, { color: "#ffffff" }, Math.max(0.001, w.end));
      });
    });
    return strip;
  }

  // ---- Things terminals say ----
  const c = (cls, s) => `<span class="c-${cls}">${s}</span>`;
  const dot = (cls) => `<span class="dot c-${cls}"></span>`;
  const FILES = ["src/auth/session.ts", "src/api/todos.ts", "lib/wall/Pane.tsx", "src/store/index.ts", "tests/login.spec.ts", "src/routes/app.tsx", "lib/pty/adapter.ts", "src/ui/Header.tsx", "docs/setup.md", "src/hooks/useAlert.ts"];
  const ASKS = ["fix the flaky login test", "add dark mode to settings", "speed up the todo list", "write the release notes", "port the parser to rust", "make the header sticky"];
  /** An agent at work: a request, then reads, edits and test runs. */
  function agent(seed, n = 40) {
    const r = S.rand(seed), pick = (a) => a[Math.floor(r() * a.length)], out = [`${c("k", ">")} ${c("w", pick(ASKS))}`, ""];
    while (out.length < n) {
      const k = r();
      if (k < 0.3) out.push(`${dot("c")}Read ${c("b", pick(FILES))}`);
      else if (k < 0.55) out.push(`${dot("m")}Edit ${c("b", pick(FILES))}`, c("g", `  + ${pick(["await store.flush()", "const ring = useAlert(id)", "if (!session) return null", "export const GAP = 8", "retry(3, () => login())"])}`), c("r", `  - ${pick(["store.flush()", "let ring = false", "return session!", "const GAP = 6", "login()"])}`));
      else if (k < 0.75) out.push(`${dot("y")}Run ${c("w", pick(["pnpm test", "pnpm build", "cargo check", "pnpm lint"]))}`, c("g", `  ${Math.floor(20 + r() * 400)} passed`) + c("d", ` in ${(1 + r() * 9).toFixed(1)}s`));
      else out.push(c("d", `  ${pick(["thinking about the edge cases", "checking the callers", "reading the spec first", "three files left"])}...`));
    }
    return out.slice(0, n);
  }
  /** A dev server's log. */
  function dev(seed, n = 30) {
    const r = S.rand(seed), pick = (a) => a[Math.floor(r() * a.length)];
    const out = [`${c("g", "  VITE v7.1.4")}  ${c("d", "ready in")} ${c("w", "212 ms")}`, `  ${c("g", "-&gt;")}  Local:   ${c("c", "http://localhost:5173/")}`];
    let sec = 11;
    while (out.length < n) {
      sec += Math.floor(1 + r() * 3);
      const stamp = c("d", `9:04:${String(sec % 60).padStart(2, "0")} PM`);
      out.push(r() < 0.6 ? `${stamp} ${c("c", "[vite]")} ${c("g", "hmr update")} ${c("d", "/" + pick(FILES))}` : `${stamp} ${c("d", "GET")} /api/${pick(["todos", "session", "alerts", "panes"])} ${c("g", "200")} ${c("d", Math.floor(2 + r() * 40) + "ms")}`);
    }
    return out.slice(0, n);
  }
  /** A test run. */
  function tests(seed, n = 30) {
    const r = S.rand(seed), pick = (a) => a[Math.floor(r() * a.length)], out = [`${c("d", "$")} pnpm test`, ""];
    while (out.length < n) out.push(` ${c("g", "PASS")} ${c("d", "tests/")}${pick(["login", "wall", "alert", "pty", "theme", "doors", "split", "pocket"])}.spec.ts ${c("d", `(${Math.floor(3 + r() * 30)} tests)`)}`);
    return out.slice(0, n);
  }
  const KINDS = [agent, dev, tests];
  const TITLES = ["claude", "npm run dev", "pnpm test", "codex", "zsh", "cargo watch", "git log", "claude", "pnpm build", "tail -f app.log", "codex", "htop"];
  /** Any terminal content, by seed, and a title to go with it. */
  const any = (seed, n = 30) => KINDS[seed % KINDS.length](seed * 7 + 1, n);
  const titleOf = (seed) => TITLES[seed % TITLES.length];

  // ---- Devices ----
  /** A phone showing the mobile terminal. Returns its screen, 100% of the phone's inside. */
  function phone(parent, r, { theme = "dark" } = {}) {
    const el = S.html(parent, `<div class="phone theme-${theme}"><div class="notch"></div><div class="screen abs" style="width:100%;height:100%"></div></div>`);
    gsap.set(el, css(r));
    return { el, screen: el.querySelector(".screen") };
  }
  function touch(parent) { return S.html(parent, `<div class="touch"></div>`); }
  /** A thumb taps: the touch ring lands at x, y and fades. */
  function tap(tl, el, x, y, t) {
    tl.set(el, { x, y }, t);
    tl.fromTo(el, { opacity: 0, scale: 0.5 }, { opacity: 1, scale: 1, duration: 0.1, ease: "power2.out", immediateRender: false }, t);
    tl.to(el, { opacity: 0, scale: 1.35, duration: 0.3, ease: "power2.out" }, t + 0.12);
  }
  const POINTER = `<svg class="pointer" viewBox="0 0 22 30"><path d="M2 2 L2 24 L8 18.5 L12 28 L15.5 26.5 L11.5 17.5 L20 17.5 Z" fill="#fff" stroke="#000" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
  function pointer(parent) { return S.html(parent, POINTER); }

  /** What a pane with this title would be printing. */
  function say(title, seed, n = 30) {
    if (/claude|codex/.test(title)) return agent(seed, n);
    if (/dev|tail|log|watch/.test(title)) return dev(seed, n);
    return tests(seed, n);
  }

  // ---- Browser panes ----
  const PAGE = `<div class="page"><div class="nav"><b>Mullet</b><span>Front</span><span>Back</span><span>Sides</span></div>
    <div class="hero"><div class="h1">Business in the front.</div><div class="h2">Party in the back.</div><div class="btn">Book a cut</div></div>
    <div class="cards"><div><i style="background:#e9a15b"></i><b></b><b class="s"></b></div><div><i style="background:#5bb5e9"></i><b></b><b class="s"></b></div><div><i style="background:#7bd88f"></i><b></b><b class="s"></b></div></div></div>`;
  /** A browser Surface: the pane header, an address bar, and a page on the white iframe ground. */
  function browser(wall, rect, { title = "localhost:5173", url = "http://localhost:5173/", active = false } = {}) {
    const p = pane(wall, rect, { title, active });
    p.body.style.padding = "0";
    p.web = S.html(p.body, `<div class="web"><div class="addr"><span class="nb">&lt;</span><span class="nb">&gt;</span><span class="url">${url}</span></div>${PAGE}</div>`);
    return p;
  }
  /** A raised surface that pops up: a notification, a tooltip. */
  function popup(parent, x, y, markup) {
    const el = S.html(parent, `<div class="popup">${markup}</div>`);
    gsap.set(el, { x, y, opacity: 0 });
    return el;
  }
  function pop(tl, el, t, hold = 1.2) {
    tl.fromTo(el, { opacity: 0, scale: 0.7, transformOrigin: "0% 0%" }, { opacity: 1, scale: 1, duration: 0.22, ease: "back.out(2.6)", immediateRender: false }, t);
    if (hold != null) tl.to(el, { opacity: 0, duration: 0.18 }, t + hold);
  }

  /** The mobile terminal on a phone's screen: a header, the feed, and the key row. Returns the feed, to scroll. */
  function mobile(screen, { title = "claude", seed = 404, n = 90 } = {}) {
    const rows = agent(seed, n).map((l) => `<div class="ln" style="height:27px">${l}</div>`).join("");
    const el = S.html(screen, `<div style="position:absolute;inset:0"><div class="ph" style="height:74px;padding-top:30px;font-size:20px"><div class="on" style="opacity:1"></div><span style="color:var(--head-on-fg)">${title}</span></div>
      <div style="position:absolute;top:74px;left:0;right:0;bottom:70px;overflow:hidden;padding:10px 12px;font:400 20px/27px 'Ubuntu Mono',monospace;color:var(--fg)"><div class="feed">${rows}</div></div>
      <div style="position:absolute;left:0;right:0;bottom:0;height:70px;background:var(--head);display:flex;gap:26px;align-items:center;justify-content:center;font:700 20px 'Ubuntu Sans Mono',monospace;color:var(--head-fg)"><span>esc</span><span>tab</span><span>ctrl</span><span>type</span></div></div>`);
    return el.querySelector(".feed");
  }
  /** A train window at night behind everything: lights pass from t0 on, at a steady speed. */
  function train(parent, tl, t0, t1, speed = 1300) {
    const el = S.html(parent, `<div class="abs train" style="width:1920px;height:984px;overflow:hidden;opacity:0"><div class="abs sill"></div><div class="abs lights"></div></div>`);
    const lights = el.querySelector(".lights"), r = S.rand(77), span = speed * (t1 - t0) + 2200;
    for (let x = 200; x < span; x += 260 + r() * 520) S.html(lights, `<div class="abs" style="left:${x}px;top:${120 + r() * 380}px;width:${40 + r() * 220}px;height:${10 + r() * 26}px;border-radius:20px;background:rgba(255,207,135,${0.12 + r() * 0.3})"></div>`);
    for (let x = 0; x < span; x += 640) S.html(lights, `<div class="abs" style="left:${x}px;top:0;width:26px;height:984px;background:#050505"></div>`);
    tl.fromTo(lights, { x: 0 }, { x: -speed * (t1 - t0), duration: t1 - t0, ease: "none" }, t0);
    return el;
  }

  const DOORS = ["dor", "mouse", "dormouse", "dormouse", "dormouse", "dormouse"]; // What the intro leaves on the baseboard.
  window.P = { DOORS, mobile, train, say, browser, popup, pop, HEAD, LH, PAD, GAP, WALL, EASE, MOVE, LOGO, inset, grid, split, css, chrome, door, pane, add, rowsOf, stream, type, big, spawn, kill, move, focus, ring, todoOn, bump, lyrics, c, dot, agent, dev, tests, any, titleOf, phone, touch, tap, pointer };
})();

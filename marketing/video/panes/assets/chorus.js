// The chorus, which both chorus scenes play. Four lines, one bar each: panes multiply on every "Dormouse", and the tag line lands on the window itself.
window.Chorus = function (id, { lines, themes = ["dark", "dark", "dark", "dark"] }) {
  const sc = S.begin(id), { tl, stage } = sc;
  const rig = S.html(stage, `<div class="abs" style="width:1920px;height:984px"></div>`);
  const under = S.html(rig, `<div class="abs" style="width:1920px;height:984px"></div>`); // Device frames, behind the window.
  const ui = P.chrome(rig, { theme: themes[0] });
  const over = S.html(rig, `<div class="abs" style="width:1920px;height:984px;pointer-events:none"></div>`); // VS Code's frame and the tag words, over it.
  P.lyrics(sc, stage);
  P.DOORS.forEach((t) => P.door(ui.base, t));
  const [A, B, C, D] = lines.map((l) => sc.line(l));
  const at = (l, i) => Math.max(0, l.words[i].start);
  const flash = S.html(stage, `<div class="abs" style="width:1920px;height:984px;background:#fff;opacity:0;pointer-events:none"></div>`);
  themes.forEach((th, k) => {
    if (k === 0 || th === themes[k - 1]) return;
    const t = at([A, B, C, D][k], 0) - 0.03;
    tl.set(ui.win, { attr: { class: `win theme-${th}` } }, t);
    tl.fromTo(flash, { opacity: 0.5 }, { opacity: 0, duration: 0.3, ease: "power2.out", immediateRender: false }, t);
  });
  const tag = (text, x, y, size = 200, color = "#fff") => {
    const el = S.html(over, `<div class="tagword" data-layout-allow-overlap style="font-size:${size}px;color:${color}">${text}</div>`);
    gsap.set(el, { x, y, xPercent: -50, yPercent: -50, opacity: 0 });
    return el;
  };
  const land = (el, t, until) => {
    tl.fromTo(el, { opacity: 0, scale: 1.5 }, { opacity: 1, scale: 1, duration: 0.2, ease: "back.out(2)", immediateRender: false }, t);
    tl.to(el, { opacity: 0, duration: 0.12 }, until);
  };

  // ---- Line 1: "multitask more". 1, 2, 4, 8, 16 panes. ----
  const STAGES = [[1, 1], [2, 1], [2, 2], [4, 2], [4, 4]];
  const T = [0, at(A, 0), at(A, 1), at(A, 2), at(A, 3)];
  const rectAt = (st, cx, cy) => { const [c, r] = STAGES[st]; return P.grid(P.WALL, c, r)[Math.floor((cy * r) / 4) * c + Math.floor((cx * c) / 4)]; };
  const born = (cx, cy) => STAGES.findIndex(([c, r]) => cx % (4 / c) === 0 && cy % (4 / r) === 0);
  const panes = [];
  for (let cy = 0; cy < 4; cy++) for (let cx = 0; cx < 4; cx++) {
    const b = born(cx, cy), i = cy * 4 + cx, title = P.titleOf(i * 5 + b);
    const p = P.pane(ui.wall, rectAt(b, cx, cy), { title, lines: P.say(title, i + 90, 46), shown: b === 0 ? 6 : 0, active: b === 0 });
    Object.assign(p, { cx, cy, b });
    if (b > 0) P.spawn(tl, p, T[b], cx > 0 && cx % 2 ? "left" : cy ? "top" : "left", 0.26);
    for (let st = b + 1; st <= 4; st++) P.move(tl, p, rectAt(st, cx, cy), T[st], 0.26);
    P.stream(tl, p, T[b] + 0.05, at(B, 0), { rect: rectAt(4, cx, cy), to: 30 });
    panes.push(p);
  }
  [1, 2, 3, 4].forEach((st) => P.focus(tl, panes, panes.find((p) => p.b === st), T[st], 0.1));
  const multi = tag("multitask", 960, 380, 250, "#ffcf87"), more = tag("more", 960, 640, 250);
  land(multi, at(A, 2), at(B, 0) - 0.05);
  land(more, at(A, 3), at(B, 0) - 0.05);

  // ---- Line 2: "D-O-R spells dor". They fold back to one shell, and it types the three letters. ----
  panes.forEach((p) => {
    if (p.b > 2) P.kill(tl, p, at(B, 0), 0.12);
    else P.move(tl, p, rectAt(2, p.cx, p.cy), at(B, 0), 0.26);
    if (p.b > 0 && p.b <= 2) P.kill(tl, p, at(B, 1), 0.12);
  });
  const shell = panes[0];
  P.move(tl, shell, P.WALL, at(B, 1), 0.26);
  P.focus(tl, panes, shell, at(B, 0), 0.1);
  tl.set(shell.scroll, { opacity: 0 }, at(B, 1));
  tl.set(shell.title, { textContent: "zsh" }, at(B, 1));
  const row = S.html(shell.body, `<div class="big" style="position:absolute;left:90px;top:70px;font-size:290px"><span class="c-k">$ </span></div>`);
  gsap.set(row, { opacity: 0 });
  tl.set(row, { opacity: 1 }, at(B, 1) + 0.1);
  const dor = P.type(tl, row, "dor", at(B, 2), B.words[2].end + 0.02);
  dor.chars.forEach((ch, i) => tl.fromTo(ch, { color: "#ffcf87" }, { color: "var(--fg)", duration: 0.3, immediateRender: false }, at(B, 2) + ((B.words[2].end - at(B, 2)) * i) / 3));
  tl.to(dor.chars, { color: "#ffcf87", duration: 0.1 }, at(B, 4));
  P.bump(tl, row, at(B, 4), 0.08);
  tl.set(dor.cur, { opacity: 0 }, at(B, 4));
  const VERBS = ["split", "ensure", "send", "read", "await", "kill", "list", "open", "tool", "skill", "iframe", "reopen", "agent-browser", "playwright"];
  const verbs = S.html(shell.body, `<div style="position:absolute;left:100px;right:60px;top:460px;display:flex;flex-wrap:wrap;gap:14px 44px;font:700 58px/1.2 'Ubuntu Sans Mono',monospace">${VERBS.map((v) => `<span><span class="c-d">dor </span>${v}</span>`).join("")}</div>`);
  [...verbs.children].forEach((el, i) => tl.fromTo(el, { opacity: 0 }, { opacity: 1, duration: 0.05, ease: "none" }, at(B, 3) + i * 0.06));

  // ---- Line 3: "VS Code or standalone". Two more panes, then the frame around them changes. ----
  const [half, rest] = P.split(P.WALL, "h", 0.5), [r1, r2] = P.split(rest, "v", 0.5);
  P.move(tl, shell, half, at(C, 0), 0.26);
  tl.to([row, verbs], { opacity: 0, duration: 0.1 }, at(C, 0));
  tl.set(shell.scroll, { opacity: 1 }, at(C, 0) + 0.1);
  tl.set(shell.title, { textContent: "claude" }, at(C, 0));
  const p2 = P.pane(ui.wall, rest, { title: "codex", lines: P.agent(301, 40), shown: 0 });
  P.spawn(tl, p2, at(C, 0), "left", 0.26);
  P.stream(tl, p2, at(C, 0) + 0.05, sc.dur, {});
  P.move(tl, p2, r1, at(C, 1), 0.26);
  const p3 = P.pane(ui.wall, r2, { title: "npm run dev", lines: P.dev(302, 40), shown: 0 });
  P.spawn(tl, p3, at(C, 1), "top", 0.26);
  P.stream(tl, p3, at(C, 1) + 0.05, sc.dur, {});
  const trio = [shell, p2, p3];
  P.focus(tl, trio, p2, at(C, 0), 0.1);
  P.focus(tl, trio, p3, at(C, 1), 0.1);

  // VS Code: its chrome slides in from every edge and the wall becomes its panel.
  const K = 1556 / 1920, vs = at(C, 2), sa = at(C, 5);
  const piece = (cls, markup, from) => { const el = S.html(over, `<div class="vsc ${cls}">${markup}</div>`); gsap.set(el, { ...from, opacity: 0 }); return el; };
  const tree = ["v DORMOUSE", "  > docs", "  > lib", "  v src", "      app.tsx", "      alert.ts", "      wall.tsx", "  > tests", "    dormouse.yml", "    package.json", "    README.md"];
  const code = [`<span class="c-m">export function</span> <span class="c-y">Wall</span>({ panes }) {`, `  <span class="c-m">return</span> panes.<span class="c-y">map</span>((p) =&gt; &lt;<span class="c-c">Pane</span> key={p.id} {...p} /&gt;);`, `}`];
  const pieces = [
    piece("title", `dormouse &mdash; Visual Studio Code`, { y: -44 }),
    piece("act", `<i class="on"></i><i></i><i></i><i></i><i></i>`, { x: -370 }),
    piece("side", `<div class="hd">EXPLORER</div>${tree.map((l) => `<div>${l}</div>`).join("")}`, { x: -370 }),
    piece("edit", `<div class="tabs"><span class="on">wall.tsx</span><span>alert.ts</span><span>dormouse.yml</span></div><div class="src">${code.map((l, i) => `<div><span class="no">${i + 12}</span>${l}</div>`).join("")}</div><div class="panel"><span>PROBLEMS</span><span>OUTPUT</span><span>TERMINAL</span><span class="on">DORMOUSE</span></div>`, { y: -220 }),
    piece("status", `<span>main*</span><span>0 errors</span><span style="margin-left:auto">Ln 13, Col 9</span><span>TypeScript JSX</span>`, { y: 30 }),
  ];
  tl.set(pieces, { opacity: 1 }, vs);
  tl.to(pieces, { x: 0, y: 0, duration: 0.3, ease: P.EASE }, vs);
  tl.set(pieces, { opacity: 0 }, sa + 0.2);
  tl.to(ui.win, { scale: K, x: 364, y: 211 - 60 * K, duration: 0.3, ease: P.EASE }, vs);
  tl.to([ui.appbar, ui.ctl], { opacity: 0, duration: 0.1 }, vs);
  land(tag("VS Code", 1142, 600, 210, "#4fb6ff"), vs + 0.05, sa - 0.04);
  // Standalone: the frame leaves and the same wall is its own window on the desktop.
  tl.to(pieces[0], { y: -44, duration: 0.25, ease: "power2.in" }, sa - 0.1);
  tl.to([pieces[1], pieces[2]], { x: -370, duration: 0.25, ease: "power2.in" }, sa - 0.1);
  tl.to(pieces[3], { y: -220, duration: 0.25, ease: "power2.in" }, sa - 0.1);
  tl.to(pieces[4], { y: 30, duration: 0.25, ease: "power2.in" }, sa - 0.1);
  tl.to(ui.win, { scale: 0.88, x: 115, y: 50, borderRadius: 18, boxShadow: "0 30px 80px rgba(0,0,0,0.8), 0 0 0 2px rgba(255,255,255,0.16)", duration: 0.34, ease: P.EASE }, sa);
  tl.to([ui.appbar, ui.ctl], { opacity: 1, duration: 0.15 }, sa);
  land(tag("standalone", 960, 500, 210, "#ffcf87"), sa + 0.08, at(D, 0) - 0.04);

  // ---- Line 4: "from my laptop to my phone". Full screen again, then the camera backs off to show the machines. ----
  tl.to(ui.win, { scale: 1, x: 0, y: 0, borderRadius: 0, boxShadow: "0 0 0 0 rgba(0,0,0,0)", duration: 0.26, ease: P.EASE }, at(D, 0));
  const [shA, shB] = P.split(half, "v", 0.5);
  P.move(tl, shell, shA, at(D, 0), 0.26);
  const p4 = P.pane(ui.wall, shB, { title: "pnpm test", lines: P.tests(303, 40), shown: 0 });
  P.spawn(tl, p4, at(D, 0), "top", 0.26);
  P.stream(tl, p4, at(D, 0) + 0.05, sc.dur, {});
  const quad = [shell, p2, p3, p4];
  P.focus(tl, quad, p4, at(D, 0), 0.1);
  P.focus(tl, quad, shell, at(D, 1), 0.1);
  quad.forEach((p, i) => P.bump(tl, p.el, at(D, 1) + i * 0.02, 0.05));

  const lap = at(D, 4) - 0.06, ph = at(D, 6) - 0.04, LS = 0.56, LX = 120, LY = 150;
  const lid = S.html(under, `<div class="laptop-lid"></div>`), base = S.html(under, `<div class="laptop-base"></div>`);
  gsap.set(lid, { left: LX - 14, top: LY - 14, width: 1920 * LS + 28, height: 984 * LS + 32, opacity: 0 });
  gsap.set(base, { left: LX - 90, top: LY + 984 * LS + 18, width: 1920 * LS + 180, opacity: 0 });
  tl.to(ui.win, { scale: LS, x: LX, y: LY, duration: 0.4, ease: P.EASE }, lap);
  tl.to([lid, base], { opacity: 1, duration: 0.2 }, lap + 0.15);
  const lapTag = tag("laptop", LX + 538, 850, 110, "#ffcf87");
  land(lapTag, at(D, 4), sc.dur + 1);
  const phone = P.phone(under, { x: 1440, y: 60, w: 370, h: 760 }, { theme: themes[3] });
  const feed = P.agent(404, 60).map((l) => `<div class="ln" style="height:27px">${l}</div>`).join("");
  S.html(phone.screen, `<div style="position:absolute;inset:0"><div class="ph" style="height:74px;padding-top:30px;font-size:20px">claude</div><div style="position:absolute;top:74px;left:0;right:0;bottom:70px;overflow:hidden;padding:10px 12px;font:400 20px/27px 'Ubuntu Mono',monospace;color:var(--fg)"><div class="feed">${feed}</div></div><div style="position:absolute;left:0;right:0;bottom:0;height:70px;background:var(--head);display:flex;gap:10px;align-items:center;justify-content:center;font:700 20px 'Ubuntu Sans Mono',monospace;color:var(--head-fg)"><span>esc</span><span>tab</span><span>ctrl</span><span>type</span></div></div>`);
  gsap.set(phone.el, { opacity: 0 });
  tl.set(phone.el, { opacity: 1 }, ph);
  tl.fromTo(phone.el, { y: 900 }, { y: 0, duration: 0.4, ease: "back.out(1.6)" }, ph);
  tl.to(phone.screen.querySelector(".feed"), { y: -27 * 30, duration: sc.dur - ph + 2, ease: "none" }, ph);
  const phTag = tag("phone", 1625, 900, 110);
  land(phTag, at(D, 7) - 0.08, sc.dur + 1);
  // "to my": packets cross from one to the other.
  for (let k = 0; k < 5; k++) {
    const dotEl = S.html(over, `<div class="abs" style="width:22px;height:22px;border-radius:50%;background:#ffcf87;opacity:0"></div>`);
    const t = at(D, 5) + k * 0.07;
    tl.fromTo(dotEl, { x: 1230, y: 420, opacity: 1 }, { x: 1410, y: 420, duration: 0.3, ease: "power1.inOut", immediateRender: false }, t);
    tl.set(dotEl, { opacity: 0 }, t + 0.3);
  }
  window.__timelines[id] = tl;
};

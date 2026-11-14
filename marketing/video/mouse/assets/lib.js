// The art for the "mouse" film: the dormouse rig, its cast and props, and the sing-along line.
// Everything is deterministic and built from timeline tweens, so any frame can be seeked to.
(function () {
  const INK = "#2e2b27", TILE = "#43423d", FUR = "#d38d5f", FUR_IN = "#b9704a", BELLY = "#ecbd95", PAPER = "#f6ecd9", CREAM = "#fff8ea";
  const TEAL = "#5fb3a6", SUN = "#f4c64f", PINK = "#ec7fa0", BLUE = "#79b4e8", RED = "#e2625a", GREY = "#d9d3c7", HAIR = "#6b4226";
  const html = S.html;
  const L = `stroke="${INK}" stroke-width="7" stroke-linejoin="round" stroke-linecap="round"`;
  const GROUND = 880;

  const place = (el, x, y, o = {}) => gsap.set(el, { x, y, scale: o.scale ?? 1, rotation: o.rotation ?? 0, transformOrigin: o.origin ?? "0 0" });

  // What the mouse can hold. Each is drawn around the hand, pointing down the arm.
  const PROPS = {
    baton: `<rect x="-5" y="-6" width="10" height="150" rx="5" fill="${CREAM}" ${L} stroke-width="6"/><circle cx="0" cy="0" r="12" fill="${RED}" ${L} stroke-width="6"/>`,
    pointer: `<rect x="-6" y="-6" width="12" height="190" rx="6" fill="${SUN}" ${L} stroke-width="6"/><circle cx="0" cy="186" r="13" fill="${RED}" ${L} stroke-width="6"/>`,
    phone: `<rect x="-34" y="-20" width="68" height="118" rx="12" fill="${TILE}" ${L} stroke-width="6"/><rect x="-24" y="-8" width="48" height="88" rx="5" fill="${TEAL}"/>`,
    wrench: `<rect x="-8" y="-6" width="16" height="120" rx="8" fill="${GREY}" ${L} stroke-width="6"/><path d="M-26 104 a28 28 0 1 0 52 0 l-14 0 l0 22 l-24 0 l0 -22 z" fill="${GREY}" ${L} stroke-width="6"/>`,
  };

  /**
   * The dormouse, 300 x 420 at scale 1, standing with its feet at y = 411. Drawn to match the logo:
   * warm orange, big round ears, dot eyes, freckles. Returns its parts so a scene can act with them.
   * all takes the beat's squash, nod takes the beat's head bob, and head, arms and el are free for acting.
   */
  function mouse(parent, o = {}) {
    const { id = "", scale = 1, fur = FUR, inner = FUR_IN, belly = BELLY, girl = false, prop = "", mullet = false } = o;
    const freckle = (x, y) => `<circle cx="${x}" cy="${y}" r="3.6" fill="${inner}"/>`;
    const el = html(parent, `<svg class="prop" ${id ? `id="${id}"` : ""} width="${300 * scale}" height="${420 * scale}" viewBox="0 0 300 420" data-layout-ignore>
      <g class="m-all">
        <g class="m-tail"><path d="M196 356 C262 366 292 318 268 290 C250 270 222 284 234 304" fill="none" stroke="${INK}" stroke-width="17" stroke-linecap="round"/><path d="M196 356 C262 366 292 318 268 290 C250 270 222 284 234 304" fill="none" stroke="${fur}" stroke-width="6" stroke-linecap="round"/></g>
        <g class="m-legL"><ellipse cx="110" cy="396" rx="36" ry="15" fill="${fur}" ${L}/></g>
        <g class="m-legR"><ellipse cx="190" cy="396" rx="36" ry="15" fill="${fur}" ${L}/></g>
        <g class="m-torso">
          <path d="M150 196 C202 196 224 262 220 322 C217 374 192 392 150 392 C108 392 83 374 80 322 C76 262 98 196 150 196 Z" fill="${fur}" ${L}/>
          <ellipse class="m-belly" cx="150" cy="316" rx="42" ry="54" fill="${belly}"/>
        </g>
        <g class="m-armL"><rect x="72" y="226" width="32" height="104" rx="16" fill="${fur}" ${L}/></g>
        <g class="m-armR"><g transform="translate(212 318)"><g class="m-prop">${PROPS[prop] ?? ""}</g></g><rect x="196" y="226" width="32" height="104" rx="16" fill="${fur}" ${L}/></g>
        <g class="m-head"><g class="m-nod">
          <g class="m-mulletBack" opacity="${mullet ? 1 : 0}"><path d="M72 130 C50 170 58 232 14 282 C44 292 66 278 76 258 C72 288 78 306 98 314 C98 284 108 256 114 220 L186 220 C192 256 202 284 202 314 C222 306 228 288 224 258 C234 278 256 292 286 282 C242 232 250 170 228 130 Z" fill="${HAIR}" ${L}/></g>
          <g class="m-earL"><circle cx="64" cy="70" r="63" fill="${fur}" ${L}/><circle cx="64" cy="70" r="38" fill="${inner}"/></g>
          <g class="m-earR"><circle cx="236" cy="70" r="63" fill="${fur}" ${L}/><circle cx="236" cy="70" r="38" fill="${inner}"/>${girl ? `<g transform="translate(244 22) rotate(18)"><path d="M0 0 L-44 -26 L-44 26 Z M0 0 L44 -26 L44 26 Z" fill="${PINK}" ${L} stroke-width="6"/><circle r="12" fill="${PINK}" ${L} stroke-width="6"/></g>` : ""}</g>
          <path d="M150 54 C214 54 248 98 248 138 C248 186 206 214 150 214 C94 214 52 186 52 138 C52 98 86 54 150 54 Z" fill="${fur}" ${L}/>
          <g class="m-mulletFront" opacity="${mullet ? 1 : 0}"><path d="M84 96 C92 56 128 38 152 38 C178 38 210 56 216 96 C198 80 186 76 174 84 C166 70 150 70 142 84 C128 74 104 80 84 96 Z" fill="${HAIR}" ${L}/></g>
          <g class="m-face"><path d="M70 146 L34 138 M70 158 L32 164 M230 146 L266 138 M230 158 L268 164" fill="none" stroke="${INK}" stroke-width="4" stroke-linecap="round"/>${freckle(84, 152)}${freckle(98, 162)}${freckle(80, 168)}${freckle(216, 152)}${freckle(202, 162)}${freckle(220, 168)}
          <g class="m-eyes"><g class="m-eyeL"><circle cx="116" cy="128" r="11" fill="${INK}"/><circle cx="120" cy="124" r="3.6" fill="#fff"/></g><g class="m-eyeR"><circle cx="184" cy="128" r="11" fill="${INK}"/><circle cx="188" cy="124" r="3.6" fill="#fff"/></g>${girl ? `<path d="M102 118 l-12 -9 M106 112 l-8 -12 M198 118 l12 -9 M194 112 l8 -12" fill="none" stroke="${INK}" stroke-width="5" stroke-linecap="round"/>` : ""}</g>
          <path class="m-wink" d="M170 130 Q184 116 198 130" fill="none" ${L} stroke-width="7" opacity="0"/>
          <g class="m-brows" opacity="0"><path d="M98 100 L132 112 M202 100 L168 112" fill="none" ${L} stroke-width="8"/></g>
          <ellipse cx="150" cy="150" rx="11" ry="8" fill="${INK}"/>
          <path class="m-smile" d="M126 166 Q150 192 174 166" fill="none" ${L}/>
          <g class="m-open" opacity="0"><path d="M124 164 Q150 158 176 164 Q174 202 150 202 Q126 202 124 164 Z" fill="${INK}" ${L} stroke-width="5"/><ellipse cx="150" cy="191" rx="13" ry="7" fill="${PINK}"/></g></g>
          <g class="m-rear" opacity="0"><path d="M58 112 C58 60 110 40 150 40 C190 40 242 60 242 112 C250 190 262 258 284 306 C258 310 244 298 236 284 C236 316 226 336 206 348 C200 326 190 310 180 300 C172 330 160 348 150 358 C140 348 128 330 120 300 C110 310 100 326 94 348 C74 336 64 316 64 284 C56 298 42 310 16 306 C38 258 50 190 58 112 Z" fill="${HAIR}" ${L}/>${[[96, 130, 70, TEAL], [96, 154, 108, CREAM], [96, 178, 54, "#b89678"], [96, 202, 92, TEAL], [96, 226, 76, CREAM], [108, 250, 60, "#b89678"]].map(([x, y, w, c]) => `<rect x="${x}" y="${y}" width="${w}" height="11" rx="5.5" fill="${c}"/>`).join("")}</g>
        </g></g>
      </g>
    </svg>`);
    const part = (c) => el.querySelector(c);
    const m = { el, scale };
    for (const k of ["all", "tail", "legL", "legR", "torso", "armL", "armR", "prop", "head", "nod", "mulletBack", "mulletFront", "earL", "earR", "eyes", "wink", "brows", "smile", "open", "face", "rear", "eyeL", "eyeR", "belly"]) m[k] = part(`.m-${k}`);
    gsap.set(m.all, { svgOrigin: "150 408" });
    gsap.set(m.tail, { svgOrigin: "196 356" });
    gsap.set(m.armL, { svgOrigin: "88 242" });
    gsap.set(m.armR, { svgOrigin: "212 242" });
    gsap.set(m.prop, { svgOrigin: "0 0" });
    gsap.set([m.head, m.nod], { svgOrigin: "150 210" });
    gsap.set(m.earL, { svgOrigin: "100 112" });
    gsap.set(m.earR, { svgOrigin: "200 112" });
    gsap.set(m.eyes, { svgOrigin: "150 128" });
    gsap.set(m.open, { svgOrigin: "150 164" });
    gsap.set([m.mulletBack, m.mulletFront, m.rear], { svgOrigin: "150 80" });
    return m;
  }
  /** Where to put a mouse of this scale so its feet stand at (x, y), x being its middle. */
  const stand = (m, x, y = GROUND) => gsap.set(m.el, { x: x - 150 * m.scale, y: y - 408 * m.scale });
  const girlLook = { fur: "#f1cfa6", inner: "#e79aa6", belly: "#fbe8cf", girl: true };

  /** A little agent robot, 200 x 250, wheels at y = 244. */
  function bot(parent, o = {}) {
    const { id = "", scale = 1, color = TEAL, face = "happy" } = o;
    const el = html(parent, `<svg class="prop" ${id ? `id="${id}"` : ""} width="${200 * scale}" height="${250 * scale}" viewBox="0 0 200 250" data-layout-ignore>
      <g class="b-all">
        <circle cx="62" cy="228" r="17" fill="${INK}"/><circle cx="138" cy="228" r="17" fill="${INK}"/>
        <g class="b-armL"><rect x="22" y="140" width="22" height="58" rx="11" fill="${GREY}" ${L} stroke-width="6"/></g>
        <g class="b-armR"><rect x="156" y="140" width="22" height="58" rx="11" fill="${GREY}" ${L} stroke-width="6"/></g>
        <rect x="44" y="132" width="112" height="86" rx="20" fill="${color}" ${L}/>
        <rect x="70" y="156" width="60" height="12" rx="6" fill="${INK}" opacity="0.35"/><rect x="70" y="178" width="38" height="12" rx="6" fill="${INK}" opacity="0.35"/>
        <g class="b-head">
          <path d="M100 30 V8" fill="none" ${L}/><circle class="b-light" cx="100" cy="8" r="11" fill="${SUN}" ${L} stroke-width="6"/>
          <rect x="26" y="30" width="148" height="104" rx="30" fill="${CREAM}" ${L}/>
          <rect x="42" y="46" width="116" height="72" rx="18" fill="${TILE}"/>
          <g class="b-eyes"><rect x="62" y="64" width="22" height="30" rx="10" fill="${face === "busy" ? SUN : "#9be7da"}"/><rect x="116" y="64" width="22" height="30" rx="10" fill="${face === "busy" ? SUN : "#9be7da"}"/></g>
        </g>
      </g></svg>`);
    const part = (c) => el.querySelector(c);
    const b = { el, scale, all: part(".b-all"), head: part(".b-head"), eyes: part(".b-eyes"), armL: part(".b-armL"), armR: part(".b-armR"), light: part(".b-light") };
    gsap.set(b.all, { svgOrigin: "100 244" });
    gsap.set(b.head, { svgOrigin: "100 132" });
    gsap.set(b.eyes, { svgOrigin: "100 80" });
    gsap.set(b.armL, { svgOrigin: "33 146" });
    gsap.set(b.armR, { svgOrigin: "167 146" });
    return b;
  }

  /** The dev server: a squat rack machine with lights, 420 x 190. */
  function server(parent, o = {}) {
    const { id = "", scale = 1 } = o;
    const slot = (y, n) => `<rect x="24" y="${y}" width="372" height="40" rx="10" fill="${TILE}" ${L} stroke-width="6"/>${[0, 1, 2].map((i) => `<circle class="sv-led sv-led${n}${i}" cx="${52 + i * 30}" cy="${y + 20}" r="8" fill="${[TEAL, SUN, TEAL][i]}"/>`).join("")}${[0, 1, 2, 3, 4, 5].map((i) => `<rect x="${170 + i * 36}" y="${y + 12}" width="20" height="16" rx="4" fill="${INK}"/>`).join("")}`;
    const el = html(parent, `<svg class="prop" ${id ? `id="${id}"` : ""} width="${420 * scale}" height="${190 * scale}" viewBox="0 0 420 190" data-layout-ignore>
      <g class="sv-all"><rect x="40" y="166" width="40" height="20" rx="6" fill="${INK}"/><rect x="340" y="166" width="40" height="20" rx="6" fill="${INK}"/>
      <rect x="6" y="6" width="408" height="164" rx="22" fill="${BLUE}" ${L}/>${slot(22, 0)}${slot(70, 1)}${slot(118, 2)}</g></svg>`);
    const s = { el, scale, all: el.querySelector(".sv-all"), leds: [...el.querySelectorAll(".sv-led")] };
    gsap.set(s.all, { svgOrigin: "210 186" });
    return s;
  }

  /** A terminal pane: a dark tile with a header and rows of text. */
  function pane(parent, o = {}) {
    const { w = 300, h = 200, title = "zsh", color = TEAL, rows = 5, seed = 1, prompt = false } = o;
    const r = S.rand(seed);
    const lines = Array.from({ length: rows }, (_, i) => `<div class="ln" style="width:${Math.round(30 + r() * 62)}%;background:${i % 3 === 0 ? color : i % 3 === 1 ? CREAM : "#8d867a"};opacity:${i % 3 === 1 ? 0.85 : 1}"></div>`).join("");
    return html(parent, `<div class="pane" style="width:${w}px;height:${h}px" data-layout-ignore><div class="hd"><i style="background:${color}"></i>${title}</div><div class="bd">${prompt ? `<div class="mono" style="color:${CREAM};font-size:${prompt.size ?? 30}px;line-height:1.25">${prompt.text}</div>` : lines}</div></div>`);
  }

  /** The logo's tile: charcoal, rounded, with the white prompt and cursor. 400 x 400 at scale 1. */
  function tile(parent, o = {}) {
    const { id = "", scale = 1 } = o;
    const el = html(parent, `<svg class="prop" ${id ? `id="${id}"` : ""} width="${400 * scale}" height="${400 * scale}" viewBox="0 0 400 400" data-layout-ignore>
      <rect x="14" y="18" width="380" height="380" rx="84" fill="${INK}"/>
      <rect x="6" y="6" width="380" height="380" rx="84" fill="${TILE}" ${L}/>
      <path class="tl-gt" d="M70 96 L170 150 L70 204" fill="none" stroke="#fff" stroke-width="30" stroke-linecap="round" stroke-linejoin="round"/>
      <rect class="tl-us" x="150" y="296" width="150" height="28" rx="14" fill="#fff"/></svg>`);
    return { el, scale, gt: el.querySelector(".tl-gt"), us: el.querySelector(".tl-us") };
  }

  function bell(parent, scale = 1) {
    const el = html(parent, `<svg class="prop" width="${120 * scale}" height="${130 * scale}" viewBox="0 0 120 130" data-layout-ignore><g class="bl"><path d="M60 14 C92 14 98 46 100 70 C101 86 110 92 112 100 H8 C10 92 19 86 20 70 C22 46 28 14 60 14 Z" fill="${SUN}" ${L}/><circle cx="60" cy="112" r="12" fill="${SUN}" ${L}/><circle cx="60" cy="12" r="8" fill="${SUN}" ${L} stroke-width="6"/></g></svg>`);
    gsap.set(el.querySelector(".bl"), { svgOrigin: "60 12" });
    return { el, body: el.querySelector(".bl") };
  }
  /** A bell that pops in at (x, y) at t and rings. */
  function ringBell(tl, parent, x, y, t, { scale = 1, until = null } = {}) {
    const b = bell(parent, scale);
    gsap.set(b.el, { x: x - 60 * scale, y: y - 65 * scale, scale: 0, transformOrigin: "50% 50%" });
    tl.to(b.el, { scale: 1, duration: 0.22, ease: "back.out(3)" }, t);
    [16, -14, 11, -8, 5, 0].forEach((a, i) => tl.to(b.body, { rotation: a, duration: 0.08, ease: "sine.inOut" }, t + 0.1 + i * 0.08));
    ringAt(tl, parent, x, y, t + 0.05, { size: 320 * scale, dur: 0.5 });
    if (until !== null) tl.to(b.el, { scale: 0, duration: 0.15, ease: "back.in(2)" }, until);
    return b;
  }

  /** A shock ring centered on (x, y), expanding once. */
  function ringAt(tl, parent, x, y, t, { size = 600, color = SUN, dur = 0.6 } = {}) {
    const r = html(parent, `<div class="ring" style="width:100px;height:100px;border-color:${color}" data-layout-ignore></div>`);
    gsap.set(r, { x: x - 50, y: y - 50, scale: 0.2, opacity: 0 });
    tl.set(r, { opacity: 0.95 }, t);
    tl.to(r, { scale: size / 100, opacity: 0, duration: dur, ease: "power2.out" }, t + 0.001);
    return r;
  }

  function flash(tl, stage, t, peak = 0.8) {
    const el = html(stage, `<div class="flash" data-layout-ignore></div>`);
    tl.set(el, { opacity: peak }, t);
    tl.to(el, { opacity: 0, duration: 0.3, ease: "power2.out" }, t + 0.001);
  }

  /** Scale in from nothing, landing at t. */
  function pop(tl, el, t, { scale = 1, dur = 0.3, ease = "back.out(2.2)" } = {}) {
    gsap.set(el, { scale: 0 });
    tl.to(el, { scale, duration: dur, ease }, t);
  }

  /** The mouse keeps time: a squash on every beat, and its head tips from side to side. */
  function bop(tl, m, beats, { amp = 1, from = -1, to = 1e9, nod = true } = {}) {
    beats.filter((b) => b.t >= from && b.t < to).forEach((b) => {
      tl.fromTo(m.all, { scaleY: 1 - 0.075 * amp, scaleX: 1 + 0.045 * amp }, { scaleY: 1, scaleX: 1, duration: 0.32, ease: "power2.out", immediateRender: false }, b.t);
      if (nod) tl.to(m.nod, { rotation: (b.n % 2 ? 7 : -7) * amp, duration: 0.2, ease: "back.out(2.5)" }, b.t);
      if (m.tail) tl.to(m.tail, { rotation: (b.n % 2 ? -10 : 8) * amp, duration: 0.3, ease: "power2.out" }, b.t);
      if (m.earL) {
        tl.fromTo([m.earL, m.earR], { scaleY: 0.9 }, { scaleY: 1, duration: 0.3, ease: "back.out(3)", immediateRender: false }, b.t);
      }
    });
  }
  /** A robot or machine keeps time too. */
  function bounce(tl, part, beats, { amp = 1, from = -1, to = 1e9, offbeat = false } = {}) {
    beats.filter((b) => b.t >= from && b.t < to).forEach((b) => {
      tl.fromTo(part, { scaleY: 1 - 0.06 * amp, scaleX: 1 + 0.04 * amp }, { scaleY: 1, scaleX: 1, duration: 0.3, ease: "power2.out", immediateRender: false }, b.t + (offbeat ? 0.333 : 0));
    });
  }

  /** The mouth opens on each word and closes after it. */
  function sing(tl, m, words, { from = -1, to = 1e9 } = {}) {
    words.filter((x) => x.end > Math.max(0, from) && x.start < to).forEach((x) => {
      const s = Math.max(0.001, x.start), e = Math.max(s + 0.09, x.end - 0.03);
      tl.set(m.smile, { opacity: 0 }, s);
      tl.set(m.open, { opacity: 1 }, s);
      tl.fromTo(m.open, { scaleY: 0.45 }, { scaleY: 1, duration: 0.07, immediateRender: false }, s);
      tl.set(m.open, { opacity: 0 }, e);
      tl.set(m.smile, { opacity: 1 }, e);
    });
  }
  const wordsOf = (lines) => lines.flatMap((l) => l.words);

  function blink(tl, m, t) {
    tl.to(m.eyes, { scaleY: 0.1, duration: 0.05 }, t);
    tl.to(m.eyes, { scaleY: 1, duration: 0.07 }, t + 0.08);
  }
  /** A hop: up and back down, landing at t + dur. */
  function hop(tl, el, t, { height = 90, dur = 0.36 } = {}) {
    tl.to(el, { y: `-=${height}`, duration: dur / 2, ease: "power2.out" }, t);
    tl.to(el, { y: `+=${height}`, duration: dur / 2, ease: "power2.in" }, t + dur / 2);
  }

  /**
   * The sing-along line: the terminal's prompt, in the same place in every scene. Each line shows just before
   * it is sung and each word lights as it is sung. her and him color the lines of the dialogue.
   */
  function karaoke(sc) {
    const { tl, stage } = sc;
    const band = html(stage, `<div class="kband" data-layout-ignore></div>`);
    const mine = sc.lines.filter((l) => l.start >= -0.2 && l.start < sc.dur - 0.05);
    const shows = mine.map((l, i) => Math.max(i === 0 ? 0 : mine[i - 1].end + 0.02, l.start - 0.3, 0));
    mine.forEach((l, i) => {
      const hot = l.voice === "her" ? PINK : l.voice === "him" ? "#f0a878" : SUN;
      const el = html(band, `<div class="kline"><span class="kp">&gt;</span>${l.words.map((x) => `<span>${x.text}</span>`).join("")}<span class="kp kc" style="margin:0 0 0 -4px">_</span></div>`);
      const hide = shows[i + 1] ?? Math.min(l.end + 1.2, sc.dur);
      gsap.set(el, { opacity: 0 });
      tl.set(el, { opacity: 1 }, shows[i] + 0.001);
      if (hide < sc.dur - 0.02) tl.set(el, { opacity: 0 }, hide);
      [...el.querySelectorAll("span:not(.kp)")].forEach((span, k) => {
        const at = Math.max(0.002, l.words[k].start);
        tl.set(span, { color: hot }, at);
        tl.fromTo(span, { y: -12, scale: 1.12 }, { y: 0, scale: 1, duration: 0.2, ease: "power2.out", immediateRender: false }, at);
      });
    });
    return band;
  }

  /** A speech bubble whose words appear as they are spoken. side is which way its tail leans. */
  function bubble(sc, parent, line, x, y, { side = "left", color = CREAM, until = null } = {}) {
    const { tl } = sc;
    const el = html(parent, `<div class="bubble" style="background:${color}" data-layout-ignore>${line.words.map((w) => `<span>${w.text}</span>`).join("")}<svg viewBox="0 0 60 44" style="${side === "left" ? "left:70px" : "right:70px"}"><path d="${side === "left" ? "M4 0 L0 42 L48 0" : "M56 0 L60 42 L12 0"}" fill="${color}" ${L}/><path d="M-2 -4 H62" stroke="${color}" stroke-width="9"/></svg></div>`);
    gsap.set(el, { x, y, scale: 0, transformOrigin: side === "left" ? "15% 120%" : "85% 120%" });
    tl.to(el, { scale: 1, duration: 0.2, ease: "back.out(2)" }, Math.max(0, line.start - 0.12));
    [...el.querySelectorAll("span")].forEach((span, k) => {
      gsap.set(span, { opacity: 0.12 });
      tl.to(span, { opacity: 1, duration: 0.05 }, line.words[k].start);
      tl.fromTo(span, { y: -10 }, { y: 0, duration: 0.18, ease: "power2.out", immediateRender: false }, line.words[k].start);
    });
    if (until !== null) tl.to(el, { scale: 0, duration: 0.14, ease: "back.in(2)" }, until);
    return el;
  }

  /** The floor every scene stands on. */
  function ground(stage, color) {
    return html(stage, `<div class="ground" ${color ? `style="background:${color}"` : ""} data-layout-ignore></div>`);
  }
  /** Soft paper confetti dots behind the action, so a flat color isn't empty. */
  function dots(stage, seed, color = "#ecdcc0", n = 26) {
    const r = S.rand(seed);
    const wrap = html(stage, `<div class="abs" style="width:1920px;height:880px" data-layout-ignore></div>`);
    for (let i = 0; i < n; i++) {
      const size = 14 + r() * 40;
      html(wrap, `<div class="abs" style="left:${Math.round(r() * 1900)}px;top:${Math.round(r() * 840)}px;width:${size}px;height:${size}px;border-radius:50%;background:${color}"></div>`);
    }
    return wrap;
  }

  /** A green tick in a circle, centered on (x, y), popping in at t. */
  function tick(tl, parent, x, y, t, scale = 1) {
    const el = html(parent, `<svg class="prop" width="${90 * scale}" height="${90 * scale}" viewBox="0 0 90 90" data-layout-ignore><circle cx="45" cy="45" r="38" fill="${TEAL}" ${L}/><path d="M26 46 L40 60 L64 32" fill="none" stroke="#fff" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/></svg>`);
    gsap.set(el, { x: x - 45 * scale, y: y - 45 * scale, scale: 0, transformOrigin: "50% 50%" });
    tl.to(el, { scale: 1, duration: 0.24, ease: "back.out(3)" }, t);
    return el;
  }

  /** Text typed one character at a time between t0 and t1. Returns the line's element. */
  function type(tl, parent, text, t0, t1, style = "") {
    const el = html(parent, `<div class="mono" style="white-space:pre;${style}">${[...text].map((c) => `<span style="opacity:0">${c === "<" ? "&lt;" : c === ">" ? "&gt;" : c}</span>`).join("")}</div>`);
    const spans = [...el.children];
    spans.forEach((sp, i) => tl.set(sp, { opacity: 1 }, t0 + ((t1 - t0) * i) / spans.length));
    return el;
  }

  /** Both hands drum on something in front of the mouse, from t0 to t1. */
  function typing(tl, m, t0, t1) {
    let i = 0;
    for (let t = t0; t < t1; t += 0.11, i++) {
      tl.to(m.armL, { rotation: i % 2 ? 44 : 66, duration: 0.1, ease: "sine.inOut" }, t);
      tl.to(m.armR, { rotation: i % 2 ? -66 : -44, duration: 0.1, ease: "sine.inOut" }, t);
    }
  }

  // Verse 1 builds this crew and the pre-chorus keeps it: the mouse on the dev server, an agent on each side, panes packed around.
  const TOP = [60, 365, 670, 975, 1280, 1585];
  function crew(stage) {
    const paneL = pane(stage, { w: 360, h: 250, title: "agent", color: TEAL, rows: 7, seed: 11 });
    place(paneL, 320, 280);
    const paneR = pane(stage, { w: 360, h: 250, title: "agent", color: PINK, rows: 7, seed: 12 });
    place(paneR, 1240, 280);
    const extras = TOP.map((x, i) => { const p = pane(stage, { w: 276, h: 172, title: ["logs", "tests", "git", "build", "docs", "db"][i], color: [SUN, BLUE, PINK, TEAL, SUN, BLUE][i], rows: 5, seed: 20 + i }); place(p, x, 50); return p; });
    const sideL = pane(stage, { w: 236, h: 210, title: "htop", color: BLUE, rows: 6, seed: 31 });
    place(sideL, 50, 300);
    const sideR = pane(stage, { w: 236, h: 210, title: "ssh", color: SUN, rows: 6, seed: 32 });
    place(sideR, 1634, 300);
    const sv = server(stage, {});
    gsap.set(sv.el, { x: 750, y: 694 });
    const m = mouse(stage, { scale: 1, prop: "baton" });
    stand(m, 960, 706);
    const botL = bot(stage, { scale: 1.3, color: TEAL });
    gsap.set(botL.el, { x: 370, y: 563 });
    const botR = bot(stage, { scale: 1.3, color: PINK });
    gsap.set(botR.el, { x: 1290, y: 563 });
    return { m, sv, botL, botR, paneL, paneR, extras, sideL, sideR };
  }

  /**
   * The inside of a train car, W wide: wall, windows with the country going by, a rail of straps and the back of a bench.
   * Seated passengers go in after this and before trainSeat, which covers their legs.
   */
  function train(parent, W, tl, dur, { windows = [120, 750, 1380], speed = 520 } = {}) {
    const wrap = html(parent, `<div class="abs" style="width:${W}px;height:1080px;background:#cfe6dd" data-layout-ignore>
      <div style="position:absolute;left:0;right:0;top:430px;height:450px;background:#b5d6cb;border-top:7px solid ${INK}"></div>
      <div style="position:absolute;left:0;right:0;top:56px;height:12px;background:${GREY};border:5px solid ${INK};border-left:0;border-right:0"></div>
      <div style="position:absolute;left:-20px;right:-20px;top:560px;height:330px;background:${RED};border:7px solid ${INK};border-radius:40px 40px 0 0"></div>
      <div style="position:absolute;left:0;right:0;top:600px;height:8px;background:${INK};opacity:.18"></div></div>`);
    const straps = [];
    for (let x = 60; x < W; x += 210) {
      const st = html(wrap, `<svg class="prop" width="60" height="110" viewBox="0 0 60 110" style="left:${x}px;top:64px"><g><path d="M30 0 V46" stroke="${INK}" stroke-width="7"/><path d="M12 54 H48 L42 100 H18 Z" fill="none" stroke="${INK}" stroke-width="8" stroke-linejoin="round"/></g></svg>`);
      gsap.set(st.firstElementChild, { svgOrigin: "30 0" });
      straps.push(st.firstElementChild);
    }
    windows.forEach((x, i) => {
      const win = html(wrap, `<div style="position:absolute;left:${x}px;top:120px;width:420px;height:270px;background:#aee0f5;border:7px solid ${INK};border-radius:30px;overflow:hidden"></div>`);
      const r = S.rand(90 + i);
      const strip = html(win, `<svg class="prop" width="2400" height="270" viewBox="0 0 2400 270">${Array.from({ length: 9 }, (_, k) => `<ellipse cx="${k * 280 + r() * 120}" cy="${250 + r() * 30}" rx="${180 + r() * 90}" ry="${70 + r() * 70}" fill="${k % 2 ? "#7cc69a" : "#9ad6a6"}"/>`).join("")}${Array.from({ length: 6 }, (_, k) => `<rect x="${k * 400 + 60}" y="40" width="14" height="230" fill="${INK}" opacity="0.55"/><circle cx="${k * 400 + 240 + r() * 60}" cy="${50 + r() * 40}" r="${22 + r() * 12}" fill="#fff" opacity="0.9"/>`).join("")}</svg>`);
      const travel = Math.min(1900, speed * dur);
      tl.fromTo(strip, { x: -(i * 40) }, { x: -(i * 40) - travel, duration: dur, ease: "none" }, 0);
    });
    return { wrap, straps };
  }
  function trainSeat(parent, W) {
    return html(parent, `<div class="abs" style="left:-20px;top:770px;width:${W + 40}px;height:120px;background:#c9514a;border:7px solid ${INK};border-radius:30px 30px 0 0" data-layout-ignore></div>`);
  }
  /** A phone held in front of a seated mouse, its screen facing us. */
  function heldPhone(parent, x, y, scale = 1) {
    const el = html(parent, `<svg class="prop" width="${120 * scale}" height="${190 * scale}" viewBox="0 0 120 190" data-layout-ignore><rect x="6" y="6" width="108" height="178" rx="20" fill="${TILE}" ${L}/><rect x="18" y="20" width="84" height="26" rx="8" fill="${TEAL}"/><rect x="18" y="54" width="84" height="26" rx="8" fill="${PINK}"/><rect x="18" y="88" width="84" height="26" rx="8" fill="${SUN}"/><rect class="hp-thumbL" x="16" y="130" width="38" height="40" rx="12" fill="${CREAM}" opacity="0.25"/><rect class="hp-thumbR" x="66" y="130" width="38" height="40" rx="12" fill="${CREAM}" opacity="0.25"/></svg>`);
    gsap.set(el, { x: x - 60 * scale, y: y - 95 * scale });
    return { el, thumbs: [el.querySelector(".hp-thumbL"), el.querySelector(".hp-thumbR")] };
  }
  /** Thumbs tap in turn, from t0 to t1. */
  function thumbing(tl, phone, m, t0, t1) {
    let i = 0;
    for (let t = t0; t < t1; t += 0.14, i++) {
      tl.fromTo(phone.thumbs[i % 2], { opacity: 0.95 }, { opacity: 0.25, duration: 0.13, immediateRender: false }, t);
      tl.fromTo(i % 2 ? m.armR : m.armL, { y: -7 }, { y: 0, duration: 0.12, immediateRender: false }, t);
    }
  }

  /** A jump to stand at (x, y), leaving at t and landing dur later. */
  function leap(tl, m, t, x, y, { rise = 160, dur = 0.34 } = {}) {
    const tx = x - 150 * m.scale, ty = y - 408 * m.scale;
    tl.to(m.el, { x: tx, duration: dur, ease: "none" }, t);
    tl.to(m.el, { y: (i, el) => Math.min(gsap.getProperty(el, "y"), ty) - rise, duration: dur * 0.5, ease: "power2.out" }, t);
    tl.to(m.el, { y: ty, duration: dur * 0.5, ease: "power2.in" }, t + dur * 0.5);
    tl.fromTo(m.all, { scaleY: 0.82, scaleX: 1.1 }, { scaleY: 1, scaleX: 1, duration: 0.3, ease: "elastic.out(1, 0.5)", immediateRender: false }, t + dur);
  }
  /** Arms thrown up in turn on every half beat: the dance. */
  function dance(tl, m, beats, { from = -1, to = 1e9 } = {}) {
    beats.filter((b) => b.t >= from && b.t < to).forEach((b) => {
      [0, 0.333].forEach((d, k) => {
        const left = (b.n + k) % 2 === 0;
        tl.to(m.armL, { rotation: left ? 150 : 50, duration: 0.16, ease: "back.out(2)" }, b.t + d);
        tl.to(m.armR, { rotation: left ? -50 : -150, duration: 0.16, ease: "back.out(2)" }, b.t + d);
      });
    });
  }

  Object.assign(S, { train, trainSeat, heldPhone, thumbing, leap, dance, tick, type, typing, crew, INK, TILE, FUR, PAPER, CREAM, TEAL, SUN, PINK, BLUE, RED, GREY, HAIR, GROUND, L, place, mouse, stand, girlLook, bot, server, pane, tile, bell, ringBell, ringAt, flash, pop, bop, bounce, sing, wordsOf, blink, hop, karaoke, bubble, ground, dots });
})();

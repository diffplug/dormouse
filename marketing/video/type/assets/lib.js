// The art for the "type" film: kinetic typography on flat color fields. Everything here is deterministic and seek-safe:
// elements start hidden, and every change after that is a tween or a set on the scene's timeline.
(function () {
  const C = { orange: "#e8834a", iconOrange: "#d38d5f", char: "#43423d", ink: "#1f1b18", cream: "#f3eadb", cobalt: "#2b45d9", lime: "#d9ff3d" };
  const BEAT = 60 / 90;

  /** An absolutely placed div. Size and place in px; anything else goes in css. */
  function box(parent, { x = 0, y = 0, w, h, bg, cls = "", css = "", text = "", html = "" } = {}) {
    const el = document.createElement("div");
    el.className = `abs ${cls}`.trim();
    el.style.cssText = `left:${x}px;top:${y}px;${w != null ? `width:${w}px;` : ""}${h != null ? `height:${h}px;` : ""}${bg ? `background:${bg};` : ""}${css}`;
    if (html) el.innerHTML = html;
    else if (text) el.textContent = text;
    parent.appendChild(el);
    return el;
  }

  /** A run of type. size in px; cls picks the face: big, mono, serif. */
  function type(parent, text, { x = 0, y = 0, size = 200, cls = "big", color = C.cream, css = "", w } = {}) {
    return box(parent, { x, y, w, cls, text, css: `font-size:${size}px;color:${color};${css}` });
  }

  /** A full-frame color field. */
  const field = (parent, color, css = "") => box(parent, { w: 1920, h: 1080, bg: color, css });

  /** Hidden until t, and hidden again at until. */
  function show(tl, el, t, until) {
    gsap.set(el, { autoAlpha: 0 });
    tl.set(el, { autoAlpha: 1 }, Math.max(0, t));
    if (until != null) tl.set(el, { autoAlpha: 0 }, until);
    return el;
  }
  const hide = (tl, el, t) => tl.set(el, { autoAlpha: 0 }, t);

  /**
   * The hit: an element appears just before t, already readable, and lands with a kick.
   * from is the starting scale; dx, dy and rot are where it flies in from.
   */
  function slam(tl, el, t, { from = 1.5, dur = 0.32, lead = 0.04, until, ease = "expo.out", dx = 0, dy = 0, rot = 0, origin = "50% 50%" } = {}) {
    show(tl, el, t - lead, until);
    gsap.set(el, { transformOrigin: origin });
    tl.fromTo(el, { scale: from, x: dx, y: dy, rotation: rot }, { scale: 1, x: 0, y: 0, rotation: 0, duration: dur, ease, immediateRender: false }, Math.max(0, t - lead));
    return el;
  }

  /** A pop: grows from nothing past full size and settles. */
  const pop = (tl, el, t, o = {}) => slam(tl, el, t, { from: 0.2, dur: 0.45, ease: "back.out(3)", ...o });

  /** A sweep: a block grows from one edge. dir is "left", "right", "top" or "bottom". */
  function wipe(tl, el, t, dir = "left", dur = 0.28, ease = "expo.out") {
    const axis = dir === "left" || dir === "right" ? "scaleX" : "scaleY";
    const origin = { left: "0% 50%", right: "100% 50%", top: "50% 0%", bottom: "50% 100%" }[dir];
    gsap.set(el, { transformOrigin: origin });
    show(tl, el, t);
    tl.fromTo(el, { [axis]: 0 }, { [axis]: 1, duration: dur, ease, immediateRender: false }, Math.max(0, t));
    return el;
  }

  /** Changes a field's color at each [t, color]. The first one is its color from the start. */
  function cuts(tl, el, list) {
    gsap.set(el, { backgroundColor: list[0][1] });
    list.slice(1).forEach(([t, c]) => tl.set(el, { backgroundColor: c }, t));
  }

  /**
   * One lyric line as a row of words, each appearing as it is sung: the engine every small word in the film rides on.
   * Returns the row and its word spans, so a scene can kick the ones it cares about.
   */
  function sing(tl, parent, line, { x = 0, y = 0, size = 60, cls = "mono", color = C.cream, gap = 0.28, css = "", lead = 0.05, upper = false, until, kick = 0, skip = [] } = {}) {
    const row = box(parent, { x, y, cls, css: `font-size:${size}px;color:${color};white-space:nowrap;${css}` });
    const spans = line.words.map((wd, i) => {
      const s = document.createElement("span");
      s.className = "kw";
      s.textContent = upper ? wd.text.toUpperCase() : wd.text;
      if (i) s.style.marginLeft = `${gap}em`;
      row.appendChild(s);
      if (skip.includes(i)) { gsap.set(s, { visibility: "hidden" }); return s; }
      gsap.set(s, { autoAlpha: 0 });
      tl.set(s, { autoAlpha: 1 }, Math.max(0, wd.start - lead));
      if (kick) tl.fromTo(s, { y: kick }, { y: 0, duration: 0.25, ease: "expo.out", immediateRender: false }, Math.max(0, wd.start - lead));
      return s;
    });
    if (until != null) hide(tl, row, until);
    return { row, spans };
  }

  /** Splits a run of type into one span per letter. */
  function letters(el) {
    const text = el.textContent;
    el.textContent = "";
    return [...text].map((ch) => {
      const s = document.createElement("span");
      s.className = "kw";
      s.textContent = ch === " " ? " " : ch;
      el.appendChild(s);
      return s;
    });
  }

  /** A cursor block that is on for the first half of each beat in [from, to). */
  function blink(tl, el, beats, from, to, { on = 0.5 } = {}) {
    gsap.set(el, { autoAlpha: 0 });
    beats.filter((b) => b.t >= from - 0.001 && b.t < to).forEach((b) => {
      tl.set(el, { autoAlpha: 1 }, b.t);
      tl.set(el, { autoAlpha: 0 }, b.t + BEAT * on);
    });
  }

  /** A short shake of the whole stage, for the biggest hits. */
  function shake(tl, el, t, amp = 18) {
    [1, -0.7, 0.45, -0.2, 0].forEach((k, i) => tl.to(el, { x: amp * k, y: -amp * k * 0.5, duration: 0.04, ease: "none" }, t + i * 0.04));
  }

  /** A full-frame flash of one color that fades. */
  function flash(tl, parent, t, color = C.cream, dur = 0.3) {
    const f = field(parent, color);
    gsap.set(f, { autoAlpha: 0 });
    tl.fromTo(f, { autoAlpha: 1 }, { autoAlpha: 0, duration: dur, ease: "power2.out", immediateRender: false }, t);
    return f;
  }

  /** A full-frame layer that exists only from t to until: one lyric line's layout. */
  function section(tl, parent, t, until, bg) {
    const el = box(parent, { w: 1920, h: 1080, bg, css: "overflow:hidden" });
    show(tl, el, t, until);
    return el;
  }

  /** The words of a scene's lines, flattened, with their line ids. */
  const allWords = (sc) => sc.lines.flatMap((l) => l.words.map((w) => ({ ...w, line: l.id, voice: l.voice })));

  Object.assign(window.S, { C, BEAT, box, type, field, show, hide, slam, pop, wipe, cuts, sing, letters, blink, shake, flash, section, allWords });
})();

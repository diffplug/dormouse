var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// ../lib/src/host/alert-store-host.ts
var alert_store_host_exports = {};
__export(alert_store_host_exports, {
  createAlertStoreHost: () => createAlertStoreHost
});
module.exports = __toCommonJS(alert_store_host_exports);

// ../lib/src/cfg.ts
var cfg = {
  marchingAnts: {
    /** Target segment length (dash + gap) in px. Smaller = more, tinier dashes. */
    segLen: 10,
    /** Fraction of each segment that is a visible dash (remainder is gap). */
    dashFraction: 0.6,
    /** Seconds for one full dash-gap cycle. */
    cycleDuration: 0.4,
    /** Cycles to run when command mode starts or the active selection changes. */
    cyclesPerSelection: 4,
    /** Stroke width in px. */
    strokeWidth: 2,
    /** When true, animation is frozen at T=0 (for deterministic Chromatic snapshots). */
    paused: false
  },
  alert: {
    /** ms — enough elapsed time to treat ongoing output as a possible busy transition. */
    busyCandidateGap: 1500,
    /** ms — additional evidence window before calling the Session BUSY. */
    busyConfirmGap: 500,
    /** ms — silence after BUSY before suspecting completion. */
    mightNeedAttention: 2e3,
    /** ms — additional silence before confirming NEEDS_ATTENTION. */
    needsAttentionConfirm: 3e3,
    /** ms — ignore resize redraw noise. */
    resizeDebounce: 500,
    /** ms — attention idle expiry. How long before "looking at this pane" wears off. */
    userAttention: 15e3,
    /** When true, the ALERT_RINGING bell-ring animation is frozen at T=0 (for deterministic Chromatic snapshots). */
    ringingPaused: false
  },
  terminal: {
    /** xterm cursor blink. Disabled under Chromatic so the cursor renders as a
     *  stable solid block rather than being captured mid-blink (non-deterministic). */
    cursorBlink: true,
    /** Render terminals through `@xterm/addon-webgl` instead of xterm's DOM
     *  renderer. Disabled under Chromatic: the GPU path paints into a `<canvas>`,
     *  which snapshots as an opaque bitmap subject to driver differences, whereas
     *  the DOM renderer emits styled spans that diff deterministically. Turning it
     *  off also gives a way to A/B the renderer when diagnosing a rendering bug
     *  (`docs/specs/layout.md` → Renderer). */
    webglRenderer: true,
    /** Load `@xterm/addon-image`, giving every Session SIXEL, iTerm IIP, and
     *  Kitty graphics. Must be decided before the first PTY byte, not on the
     *  first image: the addon answers the DA1 / XTSMGRAPHICS / cell-size probes
     *  a program uses to decide whether to send one at all, so a Session that
     *  loads it late has already advertised no graphics support
     *  (`docs/specs/terminal-escapes.md` → Inline graphics). Turning it off
     *  drops that decode path for untrusted PTY bytes and its per-Session
     *  handlers. */
    inlineImages: true
  },
  layout: {
    /** When false, Lath pane geometry changes (split / restore / kill / drag) apply
     *  instantly with no tween. Disabled under Chromatic: a mid-tween split resizes
     *  panes through many transient widths (briefly near-zero), and xterm's DOM
     *  renderer can latch onto one of those frames and leave a pane painted blank or
     *  clipped (`user@dormouse:~$` → `user@do`) even after the geometry settles.
     *  Snapping straight to the final geometry removes that whole race. */
    animate: true
  },
  overlays: {
    /** ms before the illegal-rename warning dismisses itself. 0 disables the
     *  timer entirely — what Chromatic uses, because a popover that removes
     *  itself three seconds after the play function ends is present or absent
     *  in the capture depending on how loaded the runner is. */
    warningAutoDismissMs: 3e3
  },
  focusRing: {
    // Directional motion smear while the focus ring travels between panes, drawn as
    // a layer of bands behind the ring. A line smears only by moving ACROSS itself,
    // so each of the four edges is driven by its own perpendicular speed (px/ms) and
    // the four are independent — moving between panes flush at the top, the top edge
    // never smears while the bottom edge does. A settled or reduced-motion ring has
    // null speeds, so it never smears (see WorkspaceSelectionOverlay).
    /** Edge speed (px/ms) at which the smear is fully developed — the knob that sets
     *  the effect's SHAPE over a travel. Below it, extent and intensity scale
     *  linearly with speed; at or above it, both sit at their ceilings. The house
     *  ease-out peaks around 16 px/ms on a full-width pane travel and averages ~3.7,
     *  so 8 holds full smear through the fast opening and then decays with real
     *  velocity. Lower it for a more uniform blur, raise it to make blur track speed
     *  more closely (short hops then smear noticeably less than long jumps). */
    smearFullSpeed: 8,
    /** How far a smear band reaches at full speed (px) — the effect's EXTENT. 12px on
     *  the 2px ants stroke is a 6x spread. Independent of intensity: see
     *  smearPeakAlpha, and the note in WorkspaceSelectionOverlay on why this is not
     *  tied to alpha by ink conservation. */
    smearMaxPx: 12,
    /** Alpha a band reaches at full speed — the effect's INTENSITY. Kept well under 1
     *  so the smear reads as motion behind the ring rather than as a second, fatter
     *  ring; raise it (not smearMaxPx) to make the blur punchier without extending
     *  its reach. */
    smearPeakAlpha: 1 / 3
  }
};

// ../lib/src/lib/alert-settings-model.ts
var MIN_DELAY_MS = 1e3;
var MAX_DELAY_MS = 6e5;
var DEFAULT_ALERT_SETTINGS = {
  // cfg.ts stays the single source of the shipped default.
  inactivityTimeoutMs: cfg.alert.userAttention,
  deferAlertsUntilQuiet: false,
  speakEnabled: false,
  speakDelayMs: 1e4,
  pushEnabled: false,
  pushDelayMs: 2e4
};
function clampAlertDelayMs(ms) {
  return Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, Math.round(ms)));
}
function clampDelay(value, fallback) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return clampAlertDelayMs(value);
}
function bool(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}
function normalizeAlertSettings(value) {
  const raw = typeof value === "object" && value !== null ? value : {};
  return {
    inactivityTimeoutMs: clampDelay(raw.inactivityTimeoutMs, DEFAULT_ALERT_SETTINGS.inactivityTimeoutMs),
    deferAlertsUntilQuiet: bool(raw.deferAlertsUntilQuiet, DEFAULT_ALERT_SETTINGS.deferAlertsUntilQuiet),
    speakEnabled: bool(raw.speakEnabled, DEFAULT_ALERT_SETTINGS.speakEnabled),
    speakDelayMs: clampDelay(raw.speakDelayMs, DEFAULT_ALERT_SETTINGS.speakDelayMs),
    pushEnabled: bool(raw.pushEnabled, DEFAULT_ALERT_SETTINGS.pushEnabled),
    pushDelayMs: clampDelay(raw.pushDelayMs, DEFAULT_ALERT_SETTINGS.pushDelayMs)
  };
}

// ../lib/src/lib/alert-settings-host.ts
var AlertSettingsHost = class {
  constructor(target) {
    this.target = target;
  }
  target;
  initialized = false;
  settings = DEFAULT_ALERT_SETTINGS;
  listeners = /* @__PURE__ */ new Set();
  /** Offered by every renderer at startup; only the first offer is taken. */
  initialize(value) {
    if (!this.initialized) {
      this.initialized = true;
      this.apply(value);
    }
    this.publish();
  }
  /** An explicit edit from a renderer. Always authoritative. */
  update(value) {
    this.initialized = true;
    this.apply(value);
    this.publish();
  }
  subscribe(listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  apply(value) {
    this.settings = normalizeAlertSettings(value);
    this.target.applySettings(this.settings);
  }
  publish() {
    for (const listener of this.listeners) listener(this.settings);
  }
};

// ../lib/src/lib/watched-command-host.ts
var WatchedCommandHost = class {
  constructor(target) {
    this.target = target;
  }
  target;
  initialized = false;
  listeners = /* @__PURE__ */ new Set();
  initialize(names) {
    if (!this.initialized) {
      this.initialized = true;
      this.target.setWatchedCommands(names);
    }
    this.publish();
  }
  setCommandWatched(name, watched) {
    this.initialized = true;
    this.target.setCommandWatched(name, watched);
    this.publish();
  }
  subscribe(listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  publish() {
    const names = this.target.getWatchedCommands();
    for (const listener of this.listeners) listener(names);
  }
};

// ../lib/src/host/alert-store-host.ts
var WatchedCommandMemory = class {
  names = [];
  getWatchedCommands() {
    return [...this.names];
  }
  setWatchedCommands(names) {
    this.names = [...new Set(names.filter((name) => typeof name === "string" && name.length > 0))];
  }
  /** A delta, never a replacement: a stale window must not drop the rules it
   *  has not heard about yet. */
  setCommandWatched(name, watched) {
    const next = new Set(this.names);
    if (watched) next.add(name);
    else next.delete(name);
    this.names = [...next];
  }
};
var AlertSettingsMemory = class {
  settings = null;
  applySettings(settings) {
    this.settings = settings;
  }
};
function createAlertStoreHost(options) {
  const watchedMemory = new WatchedCommandMemory();
  const settingsMemory = new AlertSettingsMemory();
  const watched = new WatchedCommandHost(watchedMemory);
  const settings = new AlertSettingsHost(settingsMemory);
  const stopWatched = watched.subscribe((names) => options.send("alert:watchedCommands", { names }));
  const stopSettings = settings.subscribe((value) => options.send("alert:settings", { settings: value }));
  return {
    handle(command) {
      const message = command;
      if (!message || typeof message.op !== "string") return;
      switch (message.op) {
        case "initializeWatchedCommands":
          watched.initialize(Array.isArray(message.names) ? message.names.filter(
            (name) => typeof name === "string"
          ) : []);
          return;
        case "setCommandWatched":
          if (typeof message.name !== "string" || typeof message.watched !== "boolean") return;
          watched.setCommandWatched(message.name, message.watched);
          return;
        case "initializeSettings":
          settings.initialize(message.settings);
          return;
        case "updateSettings":
          settings.update(message.settings);
          return;
        default:
          return;
      }
    },
    dispose() {
      stopWatched();
      stopSettings();
    }
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  createAlertStoreHost
});

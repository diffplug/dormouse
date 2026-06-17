/**
 * Per-surface bridge between an agent-browser pane's body (AgentBrowserPanel)
 * and its tab header (SurfacePaneHeader) + the screen modal, which are
 * separate components for one pane (see docs/specs/dor-agent-browser.md →
 * "Screen Indicator & Viewport").
 *
 * The panel owns the live state (viewport, pane size, sync) and the action
 * (`runAgentBrowser`); the header and modal only read a snapshot and invoke
 * actions. So the panel registers a controller keyed by its surface id; the
 * header derives "this pane is an agent-browser surface" purely from the
 * presence of a controller for `api.id`.
 *
 * Two stores, both consumed via useSyncExternalStore:
 *   1. a surface-id-keyed controller registry (presence + per-controller
 *      snapshot subscription), mirroring `terminal-lifecycle.ts`;
 *   2. a single "which surface's screen modal is open" value, mirroring
 *      `external-link-confirmation.ts`.
 */
import { useSyncExternalStore } from 'react';

export type ScreenState = 'SYNCED' | 'SCALED';

export interface ScreenSnapshot {
  state: ScreenState;
  /** The browser's live CSS viewport + inferred device pixel ratio. */
  viewport: { w: number; h: number; dpr: number };
  /** The pane's CSS pixel size (the canvas render area). */
  paneCss: { w: number; h: number };
  /** The Dormouse window's device pixel ratio. */
  displayDpr: number;
  syncEngaged: boolean;
}

export interface ScreenActions {
  /** Follow the pane pixel-for-pixel (Dormouse-side behavior, not native). */
  engageSync(): void;
  /** Issue native `set device <name>` (bundles viewport + DPR + touch + UA). */
  applyDevice(name: string): void;
  /** Issue native `set viewport <w> <h> <dpr>`. */
  applyViewport(w: number, h: number, dpr: number): void;
  /** Open the screen modal for this surface. */
  openModal(): void;
}

/** What the browser-chrome header reads about the active tab
 *  (docs/specs/dor-agent-browser.md → "Browser-chrome header"). Updated on its
 *  own cadence (tab stream messages), separate from the screen snapshot which
 *  churns on resize. */
export interface ChromeSnapshot {
  /** Active tab's full URL — used to extract the loopback port + as a tooltip
   *  fallback. */
  url: string;
  /** Active tab's host+path (header primary text). */
  displayUrl: string;
  /** Active tab's HTML `<title>` (header tooltip), or null. */
  title: string | null;
  /** Managed `--key` for this surface, or null for raw `--session` / no key.
   *  The header shows a badge for non-`default` keys only. */
  key: string | null;
}

export interface ChromeActions {
  /** Native `open <url>` — navigate the active tab to a new URL. */
  navigate(url: string): void;
  /** Native `back` — move history back one entry (no-op at the start). */
  back(): void;
  /** Native `forward` — move history forward one entry (no-op at the end). */
  forward(): void;
  /** Native `reload` — reload the active tab. */
  reload(): void;
}

export interface ScreenController {
  readonly id: string;
  subscribe(listener: () => void): () => void;
  snapshot(): ScreenSnapshot;
  readonly actions: ScreenActions;
  /** Browser-chrome (URL / key) channel — separate subscription so
   *  tab updates don't churn the screen snapshot and vice versa. */
  subscribeChrome(listener: () => void): () => void;
  chrome(): ChromeSnapshot;
  readonly chromeActions: ChromeActions;
  /** Whether the host can run `agentBrowserCommand` (false ⇒ resizes inert). */
  readonly hostCapable: boolean;
}

interface ScreenEntry {
  snapshot: ScreenSnapshot;
  listeners: Set<() => void>;
  chrome: ChromeSnapshot;
  chromeListeners: Set<() => void>;
  controller: ScreenController;
}

const registry = new Map<string, ScreenEntry>();
const presenceListeners = new Set<() => void>();

function emitPresence(): void {
  for (const listener of presenceListeners) listener();
}

export interface ScreenRegistration {
  /** Push a new snapshot; notifies subscribers. Callers should pass a fresh
   *  object only when something actually changed (the panel gates on flip /
   *  dim change to avoid thrashing the header per frame). */
  update(snapshot: ScreenSnapshot): void;
  /** Push a new browser-chrome snapshot (URL / key); notifies the
   *  chrome subscribers. Gated by the panel on its tab effects. */
  updateChrome(chrome: ChromeSnapshot): void;
  dispose(): void;
}

/** Register a surface's screen controller (panel mount). `actions` /
 *  `chromeActions` must be stable objects whose methods read the panel's
 *  current closures (e.g. via refs), so the controller never goes stale across
 *  panel re-renders. */
export function registerAgentBrowserScreen(
  id: string,
  init: {
    snapshot: ScreenSnapshot;
    actions: ScreenActions;
    chrome: ChromeSnapshot;
    chromeActions: ChromeActions;
    hostCapable: boolean;
  },
): ScreenRegistration {
  const entry: ScreenEntry = {
    snapshot: init.snapshot,
    listeners: new Set(),
    chrome: init.chrome,
    chromeListeners: new Set(),
    controller: {
      id,
      subscribe(listener) {
        entry.listeners.add(listener);
        return () => entry.listeners.delete(listener);
      },
      snapshot: () => entry.snapshot,
      actions: init.actions,
      subscribeChrome(listener) {
        entry.chromeListeners.add(listener);
        return () => entry.chromeListeners.delete(listener);
      },
      chrome: () => entry.chrome,
      chromeActions: init.chromeActions,
      hostCapable: init.hostCapable,
    },
  };
  registry.set(id, entry);
  emitPresence();
  return {
    update(snapshot) {
      entry.snapshot = snapshot;
      for (const listener of entry.listeners) listener();
    },
    updateChrome(chrome) {
      entry.chrome = chrome;
      for (const listener of entry.chromeListeners) listener();
    },
    dispose() {
      if (registry.get(id) === entry) {
        registry.delete(id);
        emitPresence();
      }
    },
  };
}

export function getAgentBrowserScreenController(id: string): ScreenController | null {
  return registry.get(id)?.controller ?? null;
}

export function subscribeAgentBrowserScreenPresence(listener: () => void): () => void {
  presenceListeners.add(listener);
  return () => {
    presenceListeners.delete(listener);
  };
}

// --- screen modal open state (one at a time) ---

let modalSurfaceId: string | null = null;
const modalListeners = new Set<() => void>();

function emitModalChange(): void {
  for (const listener of modalListeners) listener();
}

export function openAgentBrowserScreenModal(id: string): void {
  if (modalSurfaceId === id) return;
  modalSurfaceId = id;
  emitModalChange();
}

export function closeAgentBrowserScreenModal(): void {
  if (modalSurfaceId === null) return;
  modalSurfaceId = null;
  emitModalChange();
}

export function getOpenAgentBrowserScreenModalId(): string | null {
  return modalSurfaceId;
}

export function subscribeAgentBrowserScreenModal(listener: () => void): () => void {
  modalListeners.add(listener);
  return () => {
    modalListeners.delete(listener);
  };
}

// --- React hooks ---

/** The controller for a surface, or null if it isn't an agent-browser surface.
 *  Re-renders when controllers register/unregister (presence). */
export function useAgentBrowserScreenController(id: string): ScreenController | null {
  return useSyncExternalStore(
    subscribeAgentBrowserScreenPresence,
    () => getAgentBrowserScreenController(id),
  );
}

const NO_SUBSCRIBE = () => () => {};

/** A controller's live snapshot (SYNCED/SCALED + dims), or null. Re-renders on
 *  every published snapshot for that controller. */
export function useAgentBrowserScreenSnapshot(controller: ScreenController | null): ScreenSnapshot | null {
  return useSyncExternalStore(
    controller ? controller.subscribe : NO_SUBSCRIBE,
    () => controller?.snapshot() ?? null,
  );
}

/** A controller's live browser-chrome snapshot (URL / key), or
 *  null for a non-browser surface. Re-renders only on tab/status changes. */
export function useAgentBrowserChromeSnapshot(controller: ScreenController | null): ChromeSnapshot | null {
  return useSyncExternalStore(
    controller ? controller.subscribeChrome : NO_SUBSCRIBE,
    () => controller?.chrome() ?? null,
  );
}

/** The surface id whose screen modal is open, or null. */
export function useOpenAgentBrowserScreenModalId(): string | null {
  return useSyncExternalStore(subscribeAgentBrowserScreenModal, getOpenAgentBrowserScreenModalId);
}

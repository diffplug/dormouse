/**
 * Display modal for a web surface (docs/specs/dor-agent-browser.md → "Screen
 * Indicator & Viewport → The modal"; docs/specs/dor-iframe.md → "Path 1 —
 * Swappable Render Backend"). Opened from the header's far-left chip, it is the
 * single place that owns *how* a surface renders:
 *
 *   - Render — swap the backend in place (Screencast ↔ Embed), preserving the
 *     target. Shown only when the controller wires `setRenderMode`.
 *   - Screen — viewport for the screencast backend; a GUI front-end for native
 *     `agent-browser set viewport` / `set device`, plus the Dormouse-side
 *     *Sync to pane*. Greyed out in embed (the iframe renders at the pane size).
 *   - Pop out — relaunch the browser headed as an OS window (screencast only,
 *     gated on `canPopOut`).
 *
 * It reads the live snapshot on open and pre-selects accordingly, reflecting
 * reality rather than a stored intent.
 */
import { useMemo, useRef, useState } from 'react';
import { ArrowSquareOutIcon } from '@phosphor-icons/react';
import { ModalCloseButton, ModalFrame, modalActionButton } from '../design';
import type { RenderMode, ScreenController, ScreenSnapshot } from './agent-browser-screen';
import { useAgentBrowserScreenSnapshot } from './agent-browser-screen';

// Fixed registry — the CLI's own device set. No custom descriptors; touch +
// mobile UA come only bundled inside `set device` (verified against 0.27.0).
const DEVICES = [
  'iPhone 15',
  'iPhone 16',
  'iPhone 16 Pro',
  'iPhone 17',
  'iPad',
  'iPad Pro',
  'Pixel 9',
  'Galaxy S25',
] as const;

type Target = 'sync' | 'device' | 'custom';

function formatDpr(dpr: number): string {
  return `${Number.isInteger(dpr) ? dpr : Math.round(dpr * 100) / 100}x`;
}

export function AgentBrowserScreenModal({
  controller,
  label,
  onClose,
}: {
  controller: ScreenController;
  label: string;
  onClose: () => void;
}) {
  const live = useAgentBrowserScreenSnapshot(controller);
  // Snapshot the state the modal opened with for pre-selection; the live one
  // still drives the "Currently" readout so it tracks external changes.
  const [initial] = useState<ScreenSnapshot | null>(() => controller.snapshot());
  const snapshot = live ?? initial;

  const cancelRef = useRef<HTMLButtonElement>(null);
  const hostCapable = controller.hostCapable;

  // Pre-select: Sync if engaged + actually synced; otherwise Custom prefilled
  // with the current dims. (A device can't be pre-matched — the CLI doesn't
  // expose device dims up front, so there's no dims map to compare against.)
  const initialTarget: Target =
    initial?.syncEngaged && initial.state === 'SYNCED' ? 'sync' : 'custom';
  const [target, setTarget] = useState<Target>(initialTarget);
  const [device, setDevice] = useState<string>(DEVICES[1]); // iPhone 16
  const [customW, setCustomW] = useState(String(initial?.viewport.w ?? 1280));
  const [customH, setCustomH] = useState(String(initial?.viewport.h ?? 720));
  const [customDpi, setCustomDpi] = useState(String(initial?.viewport.dpr ?? 1));

  // Render backend (Path 1). The Render section only appears when the surface
  // wires `setRenderMode` (the swap is wired); otherwise the modal is the plain
  // screencast viewport modal it has always been.
  const currentMode: RenderMode = snapshot?.renderMode ?? 'screencast';
  const canSwapRender = !!controller.actions.setRenderMode;
  const [renderMode, setRenderMode] = useState<RenderMode>(currentMode);
  const isEmbed = renderMode === 'embed';
  // Pop out is a screencast-only escape hatch, gated per host/platform.
  const canPopOut = (controller.canPopOut ?? false) && !!controller.actions.popOut;

  const customValid = useMemo(() => {
    const w = Number(customW);
    const h = Number(customH);
    const dpi = Number(customDpi);
    return Number.isInteger(w) && w > 0 && Number.isInteger(h) && h > 0 && dpi > 0 && Number.isFinite(dpi);
  }, [customW, customH, customDpi]);

  // Embed has no viewport to set, so its only gate is the render swap itself.
  const applyDisabled = isEmbed ? false : (!hostCapable || (target === 'custom' && !customValid));

  const apply = () => {
    if (applyDisabled) return;
    if (renderMode !== currentMode) controller.actions.setRenderMode?.(renderMode);
    if (renderMode === 'screencast') {
      if (target === 'sync') controller.actions.engageSync();
      else if (target === 'device') controller.actions.applyDevice(device);
      else controller.actions.applyViewport(Number(customW), Number(customH), Number(customDpi));
    }
    onClose();
  };

  const popOut = () => {
    controller.actions.popOut?.();
    onClose();
  };

  const vp = snapshot?.viewport;
  const pane = snapshot?.paneCss;

  return (
    <ModalFrame
      titleId="agent-browser-screen-modal-title"
      layer="critical"
      backdrop="strong"
      elevation="modal"
      overlayClassName="px-4 py-6"
      className="w-full max-w-[30rem]"
      initialFocusRef={cancelRef}
      onEscape={onClose}
    >
      <div className="flex items-start gap-3">
        <h2
          id="agent-browser-screen-modal-title"
          className="min-w-0 flex-1 text-sm leading-5 text-foreground"
        >
          Display — <span className="font-semibold">{label}</span>
        </h2>
        <ModalCloseButton onClick={onClose} />
      </div>

      {snapshot && (
        <div className="mt-3 text-xs text-muted">
          Currently{' '}
          <span className="font-semibold text-foreground">
            {currentMode === 'embed' ? 'EMBED' : snapshot.state}
          </span>
          {currentMode === 'embed' ? (
            <div className="mt-0.5">the page's own DOM, rendered at the pane size</div>
          ) : vp && pane ? (
            <div className="mt-0.5 font-mono">
              browser {vp.w}×{vp.h}
              {'  ·  '}
              pane {pane.w}×{pane.h} @{formatDpr(snapshot.displayDpr)}
            </div>
          ) : null}
        </div>
      )}

      {canSwapRender && (
        <fieldset className="mt-4">
          <legend className="text-xs font-semibold tracking-wide text-muted uppercase">Render</legend>
          <div className="mt-2 flex flex-col gap-2 text-sm">
            <label className="flex cursor-pointer items-start gap-2">
              <input
                type="radio"
                name="render-mode"
                className="mt-0.5"
                checked={renderMode === 'screencast'}
                onChange={() => setRenderMode('screencast')}
              />
              <span className="min-w-0">
                <span className="text-foreground">Screencast (browser)</span>
                <span className="mt-0.5 block text-xs text-muted">real Chromium, agent-drivable, any URL</span>
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-2">
              <input
                type="radio"
                name="render-mode"
                className="mt-0.5"
                checked={renderMode === 'embed'}
                onChange={() => setRenderMode('embed')}
              />
              <span className="min-w-0">
                <span className="text-foreground">Embed (iframe)</span>
                <span className="mt-0.5 block text-xs text-muted">the page's own DOM, zero-lag, loopback only</span>
              </span>
            </label>
          </div>
        </fieldset>
      )}

      <fieldset className="mt-4" disabled={isEmbed}>
        {canSwapRender && (
          <legend className="text-xs font-semibold tracking-wide text-muted uppercase">
            Screen <span className="font-normal normal-case">· screencast only</span>
          </legend>
        )}
        <div className={`mt-2 flex flex-col gap-3 text-sm ${isEmbed ? 'opacity-40' : ''}`}>
        <label className="flex cursor-pointer items-start gap-2">
          <input
            type="radio"
            name="screen-target"
            className="mt-0.5"
            checked={target === 'sync'}
            onChange={() => setTarget('sync')}
          />
          <span className="min-w-0">
            <span className="text-foreground">Sync to pane</span>
            <span className="mt-0.5 block text-xs text-muted">
              viewport follows the pane, pixel-for-pixel
              {pane ? ` → now: ${pane.w}×${pane.h} @${formatDpr(snapshot?.displayDpr ?? 1)}` : ''}
            </span>
          </span>
        </label>

        <label className="flex cursor-pointer items-start gap-2">
          <input
            type="radio"
            name="screen-target"
            className="mt-0.5"
            checked={target === 'device'}
            onChange={() => setTarget('device')}
          />
          <span className="min-w-0 flex-1">
            <span className="text-foreground">Device</span>
            <span className="ml-2 text-xs text-muted">emulates touch + mobile UA</span>
            <span className="mt-1.5 grid grid-cols-2 gap-1">
              {DEVICES.map((name) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => { setTarget('device'); setDevice(name); }}
                  className={`rounded border px-2 py-1 text-left text-xs transition-colors ${
                    target === 'device' && device === name
                      ? 'border-focus-ring bg-header-inactive-bg text-foreground'
                      : 'border-border text-muted hover:text-foreground'
                  }`}
                >
                  {name}
                </button>
              ))}
            </span>
            <span className="mt-1 block text-xs text-muted">
              dimensions fill in after applying
            </span>
          </span>
        </label>

        <label className="flex cursor-pointer items-start gap-2">
          <input
            type="radio"
            name="screen-target"
            className="mt-0.5"
            checked={target === 'custom'}
            onChange={() => setTarget('custom')}
          />
          <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            <span className="text-foreground">Custom</span>
            <DimInput label="W" value={customW} onChange={setCustomW} onFocus={() => setTarget('custom')} />
            <DimInput label="H" value={customH} onChange={setCustomH} onFocus={() => setTarget('custom')} />
            <DimInput label="DPI" value={customDpi} onChange={setCustomDpi} onFocus={() => setTarget('custom')} />
          </span>
        </label>
        </div>
      </fieldset>

      {!hostCapable && !isEmbed && (
        <p className="mt-3 text-xs text-muted">
          This host can't drive the browser viewport; run <span className="font-mono">dor ab set …</span> from a
          terminal instead.
        </p>
      )}

      {canPopOut && renderMode === 'screencast' && (
        <button
          type="button"
          onClick={popOut}
          className="mt-4 flex items-center gap-2 rounded border border-border px-2.5 py-1.5 text-xs text-muted transition-colors hover:border-foreground hover:text-foreground"
        >
          <ArrowSquareOutIcon size={14} />
          Pop out to window…
        </button>
      )}

      <div className="mt-4 flex justify-end gap-2 text-xs">
        <button
          ref={cancelRef}
          type="button"
          onClick={onClose}
          className={`${modalActionButton({ tone: 'secondary' })} min-w-[5rem]`}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={apply}
          disabled={applyDisabled}
          className={`${modalActionButton({ tone: 'primary' })} min-w-[5rem]`}
        >
          Apply
        </button>
      </div>
    </ModalFrame>
  );
}

function DimInput({
  label,
  value,
  onChange,
  onFocus,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  onFocus: () => void;
}) {
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted">
      {label}
      <input
        type="text"
        inputMode="numeric"
        value={value}
        onFocus={onFocus}
        onChange={(e) => onChange(e.target.value.replace(/[^0-9.]/g, ''))}
        className="w-16 rounded border border-border bg-app-bg px-1.5 py-1 font-mono text-foreground outline-none focus:border-focus-ring"
      />
    </span>
  );
}

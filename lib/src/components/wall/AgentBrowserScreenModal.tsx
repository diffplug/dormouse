/**
 * Display modal for a web surface (docs/specs/dor-agent-browser.md → "Screen
 * Indicator & Viewport → The modal"; docs/specs/dor-iframe.md → "Path 1 —
 * Swappable Render Backend"). Opened from the header's far-left chip, it is the
 * single place that owns *how* a surface renders:
 *
 *   - Render — swap the backend in place, preserving the target:
 *     `agent-browser screencast`, `agent-browser popout` (relaunch headed as a
 *     native OS window), or `iframe embed`. Each lists its agent/URL/feel
 *     trade-offs. Shown only when the controller wires `setRenderMode`; the
 *     popout option is gated on `canPopOut` (hidden on web).
 *   - Resolution — the screencast viewport: *Resize with pane* (linked to the
 *     pane) or *Fixed* (a specific resolution chosen via Device or Custom).
 *     Specific to screencast, so it nests under that option and greys out
 *     whenever a different render mode is selected.
 *
 * It reads the live snapshot on open and pre-selects accordingly, reflecting
 * reality rather than a stored intent.
 */
import { useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ArrowSquareOutIcon,
  CheckIcon,
  FrameCornersIcon,
  LinkIcon,
  LockSimpleIcon,
  XIcon,
} from '@phosphor-icons/react';
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

  // Render backend (Path 1 + Headed Pop-Out). The Render section only appears
  // when the surface wires `setRenderMode` (the swap is wired); otherwise the
  // modal is the plain screencast viewport modal it has always been.
  const currentMode: RenderMode = snapshot?.renderMode ?? 'screencast';
  const canSwapRender = !!controller.actions.setRenderMode;
  const [renderMode, setRenderMode] = useState<RenderMode>(currentMode);
  // Pop-out is a render mode, gated per host/platform (hidden on web).
  const canPopOut = controller.canPopOut ?? false;
  // Only the screencast backend has a Dormouse-settable viewport; pop-out is a
  // native OS window and embed renders at the pane size, so both grey it out.
  const viewportDisabled = renderMode !== 'screencast';
  // Within screencast, the resolution is either linked to the pane (resize with
  // pane) or fixed — Device/Custom are the two ways to pick the fixed size.
  const isFixed = target === 'device' || target === 'custom';

  const customValid = useMemo(() => {
    const w = Number(customW);
    const h = Number(customH);
    const dpi = Number(customDpi);
    return Number.isInteger(w) && w > 0 && Number.isInteger(h) && h > 0 && dpi > 0 && Number.isFinite(dpi);
  }, [customW, customH, customDpi]);

  // A non-screencast mode has no viewport to set, so its only gate is the swap.
  const applyDisabled = viewportDisabled ? false : (!hostCapable || (target === 'custom' && !customValid));

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

  // Screencast resolution controls: Resize with pane (viewport linked to the
  // pane) vs a Fixed resolution chosen via Device or Custom. Rendered nested
  // under the screencast render option (or standalone when the surface can't
  // swap render mode), and greyed whenever the active mode isn't screencast.
  const viewportControls = (
    <fieldset disabled={viewportDisabled} className={viewportDisabled ? 'opacity-40' : ''}>
      <div className="text-xs font-semibold tracking-wide text-muted uppercase">Resolution</div>
      <div className="mt-2 flex flex-col gap-3 text-sm">
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="radio"
            name="screen-target"
            checked={target === 'sync'}
            onChange={() => setTarget('sync')}
          />
          <LinkIcon size={14} className="shrink-0 text-muted" />
          <span className="text-foreground">Resize with pane</span>
        </label>

        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-3">
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="radio"
                name="screen-target"
                checked={isFixed}
                onChange={() => setTarget('custom')}
              />
              <LockSimpleIcon size={14} className="shrink-0 text-muted" />
              <span className="text-foreground">Fixed</span>
            </label>
            {/* Dimensions inline; or pick a device via Emulate below (emulating
                disables the dims — they fill in from the next frames). */}
            <div className="flex items-center gap-2">
              <DimInput label="W" chars={4} value={customW} disabled={target === 'device'} onChange={setCustomW} onFocus={() => setTarget('custom')} />
              <DimInput label="H" chars={4} value={customH} disabled={target === 'device'} onChange={setCustomH} onFocus={() => setTarget('custom')} />
              <DimInput label="DPI" chars={1} value={customDpi} disabled={target === 'device'} onChange={setCustomDpi} onFocus={() => setTarget('custom')} />
            </div>
          </div>
          <label className="ml-6 flex items-center gap-2 text-xs text-muted">
            <span>Emulate</span>
            <select
              value={target === 'device' ? device : ''}
              onChange={(e) => {
                const name = e.target.value;
                if (name) { setTarget('device'); setDevice(name); }
                else setTarget('custom');
              }}
              title="touch + mobile UA"
              className="rounded border border-border bg-app-bg px-1.5 py-1 font-mono text-foreground outline-none focus:border-focus-ring"
            >
              <option value="">none</option>
              {DEVICES.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          </label>
        </div>
      </div>
    </fieldset>
  );

  return (
    <ModalFrame
      titleId="agent-browser-screen-modal-title"
      layer="critical"
      backdrop="strong"
      elevation="modal"
      overlayClassName="px-4 py-6"
      className="max-h-[85vh] w-full max-w-[30rem] overflow-y-auto"
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

      {canSwapRender ? (
        <div className="mt-4 flex flex-col gap-3">
          {/* agent-browser screencast — no mode icon of its own; its two
              resolution modes (resize-with-pane / fixed) carry the link / lock
              glyphs. The resolution controls nest here and grey out when
              another render mode wins. */}
          <div className="flex flex-col gap-1.5 text-sm">
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="radio"
                name="render-mode"
                checked={renderMode === 'screencast'}
                onChange={() => setRenderMode('screencast')}
              />
              <span className="text-foreground">agent-browser screencast</span>
            </label>
            <div className="ml-6 flex flex-col gap-0.5 text-xs">
              <Feature ok>agents can read/write</Feature>
              <Feature ok>any URL</Feature>
              <Feature ok={false}>laggy for humans</Feature>
            </div>
            <div className="ml-6 mt-2">{viewportControls}</div>
          </div>

          {canPopOut && (
            <div className="flex flex-col gap-1.5 text-sm">
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="radio"
                  name="render-mode"
                  checked={renderMode === 'popout'}
                  onChange={() => setRenderMode('popout')}
                />
                <ArrowSquareOutIcon size={14} className="shrink-0 text-muted" />
                <span className="text-foreground">agent-browser popout</span>
              </label>
              <div className="ml-6 flex flex-col gap-0.5 text-xs">
                <Feature ok>agents can read/write</Feature>
                <Feature ok>any URL</Feature>
                <Feature ok>native human experience</Feature>
              </div>
            </div>
          )}

          <div className="flex flex-col gap-1.5 text-sm">
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="radio"
                name="render-mode"
                checked={renderMode === 'embed'}
                onChange={() => setRenderMode('embed')}
              />
              <FrameCornersIcon size={14} className="shrink-0 text-muted" />
              <span className="text-foreground">iframe embed</span>
            </label>
            <div className="ml-6 flex flex-col gap-0.5 text-xs">
              <Feature ok={false}>agents cannot read/write</Feature>
              <Feature ok={false}>localhost only</Feature>
              <Feature ok>native human experience</Feature>
            </div>
          </div>
        </div>
      ) : (
        // No render swap wired: the legacy plain screencast resolution modal.
        <div className="mt-4">{viewportControls}</div>
      )}

      {!hostCapable && !viewportDisabled && (
        <p className="mt-3 text-xs text-muted">
          This host can't drive the browser viewport; run <span className="font-mono">dor ab set …</span> from a
          terminal instead.
        </p>
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

/** One trade-off line for a render mode: a green check (has the property) or a
 *  red x (lacks it), then the label. Matches the user's agent/URL/feel matrix. */
function Feature({ ok, children }: { ok?: boolean; children: ReactNode }) {
  return (
    <span className="flex items-center gap-1.5 text-muted">
      {ok
        ? <CheckIcon size={12} weight="bold" className="shrink-0 text-success" />
        : <XIcon size={12} weight="bold" className="shrink-0 text-error" />}
      {children}
    </span>
  );
}

function DimInput({
  label,
  value,
  onChange,
  onFocus,
  disabled,
  chars = 4,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  onFocus: () => void;
  disabled?: boolean;
  /** Max digits the field holds — sizes the box so W/H/DPI stay compact. */
  chars?: number;
}) {
  return (
    <span className={`inline-flex items-center gap-1 text-xs text-muted ${disabled ? 'opacity-50' : ''}`}>
      {label}
      <input
        type="text"
        inputMode="numeric"
        value={value}
        disabled={disabled}
        onFocus={onFocus}
        onChange={(e) => onChange(e.target.value.replace(/[^0-9.]/g, ''))}
        style={{ width: `calc(${chars}ch + 0.5rem)` }}
        className="border-0 border-b border-border bg-transparent px-0.5 py-0.5 font-mono text-foreground outline-none focus:border-focus-ring"
      />
    </span>
  );
}

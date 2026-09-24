/**
 * Display modal for a web surface (docs/specs/dor-browser.md → "Display Modal
 * And Render Swaps"). Opened from the header's far-left chip, it is the
 * single place that owns *how* a surface renders:
 *
 *   - Render — swap the backend in place, preserving the target: each
 *     provider's screencast and popout (relaunch headed as a native OS
 *     window), or `iframe embed`. Each lists its agent/URL/feel trade-offs.
 *     Shown only when the controller wires `setRenderMode`, offering only the
 *     modes the controller declares in `renderModes`.
 *   - Resolution — the screencast viewport: *Resize with pane* (linked to the
 *     pane) or *Fixed* (a specific resolution chosen via Device or Custom).
 *     Specific to screencast, so it nests under that option and greys out
 *     whenever a different render mode is selected.
 *
 * It snapshots the opening render/resolution intent for pre-selection; the
 * live snapshot tracks the current render mode so Apply can detect a backend
 * swap.
 */
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { CheckIcon, XIcon } from '@phosphor-icons/react';
import {
  MODAL_OVERLAY_INSET,
  modalActionButton,
  ModalCloseButton,
  ModalFrame,
  NumericInput,
  OVERLAY_MAX_HEIGHT,
} from '../design';
import type { RenderMode, ScreenController, ScreenSnapshot } from './agent-browser-screen';
import { browserDisplayMode, useAgentBrowserChromeSnapshot, useAgentBrowserScreenSnapshot } from './agent-browser-screen';
import { AUTOMATION_PROVIDERS, automationMode, automationProvider, isScreencast, PROVIDER_LABEL } from './browser-automation';
import { iframeRefusal } from './browser-url';
import {
  AgentRobotIcon,
  BROWSER_DISPLAY_LABEL,
  BrowserDisplayIcon,
  BrowserPresentationIcon,
} from './BrowserDisplayIcon';

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

const PLAYWRIGHT_DEVICES = ['iPhone 15', 'iPhone 16', 'iPhone 16 Pro', 'iPhone 17', 'iPad (gen 11)', 'iPad Pro 11', 'Pixel 9', 'Galaxy S24'];

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
  const chrome = useAgentBrowserChromeSnapshot(controller);
  // Snapshot the state the modal opened with for pre-selection; the live one
  // still tracks the current render mode so external changes update whether
  // Apply is swapping backends.
  const [initial] = useState<ScreenSnapshot | null>(() => controller.snapshot());
  const snapshot = live ?? initial;

  const cancelRef = useRef<HTMLButtonElement>(null);
  const hostCapable = controller.hostCapable;

  // Pre-select from intent, not the transient dimension comparison: while a
  // resize is landing, sync stays engaged even though the live state is SCALED.
  // A fixed device can't be pre-matched — the CLI exposes no dims map.
  const initialTarget: Target = initial?.syncEngaged ? 'sync' : 'custom';
  const [target, setTarget] = useState<Target>(initialTarget);
  const [device, setDevice] = useState<string>(DEVICES[1]); // iPhone 16
  const [customW, setCustomW] = useState(String(initial?.viewport.w ?? 1280));
  const [customH, setCustomH] = useState(String(initial?.viewport.h ?? 720));
  const [customDpi, setCustomDpi] = useState(String(initial?.viewport.dpr ?? 1));

  // Render backend (Path 1 + Pop-Out). The Render section only appears
  // when the surface wires `setRenderMode` (the swap is wired); otherwise the
  // modal is the plain screencast viewport modal it has always been.
  const currentMode: RenderMode = snapshot?.renderMode ?? 'ab-screencast';
  const canSwapRender = !!controller.actions.setRenderMode;
  const [renderMode, setRenderMode] = useState<RenderMode>(currentMode);
  // The controller declares what this Surface can take (a tool never pops out
  // or changes provider); the current mode always shows so it stays selected.
  const offered = (mode: RenderMode) => mode === currentMode || controller.renderModes.includes(mode);
  const embedRefusal = currentMode === 'iframe' ? null : iframeRefusal(chrome?.url ?? '');
  // Only the screencast backend has a Dormouse-settable viewport; pop-out is a
  // native OS window and embed renders at the pane size, so both grey it out.
  const viewportDisabled = !isScreencast(renderMode);
  // Whether Apply changes the render backend (vs only tweaking the current
  // screencast's viewport). A swap is gated on whether its option is shown, not
  // on the viewport-drive capability below.
  const switchingMode = renderMode !== currentMode;
  // Within screencast, the resolution is either linked to the pane (resize with
  // pane) or fixed — Device/Custom are the two ways to pick the fixed size.
  const isFixed = target === 'device' || target === 'custom';

  const customValid = useMemo(() => {
    const w = Number(customW);
    const h = Number(customH);
    const dpi = Number(customDpi);
    return Number.isInteger(w) && w > 0 && Number.isInteger(h) && h > 0 && dpi > 0 && Number.isFinite(dpi);
  }, [customW, customH, customDpi]);

  // Apply gating splits three ways:
  //   - non-screencast target (embed/popout): no viewport to set; the swap is
  //     the action, gated only on its option being shown — always enabled.
  //   - swapping TO screencast (from embed/popout): spawns a fresh session that
  //     drives its own viewport, so the *current* surface's viewport-drive
  //     capability is irrelevant — always enabled. (This is the embed→screencast
  //     bug: an embed surface reports hostCapable:false, which used to dead-lock
  //     Apply even though switching needs only the spawn capability.)
  //   - staying on screencast (tweaking the viewport): needs the host to drive
  //     `set viewport`, and a valid custom size.
  const applyDisabled =
    viewportDisabled || switchingMode
      ? false
      : (!hostCapable || (target === 'custom' && !customValid));

  const apply = () => {
    if (applyDisabled) return;
    if (switchingMode) {
      // A mode swap; the viewport sub-controls don't apply to the outgoing
      // surface (and are inert on embed/popout controllers anyway).
      controller.actions.setRenderMode?.(renderMode);
    } else if (isScreencast(renderMode)) {
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
    <fieldset disabled={viewportDisabled} className={viewportDisabled ? 'opacity-40' : undefined}>
      <div className="text-xs font-semibold tracking-wide text-muted uppercase">Resolution</div>
      <div className="mt-2 flex flex-col gap-3 text-sm">
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="radio"
            name="screen-target"
            checked={target === 'sync'}
            onChange={() => setTarget('sync')}
          />
          <BrowserPresentationIcon mode="ab-resize" size={14} className="shrink-0 text-muted" />
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
              <BrowserPresentationIcon mode="ab-fixed" size={14} className="shrink-0 text-muted" />
              <span className="text-foreground">Fixed size</span>
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
              {(automationProvider(renderMode) === 'playwright' ? PLAYWRIGHT_DEVICES : DEVICES).map((name) => (
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
      overlayClassName={MODAL_OVERLAY_INSET}
      className={`${OVERLAY_MAX_HEIGHT.modal} w-full max-w-[30rem] overflow-y-auto`}
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
          {/* Screencast owns the robot capability glyph; its nested resolution
              modes append the presentation glyph. */}
          {AUTOMATION_PROVIDERS.map((provider) => {
            const screencast = automationMode(provider, false);
            const popout = automationMode(provider, true);
            if (!offered(screencast) && !offered(popout)) return null;
            const popoutDisplay = browserDisplayMode({ renderMode: popout, syncEngaged: false });
            return (
              <div key={provider} className="flex flex-col gap-3">
                {offered(screencast) && (
                  <RenderOption
                    checked={renderMode === screencast}
                    onSelect={() => setRenderMode(screencast)}
                    icon={<AgentRobotIcon size={14} className="shrink-0 text-muted" />}
                    label={`${PROVIDER_LABEL[provider]} screencast`}
                    features={[[true, 'agents can read/write'], [true, 'any URL'], [false, 'laggy for humans']]}
                  >
                    {renderMode === screencast && <div className="ml-6 mt-2">{viewportControls}</div>}
                  </RenderOption>
                )}
                {offered(popout) && (
                  <RenderOption
                    checked={renderMode === popout}
                    onSelect={() => setRenderMode(popout)}
                    icon={<BrowserDisplayIcon mode={popoutDisplay} size={14} className="text-muted" />}
                    label={BROWSER_DISPLAY_LABEL[popoutDisplay]}
                    features={[[true, 'agents can read/write'], [true, 'any URL'], [true, 'native human experience']]}
                  />
                )}
              </div>
            );
          })}
          {offered('iframe') && (
            <RenderOption
              checked={renderMode === 'iframe'}
              onSelect={() => setRenderMode('iframe')}
              icon={<BrowserDisplayIcon mode="iframe" size={14} className="text-muted" />}
              label={BROWSER_DISPLAY_LABEL.iframe}
              features={[[false, 'agents cannot read/write'], [false, 'http only'], [false, 'no logins/cookies'], [true, 'native human experience']]}
              disabledReason={embedRefusal ?? undefined}
            />
          )}
        </div>
      ) : (
        // No render swap wired: the legacy plain screencast resolution modal.
        <div className="mt-4">{viewportControls}</div>
      )}

      {!hostCapable && !viewportDisabled && !switchingMode && (
        <p className="mt-3 text-xs text-muted">
          This host can't drive the browser viewport; run <span className="font-mono">{automationProvider(currentMode) === 'playwright' ? 'dor pw resize …' : 'dor ab set …'}</span> from a
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

/** One render-backend option: a radio + optional mode icon + label, then its
 *  agent/URL/feel trade-offs. Screencast passes its nested resolution controls
 *  as children. */
function RenderOption({
  checked,
  onSelect,
  icon,
  label,
  features,
  disabledReason,
  children,
}: {
  checked: boolean;
  onSelect: () => void;
  icon?: ReactNode;
  label: string;
  features: [boolean, string][];
  /** Why this option cannot be chosen here; absent ⇒ enabled. */
  disabledReason?: string;
  children?: ReactNode;
}) {
  const disabled = disabledReason !== undefined;
  return (
    <div className="flex flex-col gap-1.5 text-sm">
      <label className={`flex items-center gap-2 ${disabled ? 'cursor-not-allowed opacity-45' : 'cursor-pointer'}`}>
        <input type="radio" name="render-mode" checked={checked} disabled={disabled} onChange={onSelect} />
        {icon}
        <span className="text-foreground">{label}</span>
        {disabled && <span className="text-xs text-muted">— {disabledReason}</span>}
      </label>
      <div className="ml-6 flex flex-col gap-0.5 text-xs">
        {features.map(([ok, text]) => <Feature key={text} ok={ok}>{text}</Feature>)}
      </div>
      {children}
    </div>
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
      <NumericInput
        value={value}
        onChange={onChange}
        chars={chars}
        disabled={disabled}
        onFocus={onFocus}
      />
    </span>
  );
}

/**
 * The body of a `tool` Surface: one Session with a terminal and, once it
 * serves, a browser (`docs/specs/dor-tool.md` -> Lifecycle), which a preview
 * slot switch holds as a ghost until the next view is ready
 * (`docs/specs/dor-tool.md` -> Switching the slot).
 */
import { useContext } from 'react';
import { clsx } from 'clsx';
import { TERMINAL_BOTTOM_RADIUS_CLASS } from '../design';
import { previewLayerReady, type PreviewGhost, type PreviewTransition } from '../../lib/preview-transition-store';
import { BrowserPanel } from './BrowserPanel';
import { TerminalPanel } from './TerminalPanel';
import { ToolApproval } from './ToolApproval';
import { ToolPortConflict } from './ToolPortConflict';
import { toolFace } from './browser-surface';
import { BROWSER_LAYER_ATTRIBUTE, usePreviewSlotView } from './preview-transition';
import { TerminalContextContext, WallActionsContext } from './wall-context';
import type { PaneProps } from './pane-props';

/** The ghost blurs at once and eases deeper, or holds still when motion is
 *  instant; it takes no input. */
const ghostClass = (transition: PreviewTransition) =>
  clsx('pointer-events-none', transition.instant ? 'preview-ghost-static' : 'preview-ghost');

/** Keep hidden capability bodies sized. The primary xterm moves into the leaf's
 * context overlay while it is open; TerminalPanel then renders no second view.
 * The Session registry retains that xterm throughout the move. */
function Half({ face, shown, className, ghost = false, children }: {
  face: 'terminal' | 'browser';
  shown: boolean;
  className?: string | false | null;
  /** Held as a switch's ghost: shown, but inert. */
  ghost?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      data-tool-half={face}
      className={clsx('absolute inset-0', className)}
      // Inherit when shown: explicit `visible` escapes a hidden Workspace or
      // parked leaf, painting this face over the active Workspace.
      style={{ visibility: shown ? undefined : 'hidden' }}
      aria-hidden={!shown || ghost}
      inert={!shown || ghost}
    >
      {children}
    </div>
  );
}

type Layer = { generation: number; params: PaneProps['params']; role: 'live' | 'ghost' | 'incoming' };

/** The browser half's layers, keyed by generation: a committed switch mounts
 *  the next beside the ghost, which keeps its key and element. */
function browserLayers(params: PaneProps['params'], generation: number, ghost: PreviewGhost | null): Layer[] {
  if (!ghost) return [{ generation, params, role: 'live' }];
  const layers: Layer[] = [];
  if (ghost.kind === 'layer') layers.push({ generation: ghost.generation, params: ghost.params, role: 'ghost' });
  if (ghost.kind !== 'layer' || ghost.generation !== generation) layers.push({ generation, params, role: 'incoming' });
  return layers;
}

export function ToolPanel(props: PaneProps) {
  const face = toolFace(props.params);
  const actions = useContext(WallActionsContext);
  const context = useContext(TerminalContextContext);
  const { generation, transition } = usePreviewSlotView(props.id);

  // Rendered alone, not as one of two halves: mounting TerminalPanel would spawn
  // a shell in a repo the user has not approved yet. Nothing runs until they do.
  if (face === 'pending-approval') {
    return (
      <div className="relative h-full w-full"><ToolApproval
        {...props}
        onResolve={(id, choice) => actions.onResolveToolApproval(id, choice)}
      /></div>
    );
  }

  // A switch holds its ghost's face, never flipping to the terminal between
  // one command and the next; it reveals the new view over the ghost.
  const ghost = transition?.ghost ?? null;
  const revealing = transition?.phase === 'revealing';
  const terminalGhost = ghost?.kind === 'terminal';
  const revealsTerminal = revealing && face === 'terminal';
  const showTerminal = transition ? terminalGhost || revealsTerminal : face === 'terminal';
  const showSecond = transition ? !terminalGhost || face !== 'terminal' : face !== 'terminal';
  /** A layer's look and whether it takes input. The incoming one is laid out
   *  while hidden, never `display: none`, so it loads at its size. */
  const layerState = (role: Layer['role']): { className?: string; inert: boolean } => {
    if (role === 'live') return { inert: false };
    if (role === 'ghost') return { className: ghostClass(transition!), inert: true };
    return revealing && face !== 'terminal' ? { className: 'preview-reveal', inert: false } : { className: 'opacity-0', inert: true };
  };
  return (
    <div className={`relative h-full w-full overflow-hidden ${TERMINAL_BOTTOM_RADIUS_CLASS}`}>
      <Half
        face="terminal"
        shown={showTerminal}
        ghost={terminalGhost && !revealsTerminal}
        // Revealed in place when it is its own ghost; over the browser's ghost
        // otherwise.
        className={transition && (terminalGhost ? !revealsTerminal && ghostClass(transition) : revealsTerminal && 'z-10 preview-reveal')}
      >
        <TerminalPanel {...props} renderTerminal={context.mounted?.id !== props.id} parked={props.parked || !showTerminal || transition !== null} />
      </Half>
      <Half face="browser" shown={showSecond}>
        {/* A conflict and a browser are mutually exclusive by construction —
            autobind writes a conflict only when it declined to write a URL — so
            swapping the second half's content loses no browser state. */}
        {face === 'port-conflict' ? (
          <ToolPortConflict {...props} />
        ) : (
          // A switch's layers take no input; a press still selects the pane.
          <div className="absolute inset-0" onMouseDown={transition ? () => actions.onClickPanel(props.id) : undefined}>
            {ghost?.kind === 'image' && (
              <div className={clsx('absolute inset-0 bg-terminal-bg', ghostClass(transition!))} inert aria-hidden>
                {ghost.src && ghost.rect && <img src={ghost.src} alt="" className="absolute max-w-none" style={ghost.rect} />}
              </div>
            )}
            {browserLayers(props.params, generation, ghost).map(layer => {
              const state = layerState(layer.role);
              return (
                <div
                  key={layer.generation}
                  {...{ [BROWSER_LAYER_ATTRIBUTE]: layer.role }}
                  className={clsx('absolute inset-0', state.className)}
                  inert={state.inert}
                  aria-hidden={state.inert || undefined}
                >
                  {/* Parked while hidden, so a screencast idles instead of decoding
                      frames nobody is looking at (`useSurfaceVisibility`). */}
                  <BrowserPanel
                    {...props}
                    params={layer.params}
                    parked={props.parked || !showSecond}
                    onReady={layer.role === 'ghost' ? undefined : () => previewLayerReady(props.id, layer.generation)}
                  />
                </div>
              );
            })}
          </div>
        )}
      </Half>
    </div>
  );
}

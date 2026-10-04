/**
 * The body of a `tool` Surface: one Session with a terminal and, once it
 * serves, a browser (`docs/specs/dor-tool.md` -> Lifecycle), which a preview
 * slot switch holds as a ghost until the next view is ready
 * (`docs/specs/dor-tool.md` -> Switching the slot).
 */
import { useCallback, useContext } from 'react';
import { clsx } from 'clsx';
import { TERMINAL_BOTTOM_RADIUS_CLASS } from '../design';
import { previewLayerReady, type GhostRect, type PreviewGhost, type PreviewTransition } from '../../lib/preview-transition-store';
import { BrowserPanel } from './BrowserPanel';
import { TerminalPanel } from './TerminalPanel';
import { ToolApproval } from './ToolApproval';
import { ToolPortConflict } from './ToolPortConflict';
import { toolFace, type ToolFace } from './browser-surface';
import { BROWSER_LAYER_ATTRIBUTE, usePreviewSlotView } from './preview-transition';
import { TerminalContextContext, WallActionsContext } from './wall-context';
import type { PaneProps } from './pane-props';

/** What a half or browser layer is during a switch, or outside one (`live`,
 *  `hidden`). */
type Role = 'live' | 'hidden' | 'ghost' | 'incoming' | 'revealing';

/** A role's look and whether it takes input: the ghost blurs at once and
 *  eases deeper, or holds still when motion is instant; an incoming layer is
 *  laid out while hidden, never `display: none`, so it loads at its size. */
function roleState(role: Role, instant: boolean): { shown: boolean; inert: boolean; className?: string } {
  switch (role) {
    case 'live': return { shown: true, inert: false };
    case 'hidden': return { shown: false, inert: true };
    case 'ghost': return { shown: true, inert: true, className: clsx('preview-ghost', instant && 'preview-ghost-static') };
    case 'incoming': return { shown: true, inert: true, className: 'opacity-0' };
    case 'revealing': return { shown: true, inert: false, className: 'preview-reveal' };
  }
}

/** The terminal half's role. A switch holds its ghost's face, never flipping
 *  to the terminal between one command and the next: the terminal is revealed
 *  in place when it is its own ghost, and over the browser's ghost otherwise. */
function terminalRole(face: ToolFace, transition: PreviewTransition | null): Role {
  if (!transition) return face === 'terminal' ? 'live' : 'hidden';
  const reveals = transition.phase === 'revealing' && face === 'terminal';
  if (transition.ghost.kind === 'terminal') return reveals ? 'live' : 'ghost';
  return reveals ? 'revealing' : 'hidden';
}

/** Keep hidden capability bodies sized (`visibility` and `inert`, never
 * `display: none`). The primary xterm moves into the leaf's
 * context overlay while it is open; TerminalPanel then renders no second view.
 * The Session registry retains that xterm throughout the move. */
function Half({ face, state, className, children }: {
  face: 'terminal' | 'browser';
  state: ReturnType<typeof roleState>;
  className?: string | false;
  children: React.ReactNode;
}) {
  return (
    <div
      data-tool-half={face}
      className={clsx('absolute inset-0', state.className, className)}
      // Inherit when shown: explicit `visible` escapes a hidden Workspace or
      // parked leaf, painting this face over the active Workspace.
      style={{ visibility: state.shown ? undefined : 'hidden' }}
      aria-hidden={state.inert}
      inert={state.inert}
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

/** A screencast ghost's copied frame, where its canvas sat. */
function GhostFrame({ frame }: { frame: { canvas: HTMLCanvasElement; rect: GhostRect } }) {
  const mount = useCallback((element: HTMLDivElement | null) => { element?.replaceChildren(frame.canvas); }, [frame.canvas]);
  return <div ref={mount} className="absolute" style={frame.rect} />;
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

  const ghost = transition?.ghost ?? null;
  const instant = transition?.instant ?? false;
  const terminal = terminalRole(face, transition);
  // A browser ghost shows until the switch ends; a new browser, over a
  // terminal ghost.
  const showSecond = face !== 'terminal' || (ghost !== null && ghost.kind !== 'terminal');
  const layerRole = (role: Layer['role']): Role =>
    role === 'incoming' && transition?.phase === 'revealing' && face !== 'terminal' ? 'revealing' : role;
  return (
    <div
      className={`relative h-full w-full overflow-hidden ${TERMINAL_BOTTOM_RADIUS_CLASS}`}
      // A switch's ghosts take no input; a press on one still selects the pane.
      onMouseDown={transition ? () => actions.onClickPanel(props.id) : undefined}
    >
      {/* Revealed over the browser's ghost, which follows it. */}
      <Half face="terminal" state={roleState(terminal, instant)} className={terminal === 'revealing' && 'z-10'}>
        <TerminalPanel {...props} renderTerminal={context.mounted?.id !== props.id} parked={props.parked || terminal === 'hidden' || transition !== null} />
      </Half>
      <Half face="browser" state={roleState(showSecond ? 'live' : 'hidden', instant)}>
        {/* A conflict and a browser are mutually exclusive by construction —
            autobind writes a conflict only when it declined to write a URL — so
            swapping the second half's content loses no browser state. */}
        {face === 'port-conflict' ? (
          <ToolPortConflict {...props} />
        ) : (
          <>
            {ghost?.kind === 'image' && (
              <div className={clsx('absolute inset-0 bg-terminal-bg', roleState('ghost', instant).className)} inert aria-hidden>
                {ghost.frame && <GhostFrame frame={ghost.frame} />}
              </div>
            )}
            {browserLayers(props.params, generation, ghost).map(layer => {
              const state = roleState(layerRole(layer.role), instant);
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
          </>
        )}
      </Half>
    </div>
  );
}

import { useContext, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { registry } from '../../lib/terminal-store';
import { messageOf } from '../../lib/errors';
import { wallHandleOwning } from './wall-handles';
import { MoveWorkspaceAction } from './MoveWorkspaceAction';
import { TerminalPane } from '../TerminalPane';
import { TerminalContextView, type ContextScan, type TerminalContextViewProps } from './TerminalContextView';
import { TerminalContextContext, WallActionsContext, WorkspaceActiveContext, type ContextMode, type TerminalContextState } from './wall-context';
import { getAux, auxRevision, openAux, resetAux, setAuxVisible, subscribeAuxTerminals } from '../../lib/aux-terminal';
import { isDelayedKillEnabled } from '../../lib/labs-settings';
import { DEFAULT_WORKSPACE_ID } from '../../lib/session-types';
import { getPlatform, IS_MAC, IS_WINDOWS } from '../../lib/platform';
import { createTerminalPaneState, cwdDisplay, deriveSurfaceLabel, explainTerminalTitle, type CwdState } from '../../lib/terminal-state';
import { focusSession, getRunningCommandWatchKey, getRunningCommandWatchRule, getTerminalInstance, getActivitySnapshot, getTerminalPaneStateSnapshot, setCommandWatched, subscribeToActivity, subscribeToTerminalPaneState, subscribeToWatchedCommands, getWatchedCommandsSnapshot, toggleSessionTodo } from '../../lib/terminal-registry';
import { writeTextToClipboard } from '../../lib/clipboard-write';
import { listenerUrlsByPort } from './port-url';
import { hostBrowserProviders } from './browser-automation';
import { ToolNavigationButtons } from './ToolNavigationButtons';

/** Whether the host can open `cwd` in its file manager. On Windows a POSIX
 *  directory opens only where it names a drive (WSL's `/mnt/c`, Git Bash's
 *  `/c`): a distro's own directories are reachable only through its share,
 *  which the host refuses. */
export function canOpenDirectory(cwd: CwdState, windows: boolean): boolean {
  if (cwd.isRemote) return false;
  return !windows || cwd.pathKind !== 'posix' || /^\/(?:mnt\/)?[a-z](?:\/|$)/i.test(cwd.path);
}

/** `preview`: the Surface is its Workspace's preview slot, which the context
 *  offers to keep (`docs/specs/layout.md` -> Pane header). */
export function TerminalContext({ id, mode: contextMode, title, closing, origin, warning: openWarning, tool = false, preview = false, placement, params }: Omit<TerminalContextState, 'mode'> & { mode: ContextMode; title?: string; tool?: boolean; preview?: boolean; params?: Record<string, unknown> } & Pick<TerminalContextViewProps, 'placement'>) {
  const context = useContext(TerminalContextContext);
  const actions = useContext(WallActionsContext);
  const workspaceActive = useContext(WorkspaceActiveContext);
  const states = useSyncExternalStore(subscribeToTerminalPaneState, getTerminalPaneStateSnapshot);
  const activities = useSyncExternalStore(subscribeToActivity, getActivitySnapshot);
  useSyncExternalStore(subscribeAuxTerminals, auxRevision);
  useSyncExternalStore(subscribeToWatchedCommands, getWatchedCommandsSnapshot);
  const [scan, setScan] = useState<ContextScan>({ status: 'scanning' });
  const [home, setHome] = useState('');
  const [auxError, setAuxError] = useState('');
  const platform = getPlatform();
  const aux = tool ? undefined : getAux(id);
  const state = states.get(id) ?? createTerminalPaneState();
  const cwd = state.cwd?.path ? state.cwd : undefined;
  const auxState = aux ? states.get(aux.id) : undefined;
  const auxCwd = auxState?.cwd?.path ? auxState.cwd : undefined;
  // A bare runner rule already covering the running script is the one the row offers.
  const watchRule = getRunningCommandWatchRule(id);
  const offeredRule = watchRule ?? getRunningCommandWatchKey(id);
  const titleSources = useMemo(() => explainTerminalTitle(state), [state]);
  const display = (location: CwdState) => cwdDisplay(location, { style: 'full', homePath: home });
  const auxMode = contextMode === 'aux';
  // The aux terminal starts on its first showing, never for properties alone.
  useEffect(() => {
    if (tool || !auxMode) return;
    let cancelled = false;
    void openAux(id).catch(e => { if (!cancelled) setAuxError(messageOf(e)); });
    return () => { cancelled = true; };
  }, [id, tool, auxMode]);
  useEffect(() => {
    let cancelled = false;
    void platform.terminalContext?.({ op: 'home' }).then(info => { if (!cancelled) setHome(info.home ?? ''); }).catch(() => {});
    void platform.getOpenPorts(id).then(ports => { if (!cancelled) setScan({ status: 'loaded', entries: listenerUrlsByPort(ports) }); }, () => { if (!cancelled) setScan({ status: 'failed' }); });
    return () => { cancelled = true; };
  }, [id, platform]);
  // The aux terminal polls only while the context shows it: an exit or a switch to
  // properties pauses it at once, and so does its Workspace going out of view,
  // which leaves the context open.
  useEffect(() => {
    if (closing || tool || !auxMode || !workspaceActive) return;
    setAuxVisible(id, true);
    return () => setAuxVisible(id, false);
  }, [id, closing, tool, auxMode, workspaceActive]);
  // No focus call: a passthrough source regains xterm focus through its own
  // `isFocused` once the context lets go, and in command mode the Session
  // must not hold focus, or unbound keys would reach its PTY.
  const onClose = context.close;
  const copy = async (value: string) => { if (!await writeTextToClipboard(value)) throw new Error('Could not copy to clipboard'); };
  const mismatch = !!aux && !!cwd && !!auxCwd && (cwd.path !== auxCwd.path || cwd.isRemote !== auxCwd.isRemote || (cwd.isRemote && cwd.host !== auxCwd.host));
  const source = wallHandleOwning(id);
  const warning = openWarning ?? (auxError || (aux && (!cwd || !auxCwd) ? 'Directory comparison unavailable: a terminal has not reported its directory.' : undefined));
  return <TerminalContextView placement={placement} mode={contextMode} onModeChange={context.setMode} terminalRole={tool ? 'tool' : 'aux'} closing={closing} origin={origin} surfaceId={id}
    navigation={tool ? <ToolNavigationButtons id={id} params={params} /> : undefined}
    workspaceMove={source?.canMoveSurfaces ? <MoveWorkspaceAction id={id} sourceId={source.workspaceId} /> : undefined} titleSources={titleSources} cwd={cwd ? display(cwd) : 'Directory unknown'} auxCwd={auxCwd && display(auxCwd)} mismatch={mismatch}
    scan={scan} watchRule={offeredRule} watching={watchRule !== null} todo={activities.get(id)?.todo === true} notification={activities.get(id)?.notification}
    runningCommand={tool && state.currentCommand ? state.currentCommand.rawCommandLine ?? '' : undefined} exited={!!aux && registry.get(aux.id)?.exited} warning={warning}
    explorerLabel={IS_MAC ? 'Reveal in Finder' : IS_WINDOWS ? 'Open in Explorer' : 'Open folder'} canExplore={!!platform.terminalContext && !!cwd && canOpenDirectory(cwd, IS_WINDOWS)}
    browserProviders={hostBrowserProviders()} canIframe={!!platform.createIframeProxyUrl}
    onClose={onClose} onCopyId={() => copy(id)} onCopyPath={() => copy(cwd?.path ?? '')}
    onExplore={async () => { if (platform.terminalContext && cwd) await platform.terminalContext({ op: 'openDirectory', id, path: cwd.path }); }}
    onWatch={() => { if (offeredRule) setCommandWatched(offeredRule, watchRule === null); }} onTodo={() => toggleSessionTodo(id)}
    onPort={(entry, mode) => context.openPort(id, entry, mode)}
    resetAsks={!isDelayedKillEnabled()}
    onReset={async () => { await resetAux(id, { workspaceId: source?.workspaceId ?? DEFAULT_WORKSPACE_ID, title: deriveSurfaceLabel(state, title ?? id) }); await openAux(id); }} onPromote={() => context.promote(id)}
    onKeepPreview={preview ? () => actions.onPinPreview?.(id) : undefined}>
    {/* The Tool's xterm itself: `focusSession` would reach its browser Surface's focus handle. */}
    {tool && <div data-context-terminal={id} className="h-full px-3 py-2" onMouseDown={() => getTerminalInstance(id)?.focus()}><TerminalPane id={id} isFocused={false} /></div>}
    {aux && <div data-aux-terminal={aux.id} className="h-full px-3 py-2" onMouseDown={() => focusSession(aux.id, true)}><TerminalPane key={aux.id} id={aux.id} isFocused={false} /></div>}
  </TerminalContextView>;
}

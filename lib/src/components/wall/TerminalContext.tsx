import { useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { NotepadPanel } from '../NotepadPanel';
import { NotepadHeaderButton } from './NotepadHeaderButton';
import { isSurfaceClosing } from '../../lib/notepad/notepad-store';
import { messageOf } from '../../lib/errors';
import { TerminalPane } from '../TerminalPane';
import { TerminalContextView, type ContextScan } from './TerminalContextView';
import { TerminalContextContext, WallActionsContext, type TerminalContextState } from './wall-context';
import { disposeHelper, getHelper, helperRevision, openHelper, setHelperVisible, subscribeHelpers } from '../../lib/helper-terminal';
import { getPlatform, IS_MAC, IS_WINDOWS } from '../../lib/platform';
import { buildAppTitleResolver, commandArgv0, createTerminalPaneState, cwdDisplay, deriveSurfaceLabel, explainTerminalTitle, type CwdState } from '../../lib/terminal-state';
import { focusSession, getTerminalInstance, getActivitySnapshot, getTerminalPaneStateSnapshot, isCommandWatched, setCommandWatched, subscribeToActivity, subscribeToTerminalPaneState, subscribeToWatchedCommands, getWatchedCommandsSnapshot, toggleSessionTodo } from '../../lib/terminal-registry';
import { writeTextToClipboard } from '../../lib/clipboard';
import { listenerUrlsByPort } from './port-url';
import { DEFAULT_HELPER_COMMAND } from '../../lib/terminal-context-types';

export function TerminalContext({ id, title, closing, origin, warning: openWarning, tool = false }: TerminalContextState & { title?: string; tool?: boolean }) {
  const context = useContext(TerminalContextContext);
  const actions = useContext(WallActionsContext);
  const states = useSyncExternalStore(subscribeToTerminalPaneState, getTerminalPaneStateSnapshot);
  const activities = useSyncExternalStore(subscribeToActivity, getActivitySnapshot);
  useSyncExternalStore(subscribeHelpers, helperRevision);
  useSyncExternalStore(subscribeToWatchedCommands, getWatchedCommandsSnapshot);
  const [scan, setScan] = useState<ContextScan>({ status: 'scanning' });
  const [home, setHome] = useState('');
  const [defaultCommand, setDefaultCommand] = useState(DEFAULT_HELPER_COMMAND);
  const [helperError, setHelperError] = useState('');
  const platform = getPlatform();
  const helper = tool ? undefined : getHelper(id);
  const state = states.get(id) ?? createTerminalPaneState();
  const cwd = state.cwd?.path ? state.cwd : undefined;
  const helperState = helper ? states.get(helper.id) : undefined;
  const helperCwd = helperState?.cwd?.path ? helperState.cwd : undefined;
  const argv0 = state.currentCommand?.rawCommandLine ? commandArgv0(state.currentCommand.rawCommandLine) : null;
  const appTitleForPane = useMemo(() => buildAppTitleResolver(states, activities), [states, activities]);
  const titleSources = useMemo(() => explainTerminalTitle(state, { appTitleForPane }), [state, appTitleForPane]);
  const display = (location: CwdState) => cwdDisplay(location, { style: 'full', homePath: home });
  useEffect(() => {
    let cancelled = false;
    if (!tool) void openHelper(id).catch(e => { if (!cancelled) setHelperError(messageOf(e)); });
    void platform.terminalContext?.({ op: 'settings' }).then(info => { if (!cancelled) { setHome(info.home ?? ''); setDefaultCommand(info.command ?? DEFAULT_HELPER_COMMAND); } }).catch(() => {});
    void platform.getOpenPorts(id).then(ports => { if (!cancelled) setScan({ status: 'loaded', entries: listenerUrlsByPort(ports) }); }, () => { if (!cancelled) setScan({ status: 'failed' }); });
    return () => { cancelled = true; };
  }, [id, platform, tool]);
  // The helper polls only while the context is open; an exit pauses it at once.
  useEffect(() => {
    if (closing || tool) return;
    setHelperVisible(id, true);
    return () => setHelperVisible(id, false);
  }, [id, closing, tool]);
  const onClose = useCallback(() => { context.close(); if (!tool) focusSession(id, true); }, [context, id, tool]);
  const copy = async (value: string) => { if (!await writeTextToClipboard(value)) throw new Error('Could not copy to clipboard'); };
  const mismatch = !!helper && !!cwd && !!helperCwd && (cwd.path !== helperCwd.path || cwd.isRemote !== helperCwd.isRemote || (cwd.isRemote && cwd.host !== helperCwd.host));
  const warning = openWarning ?? (helperError || (helper && helper.status !== 'waiting' && (!cwd || !helperCwd) ? 'Directory comparison unavailable: a terminal has not reported its directory.' : undefined));
  return <TerminalContextView terminalRole={tool ? 'tool' : 'helper'} closing={closing} origin={origin} title={deriveSurfaceLabel(state, appTitleForPane, title ?? id)} surfaceRef={actions.resolveSurfaceRef(id)}
    titleSources={titleSources} cwd={cwd ? display(cwd) : 'Directory unknown'} helperCwd={helperCwd && display(helperCwd)} mismatch={mismatch}
    scan={scan} argv0={argv0} watching={!!argv0 && isCommandWatched(argv0)} todo={activities.get(id)?.todo === true} notification={activities.get(id)?.notification}
    status={tool ? (state.currentCommand ? 'running' : 'completed') : helper?.status ?? 'waiting'} command={tool ? state.currentCommand?.rawCommandLine ?? state.lastCommand?.rawCommandLine ?? '' : helper?.command ?? defaultCommand} defaultCommand={defaultCommand} warning={warning}
    explorerLabel={IS_MAC ? 'Open in Finder' : IS_WINDOWS ? 'Open in Explorer' : 'Open folder'} canExplore={!!platform.terminalContext && !!cwd && !cwd.isRemote}
    canAgent={!!platform.agentBrowserOpen} canIframe={!!platform.createIframeProxyUrl}
    onClose={onClose} onCopyRef={() => copy(actions.resolveSurfaceRef(id))} onCopyPath={() => copy(cwd?.path ?? '')}
    onExplore={async () => { if (platform.terminalContext && cwd) await platform.terminalContext({ op: 'openDirectory', id, path: cwd.path }); }}
    onWatch={() => { if (argv0) setCommandWatched(argv0, !isCommandWatched(argv0)); }} onTodo={() => toggleSessionTodo(id)}
    onPort={(entry, mode) => context.openPort(id, entry, mode)}
    onModify={async command => { await platform.terminalContext?.({ op: 'settings', command }); setDefaultCommand(command); }}
    notepadAction={<NotepadHeaderButton surfaceId={id} />}
    notepadPanel={<NotepadPanel surfaceId={id} pins={tool} />}
    onReset={async () => { if (isSurfaceClosing(id)) throw new Error('This terminal is closing'); disposeHelper(id); await openHelper(id); }} onPromote={() => context.promote(id)}>
    {tool && <div data-context-terminal={id} className="h-full px-3 py-2" onMouseDown={() => getTerminalInstance(id)?.focus()}><TerminalPane id={id} isFocused={false} /></div>}
    {helper && <div data-helper-terminal={helper.id} className="h-full px-3 py-2" onMouseDown={() => focusSession(helper.id, true)}><TerminalPane key={helper.id} id={helper.id} isFocused={false} /></div>}
  </TerminalContextView>;
}

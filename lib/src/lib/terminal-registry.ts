export type { SessionStatus } from './activity-monitor';
export type { TodoState, AlertButtonActionResult } from './alert-manager';
export type { ActivityState } from './session-activity-store';
export type { TerminalEntry, TerminalOverlayDims } from './terminal-store';
export type {
  CommandRun,
  CwdState,
  DerivedHeader,
  ShellActivity,
  TerminalPaneState,
  TerminalSemanticEvent,
  TerminalTitle,
  TerminalTitleCandidates,
} from './terminal-state';

export {
  clearPrimedActivity,
  clearSessionAttention,
  clearSessionTodo,
  DEFAULT_ACTIVITY_STATE,
  disableSessionAlert,
  dismissOrToggleAlert,
  dismissSessionAlert,
  getActivity,
  getActivitySnapshot,
  getLivePersistedAlertState,
  initAlertStateReceiver,
  markSessionAttention,
  markSessionTodo,
  primeActivity,
  subscribeToActivity,
  toggleSessionAlert,
  toggleSessionTodo,
} from './session-activity-store';

export { resolveTerminalSessionId } from './terminal-store';

export {
  disposeAllSessions,
  disposeSession,
  focusSession,
  getOrCreateTerminal,
  getTerminalInstance,
  getTerminalOverlayDims,
  isUntouched,
  markSessionTouched,
  mountElement,
  refitSession,
  restoreTerminal,
  resumeTerminal,
  setPendingShellOpts,
  swapTerminals,
  unmountElement,
} from './terminal-lifecycle';

export { setDefaultShellOpts, getDefaultShellOpts } from './shell-defaults';

export {
  applyTerminalSemanticEvents,
  applyTerminalSemanticEventsByPtyId,
  ensureTerminalPaneState,
  fillTerminalProcessCwd,
  fillTerminalProcessCwdByPtyId,
  getTerminalPaneState,
  getTerminalPaneStateSnapshot,
  removeTerminalPaneState,
  resetTerminalPaneState,
  seedTerminalManualCwd,
  setTerminalUserTitle,
  subscribeToTerminalPaneState,
} from './terminal-state-store';
export type { SetTerminalUserTitleResult } from './terminal-state-store';

export {
  cwdDisplay,
  cwdFromManualPath,
  cwdFromOsc1337,
  cwdFromOsc633,
  cwdFromOsc7,
  cwdFromOsc9_9,
  cwdFromProcessPath,
  cwdIdentity,
  buildAppTitleResolver,
  DEFAULT_COMMAND_TITLE,
  DEFAULT_IDLE_TITLE,
  deriveFallbackCommandTitle,
  deriveHeader,
  groupTerminalPanes,
  notificationDisplayTitle,
  reduceTerminalState,
  resolveDisplayPrimary,
  shortestUniqueCwdLabels,
  summarizeCommandLine,
  terminalTitleFromNotification,
  titleCandidatesForDisplay,
  titleSourceLabel,
  UNNAMED_PANEL_TITLE,
} from './terminal-state';

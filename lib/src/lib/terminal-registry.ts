export type { SessionStatus } from './activity-monitor';
export type { TodoState } from './alert-manager';
export type { ActivityState, AlertButtonActionResult } from './session-activity-store';
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
  clearLocalSurfaceActivity,
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
  restoreBrowserSurfaceTodo,
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
  registerSurfaceFocusHandle,
  restoreTerminal,
  resumeTerminal,
  setPendingShellOpts,
  unmountElement,
} from './terminal-lifecycle';
export type { SurfaceFocusHandle } from './terminal-lifecycle';

export { setDefaultShellOpts, getDefaultShellOpts } from './shell-defaults';

export {
  getWatchedCommands,
  getWatchedCommandsSnapshot,
  isCommandWatched,
  setCommandWatched,
  subscribeToWatchedCommands,
} from './watched-commands';

export {
  applyAlertSettingsFromHost,
  clampAlertDelayMs,
  getAlertSettings,
  subscribeToAlertSettings,
  updateAlertSettings,
} from './alert-settings';
export type { AlertSettings } from './alert-settings';

export {
  getPushDevices,
  refreshPushDevicesNow,
  resetPushDevices,
  setPushDevices,
  setPushDevicesRefresher,
  subscribeToPushDevices,
} from './push-devices';
export type { PushDevice, PushDevicesState } from './push-devices';

export { deriveSessionLabel } from './session-label';

export {
  applyTerminalSemanticEvents,
  applyTerminalSemanticEventsByPtyId,
  countRunningSessions,
  ensureTerminalPaneState,
  fillTerminalProcessCwd,
  fillTerminalProcessCwdByPtyId,
  getRunningCommandArgv0,
  getTerminalPaneState,
  getTerminalPaneStateSnapshot,
  isPaneOscDriven,
  isReservedUserTitle,
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

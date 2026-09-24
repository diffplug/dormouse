export type { SessionStatus } from './alert-manager';
export type { TodoState } from './alert-manager';
export type { AlertRingState, AlertSpeechState } from './alert-speech-state';
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
  clearLocalSurfaceActivity,
  clearTerminalActivity,
  clearSessionAttention,
  clearSessionTodo,
  DEFAULT_ACTIVITY_STATE,
  dismissSessionAlert,
  getActivity,
  getActivitySnapshot,
  getLivePersistedAlertState,
  initAlertStateReceiver,
  markSessionAttention,
  setTerminalActivity,
  restoreBrowserSurfaceTodo,
  subscribeToActivity,
  toggleSessionTodo,
} from './session-activity-store';

export {
  disposeAllSessions,
  disposeSession,
  focusSession,
  getOrCreateTerminal,
  getTerminalShellKind,
  getTerminalInstance,
  getTerminalOverlayDims,
  isUntouched,
  markSessionTouched,
  mountElement,
  refitSession,
  registerSurfaceFocusHandle,
  releaseSession,
  restoreTerminal,
  resumeTerminal,
  serializeTerminal,
  flushTerminal,
  setPendingShellOpts,
  unmountElement,
} from './terminal-lifecycle';
export type { SurfaceFocusHandle } from './terminal-lifecycle';

export { setDefaultShellOpts, getDefaultShellOpts } from './shell-defaults';

export {
  getRunningCommandWatchRule,
  getWatchedCommands,
  getWatchedCommandsSnapshot,
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
  getAlertSpeechState,
  getAlertSpeechSnapshot,
  subscribeToAlertSpeech,
} from './alert-speech-state';

export {
  applyTerminalSemanticEvents,
  countRunningSessions,
  countRunningSessionsIn,
  ensureTerminalPaneState,
  fillTerminalProcessCwd,
  getRunningCommandWatchKey,
  getInheritableCwd,
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

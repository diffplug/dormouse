export type { SessionStatus } from './alert-manager';
export type { AlertRingState, AlertSpeechState } from './alert-speech-state';
export type { ActivityState } from './session-activity-store';
export type {
  CommandRun,
  CwdState,
  ShellActivity,
  TerminalPaneState,
  TerminalTitle,
} from './terminal-state';

export {
  acknowledgeSession,
  clearLocalSurfaceActivity,
  clearTerminalActivity,
  clearSessionTodo,
  DEFAULT_ACTIVITY_STATE,
  dismissSessionAlert,
  getActivity,
  getActivitySnapshot,
  getLivePersistedAlertState,
  initAlertStateReceiver,
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
  getTerminalFontSize,
  getTerminalOverlayDims,
  getSessionInputVersion,
  isUntouched,
  mountElement,
  writeUserInput,
  refitSession,
  registerSurfaceFocusHandle,
  releaseSession,
  createReapedTerminal,
  reapTerminal,
  rehydrateTerminal,
  restoreTerminal,
  resumeTerminal,
  serializeTerminal,
  flushTerminal,
  setPendingShellOpts,
  setTerminalFontSize,
  unmountElement,
} from './terminal-lifecycle';
export { markSessionTouched } from './terminal-store';

export { setDefaultShellOpts, getDefaultShellOpts } from './shell-defaults';

export {
  getRunningCommandWatchRule,
  getWatchedCommandsSnapshot,
  setCommandWatched,
  subscribeToWatchedCommands,
} from './watched-commands';

export {
  applyAlertSettingsFromHost,
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
  subscribeToPushDevices,
} from './push-devices';
export type { PushDevicesState } from './push-devices';

export {
  getAlertSpeechState,
  getAlertSpeechSnapshot,
  subscribeToAlertSpeech,
} from './alert-speech-state';

export {
  applyTerminalSemanticEvents,
  countRunningSessions,
  getRunningCommandWatchKey,
  getInheritableCwd,
  getTerminalPaneState,
  getTerminalPaneStateSnapshot,
  isPaneOscDriven,
  removeTerminalPaneState,
  resetTerminalPaneState,
  seedTerminalManualCwd,
  setTerminalUserTitle,
  subscribeToTerminalPaneState,
} from './terminal-state-store';
export type { SetTerminalUserTitleResult } from './terminal-state-store';

export {
  cwdFromManualPath,
  cwdFromOsc1337,
  cwdFromOsc633,
  cwdFromOsc7,
  cwdFromOsc9_9,
  cwdFromProcessPath,
  buildAppTitleResolver,
  deriveHeader,
  resolveDisplayPrimary,
  summarizeCommandLine,
  UNNAMED_PANEL_TITLE,
} from './terminal-state';

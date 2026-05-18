export type { DormouseTheme, BundledOrigin, InstalledOrigin } from './types';
export { CONSUMED_VSCODE_KEYS, convertVscodeThemeColors, uiThemeToType } from './convert';
export { applyTheme, getAppliedThemeSnapshot, restoreActiveTheme } from './apply';
export type { AppliedThemeSnapshot } from './apply';
export { computeDynamicPalette, pickDoorPair, pickDynamicPalette, pickFocusRing } from './dynamic-palette';
export type {
  DoorChoice,
  DynamicDoorPick,
  DynamicFocusRingPick,
  DynamicPaletteSnapshot,
  DynamicPaletteVars,
  FocusRingCandidate,
} from './dynamic-palette';
export { captureThemeDiagnostics } from './diagnostics';
export type {
  ThemeDiagnosticSnapshot,
  ThemeMetadataSnapshot,
  VisibleVarOrigin,
  VisibleVscodeVarSnapshot,
  SemanticTokenSnapshot,
  TerminalColorSnapshot,
} from './diagnostics';
export {
  completeThemeVars,
  inferVscodeThemeKind,
  traceThemeVars,
} from './vscode-color-resolver';
export type {
  VscodeThemeKind,
  VscodeThemeResolverTrace,
  VscodeThemeVarTrace,
  VscodeThemeVarTraceOrigin,
} from './vscode-color-resolver';
export {
  getMaterializedVscodeThemeVars,
  installVscodeThemeVarResolver,
} from './vscode-color-observer';
export {
  getBundledThemes,
  getInstalledThemes,
  getAllThemes,
  getTheme,
  addInstalledTheme,
  removeInstalledTheme,
  getActiveThemeId,
  setActiveThemeId,
} from './store';
export { searchThemes, fetchExtensionThemes } from './openvsx';
export type { OpenVSXSearchResult, OpenVSXExtension } from './openvsx';

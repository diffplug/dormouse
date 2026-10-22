export type { DormouseTheme, BundledOrigin, InstalledOrigin } from './types';
export { CONSUMED_VSCODE_KEYS, convertVscodeThemeColors, uiThemeToType } from './convert';
export {
  applyTheme,
  getAppliedThemeSnapshot,
  resolveThemeVars,
  restoreActiveTheme,
  setDefaultThemeId,
  subscribeToActiveTheme,
  themeBootPaint,
} from './apply';
export type { AppliedThemeSnapshot } from './apply';
export { useRestoredTheme } from './use-restored-theme';
export { getThemePaintProfile, setThemePaintProfile, themeBootScript } from './boot-paint';
export type { ThemePaint, ThemePaintProfile } from './boot-paint';
export {
  computeDynamicPalette,
  DYNAMIC_PALETTE_SOURCES,
  dynamicPaletteValuesFrom,
  pickDoorPair,
  pickDynamicPalette,
  pickFocusRing,
} from './dynamic-palette';
export type {
  DoorChoice,
  DynamicDoorPick,
  DynamicFocusRingPick,
  DynamicPaletteSnapshot,
  DynamicPaletteValues,
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

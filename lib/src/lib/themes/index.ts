export type { DormouseTheme } from './types';
export {
  applyTheme,
  getAppliedThemeSnapshot,
  resolveThemeVars,
  restoreActiveTheme,
  setDefaultThemeId,
  subscribeToActiveTheme,
} from './apply';
export { useRestoredTheme } from './use-restored-theme';
export { setThemePaintProfile } from './boot-paint';
export type { ThemePaintProfile } from './boot-paint';
export { dynamicPaletteValuesFrom, pickDynamicPalette } from './dynamic-palette';
export { captureThemeDiagnostics } from './diagnostics';
export type {
  ThemeDiagnosticSnapshot,
  VisibleVarOrigin,
  SemanticTokenSnapshot,
} from './diagnostics';
export { completeThemeVars } from './vscode-color-resolver';
export type { VscodeThemeVarTraceOrigin } from './vscode-color-resolver';
export {
  getBundledThemes,
  getInstalledThemes,
  getAllThemes,
  addInstalledTheme,
  removeInstalledTheme,
  getActiveThemeId,
  setActiveThemeId,
} from './store';
export { searchThemes, fetchExtensionThemes } from './openvsx';
export type { OpenVSXExtension, OpenVSXSearchResult } from './openvsx';

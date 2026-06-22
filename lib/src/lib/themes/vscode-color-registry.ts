export type VscodeThemeKind = 'dark' | 'light' | 'hcDark' | 'hcLight';

type ThemePalette = Record<VscodeThemeKind, string | null>;

export const THEME_KINDS: readonly VscodeThemeKind[] = ['dark', 'light', 'hcDark', 'hcLight'];

const REGISTRY_DEFAULTS: Record<string, ThemePalette> = {
  '--vscode-foreground': {
    dark: '#CCCCCC',
    light: '#616161',
    hcDark: '#FFFFFF',
    hcLight: '#292929',
  },
  '--vscode-editor-background': {
    dark: '#1E1E1E',
    light: '#ffffff',
    hcDark: '#000000',
    hcLight: '#ffffff',
  },
  '--vscode-editor-foreground': {
    dark: '#BBBBBB',
    light: '#333333',
    hcDark: '#ffffff',
    hcLight: null,
  },
  '--vscode-editorWidget-background': {
    dark: '#252526',
    light: '#F3F3F3',
    hcDark: '#0C141F',
    hcLight: '#ffffff',
  },
  '--vscode-sideBar-background': {
    dark: '#252526',
    light: '#F3F3F3',
    hcDark: '#000000',
    hcLight: '#ffffff',
  },
  '--vscode-sideBar-foreground': {
    dark: null,
    light: null,
    hcDark: null,
    hcLight: null,
  },
  '--vscode-descriptionForeground': {
    dark: '#ccccccb3',
    light: '#717171',
    hcDark: '#ffffffb3',
    hcLight: '#292929b3',
  },
  '--vscode-panel-border': {
    dark: '#80808059',
    light: '#80808059',
    hcDark: null,
    hcLight: null,
  },
  '--vscode-focusBorder': {
    dark: '#007FD4',
    light: '#0090F1',
    hcDark: '#F38518',
    hcLight: '#006BBD',
  },
  '--vscode-list-activeSelectionBackground': {
    dark: '#04395E',
    light: '#0060C0',
    hcDark: null,
    hcLight: '#0F4A851a',
  },
  '--vscode-list-activeSelectionForeground': {
    dark: '#ffffff',
    light: '#ffffff',
    hcDark: null,
    hcLight: null,
  },
  '--vscode-list-inactiveSelectionBackground': {
    dark: '#37373D',
    light: '#E4E6F1',
    hcDark: null,
    hcLight: '#0F4A851a',
  },
  '--vscode-list-inactiveSelectionForeground': {
    dark: null,
    light: null,
    hcDark: null,
    hcLight: null,
  },
  '--vscode-errorForeground': {
    dark: '#F48771',
    light: '#A1260D',
    hcDark: '#F48771',
    hcLight: '#B5200D',
  },
  '--vscode-input-background': {
    dark: '#3C3C3C',
    light: '#ffffff',
    hcDark: '#000000',
    hcLight: '#ffffff',
  },
  '--vscode-input-border': {
    dark: null,
    light: null,
    hcDark: null,
    hcLight: null,
  },
  '--vscode-button-background': {
    dark: '#0E639C',
    light: '#007ACC',
    hcDark: '#000000',
    hcLight: '#0F4A85',
  },
  '--vscode-button-foreground': {
    dark: '#ffffff',
    light: '#ffffff',
    hcDark: '#ffffff',
    hcLight: '#ffffff',
  },
  '--vscode-textLink-foreground': {
    dark: '#3794FF',
    light: '#006AB1',
    hcDark: '#21A6FF',
    hcLight: '#0F4A85',
  },
  '--vscode-terminal-background': {
    dark: null,
    light: null,
    hcDark: null,
    hcLight: null,
  },
  '--vscode-terminal-foreground': {
    dark: '#CCCCCC',
    light: '#333333',
    hcDark: '#ffffff',
    hcLight: '#292929',
  },
  '--vscode-terminalCursor-foreground': {
    dark: null,
    light: null,
    hcDark: null,
    hcLight: null,
  },
  '--vscode-editor-selectionBackground': {
    dark: '#264F78',
    light: '#ADD6FF',
    hcDark: '#f3f518',
    hcLight: '#0F4A85',
  },
  '--vscode-terminal-selectionBackground': {
    dark: null,
    light: null,
    hcDark: null,
    hcLight: null,
  },
  '--vscode-terminal-ansiBlack': {
    dark: '#000000',
    light: '#000000',
    hcDark: '#000000',
    hcLight: '#292929',
  },
  '--vscode-terminal-ansiRed': {
    dark: '#cd3131',
    light: '#cd3131',
    hcDark: '#cd0000',
    hcLight: '#cd3131',
  },
  '--vscode-terminal-ansiGreen': {
    dark: '#0DBC79',
    light: '#107C10',
    hcDark: '#00cd00',
    hcLight: '#136C13',
  },
  '--vscode-terminal-ansiYellow': {
    dark: '#e5e510',
    light: '#949800',
    hcDark: '#cdcd00',
    hcLight: '#949800',
  },
  '--vscode-terminal-ansiBlue': {
    dark: '#2472c8',
    light: '#0451a5',
    hcDark: '#0000ee',
    hcLight: '#0451a5',
  },
  '--vscode-terminal-ansiMagenta': {
    dark: '#bc3fbc',
    light: '#bc05bc',
    hcDark: '#cd00cd',
    hcLight: '#bc05bc',
  },
  '--vscode-terminal-ansiCyan': {
    dark: '#11a8cd',
    light: '#0598bc',
    hcDark: '#00cdcd',
    hcLight: '#0598bc',
  },
  '--vscode-terminal-ansiWhite': {
    dark: '#e5e5e5',
    light: '#555555',
    hcDark: '#e5e5e5',
    hcLight: '#555555',
  },
  '--vscode-terminal-ansiBrightBlack': {
    dark: '#666666',
    light: '#666666',
    hcDark: '#7f7f7f',
    hcLight: '#666666',
  },
  '--vscode-terminal-ansiBrightRed': {
    dark: '#f14c4c',
    light: '#cd3131',
    hcDark: '#ff0000',
    hcLight: '#cd3131',
  },
  '--vscode-terminal-ansiBrightGreen': {
    dark: '#23d18b',
    light: '#14CE14',
    hcDark: '#00ff00',
    hcLight: '#00bc00',
  },
  '--vscode-terminal-ansiBrightYellow': {
    dark: '#f5f543',
    light: '#b5ba00',
    hcDark: '#ffff00',
    hcLight: '#b5ba00',
  },
  '--vscode-terminal-ansiBrightBlue': {
    dark: '#3b8eea',
    light: '#0451a5',
    hcDark: '#5c5cff',
    hcLight: '#0451a5',
  },
  '--vscode-terminal-ansiBrightMagenta': {
    dark: '#d670d6',
    light: '#bc05bc',
    hcDark: '#ff00ff',
    hcLight: '#bc05bc',
  },
  '--vscode-terminal-ansiBrightCyan': {
    dark: '#29b8db',
    light: '#0598bc',
    hcDark: '#00ffff',
    hcLight: '#0598bc',
  },
  '--vscode-terminal-ansiBrightWhite': {
    dark: '#e5e5e5',
    light: '#a5a5a5',
    hcDark: '#ffffff',
    hcLight: '#a5a5a5',
  },
};

export const RESOLVABLE_VSCODE_VAR_NAMES: readonly string[] = Object.keys(REGISTRY_DEFAULTS);

export type NullFallbackRule =
  | { kind: 'literal'; value: string }
  | { kind: 'firstDefined'; names: readonly string[] };

export interface ResolutionRule {
  name: string;
  nullFallback?: NullFallbackRule;
}

const literal = (value: string): NullFallbackRule => ({ kind: 'literal', value });
const firstDefined = (names: readonly string[]): NullFallbackRule => ({ kind: 'firstDefined', names });

export const RESOLUTION_RULES: readonly ResolutionRule[] = [
  { name: '--vscode-foreground' },
  { name: '--vscode-editor-background' },
  { name: '--vscode-editor-foreground', nullFallback: firstDefined(['--vscode-foreground']) },
  { name: '--vscode-editorWidget-background' },
  { name: '--vscode-sideBar-background' },
  { name: '--vscode-sideBar-foreground', nullFallback: firstDefined(['--vscode-foreground']) },
  { name: '--vscode-descriptionForeground', nullFallback: firstDefined(['--vscode-foreground']) },
  { name: '--vscode-panel-border', nullFallback: literal('transparent') },
  { name: '--vscode-focusBorder' },

  {
    name: '--vscode-list-activeSelectionBackground',
    nullFallback: firstDefined(['--vscode-sideBar-background', '--vscode-editor-background']),
  },
  {
    name: '--vscode-list-activeSelectionForeground',
    nullFallback: firstDefined([
      '--vscode-editor-foreground',
      '--vscode-foreground',
      '--vscode-terminal-foreground',
    ]),
  },
  {
    name: '--vscode-list-inactiveSelectionBackground',
    nullFallback: firstDefined(['--vscode-sideBar-background', '--vscode-editor-background']),
  },
  {
    name: '--vscode-list-inactiveSelectionForeground',
    nullFallback: firstDefined([
      '--vscode-sideBar-foreground',
      '--vscode-foreground',
      '--vscode-editor-foreground',
      '--vscode-terminal-foreground',
    ]),
  },

  { name: '--vscode-errorForeground' },
  { name: '--vscode-input-background' },
  { name: '--vscode-input-border', nullFallback: literal('transparent') },
  { name: '--vscode-button-background' },
  { name: '--vscode-button-foreground' },
  { name: '--vscode-textLink-foreground' },

  { name: '--vscode-terminal-background', nullFallback: firstDefined(['--vscode-editor-background']) },
  { name: '--vscode-terminal-foreground' },
  { name: '--vscode-terminalCursor-foreground', nullFallback: firstDefined(['--vscode-terminal-foreground']) },
  { name: '--vscode-editor-selectionBackground' },
  { name: '--vscode-terminal-selectionBackground', nullFallback: firstDefined(['--vscode-editor-selectionBackground']) },

  { name: '--vscode-terminal-ansiBlack' },
  { name: '--vscode-terminal-ansiRed' },
  { name: '--vscode-terminal-ansiGreen' },
  { name: '--vscode-terminal-ansiYellow' },
  { name: '--vscode-terminal-ansiBlue' },
  { name: '--vscode-terminal-ansiMagenta' },
  { name: '--vscode-terminal-ansiCyan' },
  { name: '--vscode-terminal-ansiWhite' },
  { name: '--vscode-terminal-ansiBrightBlack' },
  { name: '--vscode-terminal-ansiBrightRed' },
  { name: '--vscode-terminal-ansiBrightGreen' },
  { name: '--vscode-terminal-ansiBrightYellow' },
  { name: '--vscode-terminal-ansiBrightBlue' },
  { name: '--vscode-terminal-ansiBrightMagenta' },
  { name: '--vscode-terminal-ansiBrightCyan' },
  { name: '--vscode-terminal-ansiBrightWhite' },
];

export function registryDefaultValue(name: string, themeKind: VscodeThemeKind): string | null {
  const defaults = REGISTRY_DEFAULTS[name];
  if (!defaults) return null;
  return defaults[themeKind] || null;
}

export function coerceThemeKind(themeKind: VscodeThemeKind | 'dark' | 'light'): VscodeThemeKind {
  return THEME_KINDS.includes(themeKind as VscodeThemeKind) ? themeKind as VscodeThemeKind : 'dark';
}

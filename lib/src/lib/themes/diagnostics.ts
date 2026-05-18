import { rgbOf } from '../color-contrast';
import { getAppliedThemeSnapshot, type AppliedThemeSnapshot } from './apply';
import { pickDynamicPalette, type DynamicPaletteSnapshot } from './dynamic-palette';
import type { BundledOrigin, InstalledOrigin } from './types';
import { getMaterializedVscodeThemeVars } from './vscode-color-observer';
import {
  inferVscodeThemeKind,
  RESOLVABLE_VSCODE_VAR_NAMES,
  traceThemeVars,
  type VscodeThemeKind,
  type VscodeThemeVarTrace,
} from './vscode-color-resolver';

export type VisibleVarOrigin = 'host-provided' | 'dormouse-materialized' | 'missing';

export interface ThemeMetadataSnapshot {
  id: string;
  label: string;
  type: string;
  origin: string;
}

export interface VisibleVscodeVarSnapshot {
  name: string;
  value: string | null;
  origin: VisibleVarOrigin;
  declaredOn: 'body' | 'html' | 'computed' | 'missing';
}

export interface SemanticTokenSnapshot {
  token: string;
  value: string | null;
  sourceVar: string | null;
  sourceValue: string | null;
  group: 'surface' | 'text' | 'chrome' | 'dynamic' | 'status' | 'input';
}

export interface TerminalColorSnapshot {
  label: string;
  sourceVar: string;
  value: string | null;
}

export interface ThemeDiagnosticSnapshot {
  capturedAt: string;
  themeKind: VscodeThemeKind;
  activeTheme: ThemeMetadataSnapshot | null;
  visibleVars: VisibleVscodeVarSnapshot[];
  resolverTraces: VscodeThemeVarTrace[];
  semanticTokens: SemanticTokenSnapshot[];
  terminalColors: TerminalColorSnapshot[];
  dynamicPalette: DynamicPaletteSnapshot;
  report: string;
}

const SEMANTIC_TOKEN_SOURCES: Array<Omit<SemanticTokenSnapshot, 'value' | 'sourceValue'>> = [
  { token: '--color-app-bg', sourceVar: '--vscode-sideBar-background', group: 'surface' },
  { token: '--color-app-fg', sourceVar: '--vscode-sideBar-foreground', group: 'surface' },
  { token: '--color-terminal-bg', sourceVar: '--vscode-terminal-background', group: 'surface' },
  { token: '--color-terminal-fg', sourceVar: '--vscode-terminal-foreground', group: 'surface' },
  { token: '--color-surface-raised', sourceVar: '--vscode-editorWidget-background', group: 'surface' },
  { token: '--color-foreground', sourceVar: '--vscode-editor-foreground', group: 'text' },
  { token: '--color-muted', sourceVar: '--vscode-descriptionForeground', group: 'text' },
  { token: '--color-border', sourceVar: '--vscode-panel-border', group: 'chrome' },
  { token: '--color-header-active-bg', sourceVar: '--vscode-list-activeSelectionBackground', group: 'chrome' },
  { token: '--color-header-active-fg', sourceVar: '--vscode-list-activeSelectionForeground', group: 'chrome' },
  { token: '--color-header-inactive-bg', sourceVar: '--vscode-list-inactiveSelectionBackground', group: 'chrome' },
  { token: '--color-header-inactive-fg', sourceVar: '--vscode-list-inactiveSelectionForeground', group: 'chrome' },
  { token: '--color-error', sourceVar: '--vscode-terminal-ansiRed', group: 'status' },
  { token: '--color-success', sourceVar: '--vscode-terminal-ansiGreen', group: 'status' },
  { token: '--color-input-bg', sourceVar: '--vscode-input-background', group: 'input' },
  { token: '--color-input-border', sourceVar: '--vscode-input-border', group: 'input' },
];

const TERMINAL_COLOR_SOURCES: Array<{ label: string; sourceVar: string }> = [
  { label: 'background', sourceVar: '--vscode-terminal-background' },
  { label: 'foreground', sourceVar: '--vscode-terminal-foreground' },
  { label: 'cursor', sourceVar: '--vscode-terminalCursor-foreground' },
  { label: 'selection', sourceVar: '--vscode-terminal-selectionBackground' },
  { label: 'black', sourceVar: '--vscode-terminal-ansiBlack' },
  { label: 'red', sourceVar: '--vscode-terminal-ansiRed' },
  { label: 'green', sourceVar: '--vscode-terminal-ansiGreen' },
  { label: 'yellow', sourceVar: '--vscode-terminal-ansiYellow' },
  { label: 'blue', sourceVar: '--vscode-terminal-ansiBlue' },
  { label: 'magenta', sourceVar: '--vscode-terminal-ansiMagenta' },
  { label: 'cyan', sourceVar: '--vscode-terminal-ansiCyan' },
  { label: 'white', sourceVar: '--vscode-terminal-ansiWhite' },
  { label: 'bright black', sourceVar: '--vscode-terminal-ansiBrightBlack' },
  { label: 'bright red', sourceVar: '--vscode-terminal-ansiBrightRed' },
  { label: 'bright green', sourceVar: '--vscode-terminal-ansiBrightGreen' },
  { label: 'bright yellow', sourceVar: '--vscode-terminal-ansiBrightYellow' },
  { label: 'bright blue', sourceVar: '--vscode-terminal-ansiBrightBlue' },
  { label: 'bright magenta', sourceVar: '--vscode-terminal-ansiBrightMagenta' },
  { label: 'bright cyan', sourceVar: '--vscode-terminal-ansiBrightCyan' },
  { label: 'bright white', sourceVar: '--vscode-terminal-ansiBrightWhite' },
];

function normalized(value: string | null | undefined): string {
  return value?.trim() ?? '';
}

function serializeThemeOrigin(themeOrigin: BundledOrigin | InstalledOrigin): string {
  return themeOrigin.kind === 'installed'
    ? `installed:${themeOrigin.extensionId}`
    : themeOrigin.kind;
}

function readVar(styles: CSSStyleDeclaration, name: string): string | null {
  return normalized(styles.getPropertyValue(name)) || null;
}

function declaredOn(name: string): VisibleVscodeVarSnapshot['declaredOn'] {
  if (typeof document === 'undefined') return 'missing';
  if (readVar(document.body.style, name)) return 'body';
  if (readVar(document.documentElement.style, name)) return 'html';
  return 'computed';
}

let cachedColorContext: CanvasRenderingContext2D | null | undefined;
function getColorContext(): CanvasRenderingContext2D | null {
  if (cachedColorContext === undefined) {
    cachedColorContext = typeof document === 'undefined'
      ? null
      : document.createElement('canvas').getContext('2d');
  }
  return cachedColorContext;
}

function captureDynamicPalette(styles: CSSStyleDeclaration): DynamicPaletteSnapshot {
  const ctx = getColorContext();
  if (!ctx) return { door: null, focusRing: null };

  return pickDynamicPalette({
    appBg: readVar(styles, '--color-app-bg') ?? '',
    headerInactiveBg: readVar(styles, '--color-header-inactive-bg') ?? '',
    headerInactiveFg: readVar(styles, '--color-header-inactive-fg') ?? '',
    terminalBg: readVar(styles, '--color-terminal-bg') ?? '',
    terminalFg: readVar(styles, '--color-terminal-fg') ?? '',
    headerActiveBg: readVar(styles, '--color-header-active-bg') ?? '',
    focusBorder: readVar(styles, '--vscode-focusBorder') ?? '',
  }, (color) => rgbOf(color, ctx));
}

function captureVisibleVars(
  styles: CSSStyleDeclaration,
  applied: AppliedThemeSnapshot | null,
): VisibleVscodeVarSnapshot[] {
  const materialized = getMaterializedVscodeThemeVars();

  return RESOLVABLE_VSCODE_VAR_NAMES.map((name) => {
    const value = readVar(styles, name);
    let origin: VisibleVarOrigin = value ? 'host-provided' : 'missing';

    if (value && materialized.get(name) === value) {
      origin = 'dormouse-materialized';
    } else if (value && applied && !applied.theme.vars[name] && applied.resolvedVars[name] === value) {
      origin = 'dormouse-materialized';
    }

    return {
      name,
      value,
      origin,
      declaredOn: value ? declaredOn(name) : 'missing',
    };
  });
}

function traceInputFromVisibleVars(
  visibleVars: VisibleVscodeVarSnapshot[],
  applied: AppliedThemeSnapshot | null,
): Record<string, string> {
  if (applied) return applied.theme.vars;

  const vars: Record<string, string> = {};
  for (const item of visibleVars) {
    if (item.origin === 'host-provided' && item.value) {
      vars[item.name] = item.value;
    }
  }
  return vars;
}

function captureSemanticTokens(styles: CSSStyleDeclaration, dynamicPalette: DynamicPaletteSnapshot): SemanticTokenSnapshot[] {
  const tokens = SEMANTIC_TOKEN_SOURCES.map((item) => ({
    ...item,
    value: readVar(styles, item.token),
    sourceValue: item.sourceVar ? readVar(styles, item.sourceVar) : null,
  }));

  if (dynamicPalette.door) {
    tokens.push({
      token: '--color-door-bg',
      value: dynamicPalette.door.bgValue,
      sourceVar: dynamicPalette.door.bgVar,
      sourceValue: dynamicPalette.door.bgValue,
      group: 'dynamic',
    });
    tokens.push({
      token: '--color-door-fg',
      value: dynamicPalette.door.fgValue,
      sourceVar: dynamicPalette.door.fgVar,
      sourceValue: dynamicPalette.door.fgValue,
      group: 'dynamic',
    });
  }

  if (dynamicPalette.focusRing) {
    tokens.push({
      token: '--color-focus-ring',
      value: dynamicPalette.focusRing.value,
      sourceVar: dynamicPalette.focusRing.sourceVar,
      sourceValue: dynamicPalette.focusRing.value,
      group: 'dynamic',
    });
  }

  return tokens;
}

function captureTerminalColors(styles: CSSStyleDeclaration): TerminalColorSnapshot[] {
  return TERMINAL_COLOR_SOURCES.map((item) => ({
    ...item,
    value: readVar(styles, item.sourceVar),
  }));
}

function activeThemeMetadata(applied: AppliedThemeSnapshot | null): ThemeMetadataSnapshot | null {
  if (!applied) return null;
  return {
    id: applied.theme.id,
    label: applied.theme.label,
    type: applied.theme.type,
    origin: serializeThemeOrigin(applied.theme.origin),
  };
}

function formatValue(value: string | null): string {
  return value ?? '<missing>';
}

function formatTrace(trace: VscodeThemeVarTrace): string {
  const via = trace.fallbackSource ? ` via ${trace.fallbackSource}` : '';
  const fallbackPath = trace.fallbackPath.length ? ` fallback=[${trace.fallbackPath.join(' -> ')}]` : '';
  return `${trace.name}: ${formatValue(trace.resolvedValue)} (${trace.origin}${via}; provided=${formatValue(trace.providedValue)}; registry=${formatValue(trace.registryDefault)}${fallbackPath})`;
}

function buildReport(snapshot: Omit<ThemeDiagnosticSnapshot, 'report'>): string {
  const lines: string[] = [];
  lines.push('Dormouse theme diagnostic');
  lines.push(`capturedAt: ${snapshot.capturedAt}`);
  lines.push(`themeKind: ${snapshot.themeKind}`);
  lines.push(`activeTheme: ${snapshot.activeTheme ? `${snapshot.activeTheme.label} (${snapshot.activeTheme.origin})` : 'VSCode host theme'}`);
  lines.push('');
  lines.push('Semantic tokens');
  for (const token of snapshot.semanticTokens) {
    lines.push(`${token.token}: ${formatValue(token.value)} <= ${token.sourceVar ?? 'runtime'} ${formatValue(token.sourceValue)}`);
  }
  lines.push('');
  lines.push('Dynamic picks');
  if (snapshot.dynamicPalette.door) {
    lines.push(`door bg: ${snapshot.dynamicPalette.door.bgVar} ${snapshot.dynamicPalette.door.bgValue}`);
    lines.push(`door fg: ${snapshot.dynamicPalette.door.fgVar} ${snapshot.dynamicPalette.door.fgValue}`);
    lines.push(`door reason: ${snapshot.dynamicPalette.door.reason}`);
  } else {
    lines.push('door: <unresolved>');
  }
  if (snapshot.dynamicPalette.focusRing) {
    lines.push(`focus ring: ${snapshot.dynamicPalette.focusRing.sourceVar} ${snapshot.dynamicPalette.focusRing.value}`);
    lines.push(`focus reason: ${snapshot.dynamicPalette.focusRing.reason}`);
  } else {
    lines.push('focus ring: <unresolved>');
  }
  lines.push('');
  lines.push('Terminal palette');
  for (const item of snapshot.terminalColors) {
    lines.push(`${item.label}: ${item.sourceVar} ${formatValue(item.value)}`);
  }
  lines.push('');
  lines.push('Resolved VSCode variables');
  for (const trace of snapshot.resolverTraces) {
    lines.push(formatTrace(trace));
  }
  lines.push('');
  lines.push('Visible VSCode variables');
  for (const item of snapshot.visibleVars) {
    lines.push(`${item.name}: ${formatValue(item.value)} (${item.origin}, ${item.declaredOn})`);
  }
  return lines.join('\n');
}

export function captureThemeDiagnostics(): ThemeDiagnosticSnapshot {
  const capturedAt = new Date().toISOString();
  const themeKind = inferVscodeThemeKind();
  const styles = getComputedStyle(document.body);
  const applied = getAppliedThemeSnapshot();
  const visibleVars = captureVisibleVars(styles, applied);
  const resolver = traceThemeVars(traceInputFromVisibleVars(visibleVars, applied), themeKind);
  const dynamicPalette = captureDynamicPalette(styles);
  const terminalColors = captureTerminalColors(styles);
  const semanticTokens = captureSemanticTokens(styles, dynamicPalette);

  const snapshotWithoutReport = {
    capturedAt,
    themeKind,
    activeTheme: activeThemeMetadata(applied),
    visibleVars,
    resolverTraces: resolver.traces,
    semanticTokens,
    terminalColors,
    dynamicPalette,
  };

  return {
    ...snapshotWithoutReport,
    report: buildReport(snapshotWithoutReport),
  };
}

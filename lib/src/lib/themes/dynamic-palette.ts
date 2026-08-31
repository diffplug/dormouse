import { chromaOklab, deltaEOklab, rgbOf, rgbToOklab } from '../color-contrast';

type Lab = [number, number, number];

/** Return pure black or pure white — whichever contrasts the given bg.
 *  Luminance contrast is the dominant signal for visibility, so a flat
 *  black/white pick beats any chroma-rotation scheme in practice. */
export function pickAlarmColor(bgRgb: [number, number, number]): string {
  const [L] = rgbToOklab(bgRgb);
  return L < 0.5 ? '#ffffff' : '#000000';
}

export interface FocusRingCandidate {
  varName: string;
  lab: Lab;
  preferred?: boolean;
}

export const FOCUS_RING_SATURATION_FLOOR = 0.05;

export function pickFocusRing(candidates: readonly FocusRingCandidate[], appLab: Lab): FocusRingCandidate | null {
  if (candidates.length === 0) return null;

  const preferred = candidates.find((c) => c.preferred);
  if (preferred && chromaOklab(preferred.lab) >= FOCUS_RING_SATURATION_FLOOR) return preferred;

  let bestSaturated: FocusRingCandidate | null = null;
  let bestChroma = -Infinity;
  for (const c of candidates) {
    if (c.preferred) continue;
    const cc = chromaOklab(c.lab);
    if (cc >= FOCUS_RING_SATURATION_FLOOR && cc > bestChroma) {
      bestSaturated = c;
      bestChroma = cc;
    }
  }
  if (bestSaturated) return bestSaturated;

  let bestDist: FocusRingCandidate | null = null;
  let maxDist = -Infinity;
  for (const c of candidates) {
    const d = deltaEOklab(c.lab, appLab);
    if (d > maxDist) {
      bestDist = c;
      maxDist = d;
    }
  }
  return bestDist;
}

export interface DoorChoice {
  bg: '--color-header-inactive-bg' | '--color-terminal-bg';
  fg: '--color-header-inactive-fg' | '--color-terminal-fg';
}

export function pickDoorPair(panelLab: Lab, terminalLab: Lab, appLab: Lab): DoorChoice {
  const panelDist = deltaEOklab(panelLab, appLab);
  const termDist = deltaEOklab(terminalLab, appLab);
  return panelDist >= termDist
    ? { bg: '--color-header-inactive-bg', fg: '--color-header-inactive-fg' }
    : { bg: '--color-terminal-bg', fg: '--color-terminal-fg' };
}

export interface DynamicPaletteVars {
  '--color-door-bg'?: string;
  '--color-door-fg'?: string;
  '--color-focus-ring'?: string;
  '--color-alarm-vs-header-active'?: string;
  '--color-alarm-vs-header-inactive'?: string;
  '--color-alarm-vs-door'?: string;
  '--color-alarm-vs-terminal'?: string;
}

export function computeDynamicPalette(
  styles: Pick<CSSStyleDeclaration, 'getPropertyValue'>,
  ctx: CanvasRenderingContext2D,
): DynamicPaletteVars {
  const rgbOfVar = (varName: string): [number, number, number] | null =>
    rgbOf(styles.getPropertyValue(varName).trim(), ctx);
  const labOf = (varName: string): Lab | null => {
    const rgb = rgbOfVar(varName);
    return rgb ? rgbToOklab(rgb) : null;
  };

  const result: DynamicPaletteVars = {};
  const oApp = labOf('--color-app-bg');
  if (!oApp) return result;

  const panelLab = labOf('--color-header-inactive-bg');
  const termLab = labOf('--color-terminal-bg');
  if (panelLab && termLab) {
    const choice = pickDoorPair(panelLab, termLab, oApp);
    result['--color-door-bg'] = `var(${choice.bg})`;
    result['--color-door-fg'] = `var(${choice.fg})`;
  }

  const candidates: FocusRingCandidate[] = [];
  const focusBorder = labOf('--vscode-focusBorder');
  if (focusBorder) candidates.push({ varName: '--vscode-focusBorder', lab: focusBorder, preferred: true });
  const headerActiveBg = labOf('--color-header-active-bg');
  if (headerActiveBg) candidates.push({ varName: '--color-header-active-bg', lab: headerActiveBg });

  const pick = pickFocusRing(candidates, oApp);
  if (pick) result['--color-focus-ring'] = `var(${pick.varName})`;

  const headerActiveRgb = rgbOfVar('--color-header-active-bg');
  if (headerActiveRgb) {
    result['--color-alarm-vs-header-active'] = pickAlarmColor(headerActiveRgb);
  }
  const headerInactiveRgb = rgbOfVar('--color-header-inactive-bg');
  if (headerInactiveRgb) {
    result['--color-alarm-vs-header-inactive'] = pickAlarmColor(headerInactiveRgb);
  }
  // Door bg is computed in this pass; the observer's next pass corrects its tint.
  const doorRgb = rgbOfVar('--color-door-bg');
  if (doorRgb) {
    result['--color-alarm-vs-door'] = pickAlarmColor(doorRgb);
  }
  const terminalRgb = rgbOfVar('--color-terminal-bg');
  if (terminalRgb) {
    result['--color-alarm-vs-terminal'] = pickAlarmColor(terminalRgb);
  }

  return result;
}

export type Rgb = [number, number, number];
export type ColorToRgb = (color: string) => Rgb | null;

export interface DynamicPaletteValues {
  appBg: string;
  headerInactiveBg: string;
  headerInactiveFg: string;
  terminalBg: string;
  terminalFg: string;
  headerActiveBg: string;
  focusBorder: string;
}

export interface DynamicPaletteCandidate {
  sourceVar: string;
  value: string;
  deltaE: number | null;
  chroma: number | null;
  preferred?: boolean;
}

export interface DynamicDoorPick {
  bgVar: '--color-header-inactive-bg' | '--color-terminal-bg';
  fgVar: '--color-header-inactive-fg' | '--color-terminal-fg';
  bgValue: string;
  fgValue: string;
  reason: string;
  candidates: DynamicPaletteCandidate[];
}

export interface DynamicFocusRingPick {
  sourceVar: '--vscode-focusBorder' | '--color-header-active-bg';
  value: string;
  reason: string;
  candidates: DynamicPaletteCandidate[];
}

export interface DynamicPaletteSnapshot {
  door: DynamicDoorPick | null;
  focusRing: DynamicFocusRingPick | null;
}

type RgbLab = [number, number, number];
type DetailedCandidate = DynamicPaletteCandidate & FocusRingCandidate & { lab: RgbLab };

function roundMetric(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function candidate(
  sourceVar: string,
  value: string,
  colorToRgb: ColorToRgb,
  appLab: RgbLab,
  preferred = false,
): DetailedCandidate | null {
  const rgb = colorToRgb(value);
  if (!rgb) return null;
  const lab = rgbToOklab(rgb);
  return {
    sourceVar,
    varName: sourceVar,
    value,
    lab,
    preferred,
    chroma: roundMetric(chromaOklab(lab)),
    deltaE: roundMetric(deltaEOklab(lab, appLab)),
  };
}

function publicCandidates(candidates: DetailedCandidate[]): DynamicPaletteCandidate[] {
  return candidates.map((item) => ({
    sourceVar: item.sourceVar,
    value: item.value,
    deltaE: item.deltaE,
    chroma: item.chroma,
    preferred: item.preferred,
  }));
}

export function pickDynamicPalette(
  values: DynamicPaletteValues,
  colorToRgb: ColorToRgb,
): DynamicPaletteSnapshot {
  const appRgb = colorToRgb(values.appBg);
  if (!appRgb) return { door: null, focusRing: null };

  const appLab = rgbToOklab(appRgb);
  const doorCandidates = [
    candidate('--color-header-inactive-bg', values.headerInactiveBg, colorToRgb, appLab),
    candidate('--color-terminal-bg', values.terminalBg, colorToRgb, appLab),
  ].filter((item): item is DetailedCandidate => item !== null);

  let door: DynamicDoorPick | null = null;
  const inactive = doorCandidates.find((item) => item.sourceVar === '--color-header-inactive-bg');
  const terminal = doorCandidates.find((item) => item.sourceVar === '--color-terminal-bg');
  if (inactive && terminal) {
    const choice = pickDoorPair(inactive.lab, terminal.lab, appLab);
    const useInactive = choice.bg === '--color-header-inactive-bg';
    door = {
      bgVar: choice.bg,
      fgVar: choice.fg,
      bgValue: useInactive ? values.headerInactiveBg : values.terminalBg,
      fgValue: useInactive ? values.headerInactiveFg : values.terminalFg,
      reason: useInactive
        ? 'inactive header background has the larger OKLab distance from app background'
        : 'terminal background has the larger OKLab distance from app background',
      candidates: publicCandidates(doorCandidates),
    };
  }

  const focusCandidates: DetailedCandidate[] = [
    candidate('--vscode-focusBorder', values.focusBorder, colorToRgb, appLab, true),
    candidate('--color-header-active-bg', values.headerActiveBg, colorToRgb, appLab),
  ].filter((item): item is DetailedCandidate => item !== null);

  const focusPick = pickFocusRing(focusCandidates, appLab) as DetailedCandidate | null;
  const focusChroma = focusPick ? chromaOklab(focusPick.lab) : 0;
  const focusReason = !focusPick
    ? ''
    : focusPick.preferred && focusChroma >= FOCUS_RING_SATURATION_FLOOR
      ? 'focusBorder is chromatic, so the ring uses the VS Code focus color'
      : !focusPick.preferred && focusChroma >= FOCUS_RING_SATURATION_FLOOR
        ? 'active header background is the next chromatic focus-ring candidate'
        : 'highest OKLab distance from app background among available candidates';

  const focusRing = focusPick
    ? {
        sourceVar: focusPick.sourceVar as DynamicFocusRingPick['sourceVar'],
        value: focusPick.value,
        reason: focusReason,
        candidates: publicCandidates(focusCandidates),
      }
    : null;

  return { door, focusRing };
}

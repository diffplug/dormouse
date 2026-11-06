import { describe, expect, it } from 'vitest';
import { rgbToOklab } from '../color-contrast';
import {
  FOCUS_RING_SATURATION_FLOOR,
  pickDoorPair,
  pickFocusRing,
  type FocusRingCandidate,
} from './dynamic-palette';

const lab = (r: number, g: number, b: number) => rgbToOklab([r, g, b]);

const APP_DARK = lab(30, 30, 30);
const APP_LIGHT = lab(240, 240, 240);
// #fdf6e3 — Solarized Light app-bg, intentionally warm but not saturated.
const APP_SOLARIZED = lab(0xfd, 0xf6, 0xe3);

describe('pickDoorPair', () => {
  it('picks the panel when panel has more contrast against app-bg than terminal', () => {
    const panel = lab(200, 200, 200); // far from dark app-bg
    const terminal = lab(40, 40, 40); // close to dark app-bg
    const choice = pickDoorPair(panel, terminal, APP_DARK);
    expect(choice.bg).toBe('--color-header-inactive-bg');
    expect(choice.fg).toBe('--color-header-inactive-fg');
  });

  it('picks the terminal when terminal has more contrast', () => {
    const panel = lab(40, 40, 40);
    const terminal = lab(200, 200, 200);
    const choice = pickDoorPair(panel, terminal, APP_DARK);
    expect(choice.bg).toBe('--color-terminal-bg');
    expect(choice.fg).toBe('--color-terminal-fg');
  });

  it('breaks ties by preferring the panel — doors anchor to chrome', () => {
    const same = lab(120, 120, 120);
    const choice = pickDoorPair(same, same, APP_DARK);
    expect(choice.bg).toBe('--color-header-inactive-bg');
  });
});

describe('pickFocusRing', () => {
  it('returns null with an empty candidate list', () => {
    expect(pickFocusRing([], APP_DARK)).toBeNull();
  });

  it('picks focusBorder when it clears the saturation floor', () => {
    const preferred: FocusRingCandidate = {
      varName: '--vscode-focusBorder',
      lab: lab(0, 127, 212), // VSCode dark focusBorder
      preferred: true,
    };
    const activeBg: FocusRingCandidate = { varName: '--color-header-active-bg', lab: lab(0xff, 0x40, 0x40) };
    const pick = pickFocusRing([preferred, activeBg], APP_DARK);
    expect(pick?.varName).toBe('--vscode-focusBorder');
  });

  it('falls through preferred when it is below the saturation floor', () => {
    const flatPreferred: FocusRingCandidate = {
      varName: '--vscode-focusBorder',
      lab: lab(60, 60, 60), // grey
      preferred: true,
    };
    const accent: FocusRingCandidate = { varName: '--color-header-active-bg', lab: lab(0x09, 0x47, 0x71) };
    const pick = pickFocusRing([flatPreferred, accent], APP_DARK);
    expect(pick?.varName).toBe('--color-header-active-bg');
  });

  it('Solarized: preferred (chromatic) wins even though app-bg itself is warm', () => {
    // Solarized Light's app-bg is warm cream. Without the absolute-chroma rule,
    // max-ΔE math would pull the focus ring toward whatever else is on the
    // candidate list.
    const preferred: FocusRingCandidate = {
      varName: '--vscode-focusBorder',
      lab: lab(0, 0x90, 0xf1),
      preferred: true,
    };
    const activeBg: FocusRingCandidate = { varName: '--color-header-active-bg', lab: lab(0x26, 0x8b, 0xd2) };
    const pick = pickFocusRing([preferred, activeBg], APP_SOLARIZED);
    expect(pick?.varName).toBe('--vscode-focusBorder');
  });

  it('greyscale theme: falls through chroma rules to max-ΔE candidate', () => {
    // All candidates and app-bg are flat grey — neither preferred nor any
    // alternative clears the floor. The third rule must pick whichever
    // candidate is farthest from app-bg in OKLab.
    const candidates: FocusRingCandidate[] = [
      { varName: '--vscode-focusBorder', lab: lab(120, 120, 120), preferred: true },
      { varName: '--color-header-active-bg', lab: lab(40, 40, 40) },
    ];
    const pick = pickFocusRing(candidates, APP_LIGHT);
    expect(pick?.varName).toBe('--color-header-active-bg');
  });

  it('picks the most-saturated alternative when preferred is below floor', () => {
    const flatPreferred: FocusRingCandidate = {
      varName: '--vscode-focusBorder',
      lab: lab(80, 80, 80),
      preferred: true,
    };
    // Both clear the floor; the muted one comes first, so input order alone would pick it.
    const muted: FocusRingCandidate = { varName: '--color-header-inactive-bg', lab: lab(0x09, 0x47, 0x71) };
    const vivid: FocusRingCandidate = { varName: '--color-header-active-bg', lab: lab(0xff, 0x40, 0x40) };
    const pick = pickFocusRing([flatPreferred, muted, vivid], APP_DARK);
    expect(pick?.varName).toBe('--color-header-active-bg');
  });

  it('exposes the saturation floor as a constant for visibility', () => {
    // Explicit assertion so a future tweak doesn't silently change palette
    // behavior — pair this with a deliberate test update if the floor moves.
    expect(FOCUS_RING_SATURATION_FLOOR).toBe(0.05);
  });
});

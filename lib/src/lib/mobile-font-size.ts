import { useEffect, useState } from 'react';
import { loadJson, saveJson } from './local-json-store';
import { setTerminalFontSize } from './terminal-registry';

export const MOBILE_FONT_SIZE_KEY = 'dormouse:mobile-font-size';
export const MOBILE_FONT_SIZE_MIN = 8;
export const MOBILE_FONT_SIZE_MAX = 24;

export function clampMobileFontSize(px: number): number {
  return Math.min(MOBILE_FONT_SIZE_MAX, Math.max(MOBILE_FONT_SIZE_MIN, Math.round(px)));
}

const isFontSize = (value: unknown): value is number => typeof value === 'number' && value > 0;

function restoreMobileFontSize(): void {
  // Nothing saved leaves the theme's size in place.
  const saved = loadJson(MOBILE_FONT_SIZE_KEY, null, isFontSize);
  if (saved !== null) setTerminalFontSize(clampMobileFontSize(saved));
}

export function saveMobileFontSize(px: number): void {
  saveJson(MOBILE_FONT_SIZE_KEY, px);
}

/**
 * The mobile composition's terminal font size for as long as it is mounted:
 * restored before its terminals are created when `persist`, and handed back to
 * the theme on unmount, so a desktop playground opened next in the same page
 * never inherits it.
 */
export function useMobileFontSize(persist: boolean): void {
  useState(() => {
    if (persist) restoreMobileFontSize();
  });
  useEffect(() => {
    if (persist) restoreMobileFontSize();
    return () => setTerminalFontSize(null);
  }, [persist]);
}

import { useEffect } from 'react';
import { startAlertSpeech } from '../../lib/alert-speech';

/**
 * Arm spoken alarms for the lifetime of the desktop shell. The settings that
 * gate it live in the Alarm settings dialog (`docs/specs/alert.md` -> Alarm
 * settings).
 *
 * One watcher per WINDOW, not per Wall: `startAlertSpeech` installs a global
 * activity handler and clears every Session's speech state, so N Walls would
 * speak each ring N times and reset each other's delivery state. Reference
 * counted, so the first mounted Wall arms it and the last one disarms it.
 */
let holders = 0;
let stop: (() => void) | null = null;

export function useAlertSpeech(): void {
  useEffect(() => {
    holders += 1;
    if (holders === 1) stop = startAlertSpeech();
    return () => {
      holders -= 1;
      if (holders > 0) return;
      stop?.();
      stop = null;
    };
  }, []);
}

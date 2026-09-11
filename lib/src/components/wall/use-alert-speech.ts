import { useEffect } from 'react';
import { startAlertSpeech } from '../../lib/alert-speech';
import { createRefCount } from '../../lib/ref-count';

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
const acquire = createRefCount({ onFirst: () => startAlertSpeech() });

export function useAlertSpeech(): void {
  useEffect(acquire, []);
}

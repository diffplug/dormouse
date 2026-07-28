import { useEffect } from 'react';
import { startAlertSpeech } from '../../lib/alert-speech';

/**
 * Arm spoken alarms for the lifetime of the desktop shell. Mounted once by
 * `Wall`; the settings that gate it live in the Alarm settings dialog
 * (`docs/specs/alert.md` -> Alarm settings).
 */
export function useAlertSpeech(): void {
  useEffect(() => startAlertSpeech(), []);
}

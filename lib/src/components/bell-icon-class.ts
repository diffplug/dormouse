import { cfg } from '../cfg';
import type { SessionStatus } from '../lib/terminal-registry';

/** Returns the Tailwind className string for a BellIcon's rotation/animation based on alert status. */
export function bellIconClass(status: SessionStatus): string {
  return [
    'transition-transform',
    status === 'MIGHT_BE_BUSY' && '-rotate-[22.5deg]',
    (status === 'BUSY' || status === 'OSC_NOTIF_BUSY' || status === 'COMMAND_EXIT_ARMED') && 'rotate-45',
    status === 'MIGHT_NEED_ATTENTION' && 'rotate-[60deg]',
    status === 'ALERT_RINGING' && (
      cfg.alert.ringingPaused
        ? 'rotate-45'
        : 'motion-safe:animate-bell-ring motion-reduce:rotate-45'
    ),
  ].filter(Boolean).join(' ');
}

/**
 * The pulse worn by a Session the renderer is currently speaking.
 *
 * Lives beside `bellIconClass` because it needs the same `cfg.alert.ringingPaused`
 * freeze: an infinite animation otherwise snapshots at whatever phase the
 * Chromatic runner lands on, so every build diffs against itself. Unlike the bell
 * there is no static substitute to swap in — the overlay's ring already carries
 * the state without motion. `motion-safe:` alone covers reduced motion; a
 * `motion-reduce:` counterpart would be dead, since the animation is never
 * emitted there to override.
 */
export function alertSpeakingAnimationClass(): string {
  return cfg.alert.ringingPaused ? '' : 'motion-safe:animate-speech-alarm-pulse';
}

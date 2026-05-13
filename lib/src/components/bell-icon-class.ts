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

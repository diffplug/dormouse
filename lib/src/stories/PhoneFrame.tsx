import type { ReactNode } from 'react';

/**
 * Phone-sized frame for the Pocket auth stories (SetupOrSignin, HostsView),
 * sitting on the app-bg surface — matches the real app shell. Uses a faint
 * app-fg outline for definition since panel-border is transparent in many
 * themes (see docs/specs/theme.md).
 */
export function PhoneFrame({ children }: { children: ReactNode }) {
  return (
    <div
      className="overflow-hidden rounded-xl shadow-2xl outline outline-1 outline-app-fg/15"
      style={{ width: 390, height: 760, background: 'var(--color-app-bg)' }}
    >
      {children}
    </div>
  );
}

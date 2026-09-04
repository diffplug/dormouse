import type { ReactNode } from 'react';
import { getPlatform } from '../lib/platform';

/**
 * Inline prose link out to the web. A `button`, not an `<a>`: the webview hosts
 * cannot navigate themselves, so every outbound href goes through the
 * platform's `openExternal`, and a host without one silently does nothing
 * rather than blanking the app.
 *
 * Its own module rather than `design.tsx`, which nearly every component pulls
 * in: `../lib/platform` re-exports the fake scenarios, and those do not shake
 * out, so importing it there put ~4.4KB of terminal fixtures into the docs
 * website's bundle for a two-line link.
 */
export function ExternalTextLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={() => getPlatform().openExternal?.(href)}
      className="text-foreground underline underline-offset-2 hover:text-muted"
    >
      {children}
    </button>
  );
}

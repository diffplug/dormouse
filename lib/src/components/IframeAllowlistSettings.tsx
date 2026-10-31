import { useSyncExternalStore } from 'react';
import { XIcon } from '@phosphor-icons/react';
import { modalIconButton, SETTINGS_SECTION } from './design';
import { getIframeAllowlist, removeIframeOrigin, subscribeToIframeAllowlist } from '../lib/iframe-allowlist';

/** The origins an iframe preview may show off this machine, each removable;
 *  they are added from the pane's warning (docs/specs/dor-browser.md → "Iframe
 *  External Origins"). Nothing to show until one is. */
export function IframeAllowlistSettings({ hidden }: { hidden: boolean }) {
  const origins = useSyncExternalStore(subscribeToIframeAllowlist, getIframeAllowlist);
  if (origins.length === 0) return null;
  return (
    <section data-setting="previews" hidden={hidden} className={SETTINGS_SECTION}>
      <div className="text-sm text-foreground">External websites allowed in iframe previews:</div>
      <ul className="mt-1.5 flex flex-col gap-0.5">
        {origins.map((origin) => (
          <li key={origin} className="flex items-center justify-between gap-3">
            <span className="min-w-0 truncate font-mono text-sm text-foreground" title={origin}>{origin}</span>
            <button
              type="button"
              aria-label={`Remove ${origin}`}
              className={modalIconButton()}
              onClick={() => removeIframeOrigin(origin)}
            >
              <XIcon size={12} weight="bold" />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

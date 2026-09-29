import { useId } from 'react';
import { BROWSER_PROVIDER_IDS, type BrowserAutomationProvider } from 'dor-lib-common/browser-providers';
import { loadJson, saveJson } from '../../lib/local-json-store';
import { BROWSER_PROVIDER_GUI } from './browser-automation';

const PREFERENCE_KEY = 'dormouse:browser-provider';
let preferred = loadJson(PREFERENCE_KEY, 'agent-browser', (value): value is BrowserAutomationProvider =>
  BROWSER_PROVIDER_IDS.some(provider => provider === value));

export function preferredBrowserProvider(available: readonly BrowserAutomationProvider[]): BrowserAutomationProvider {
  return available.includes(preferred) ? preferred : available[0] ?? 'agent-browser';
}

export function rememberBrowserProvider(provider: BrowserAutomationProvider): void {
  preferred = provider;
  saveJson(PREFERENCE_KEY, provider);
}

/** A single provider choice for the automated presentations; never selects a renderer itself. */
export function BrowserProviderPicker({ providers, value, onChange }: {
  providers: readonly BrowserAutomationProvider[];
  value: BrowserAutomationProvider;
  onChange(provider: BrowserAutomationProvider): void;
}) {
  const name = useId();
  if (providers.length < 2) return null;
  return <div role="radiogroup" aria-label="Browser provider" className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
    {providers.map(provider => <label key={provider} className="flex cursor-pointer items-center gap-1.5">
      <input type="radio" name={name} value={provider} checked={value === provider} onChange={() => onChange(provider)} />
      {BROWSER_PROVIDER_GUI[provider].label}
    </label>)}
  </div>;
}

import { BROWSER_PROVIDER_IDS, type BrowserAutomationProvider } from 'dor-lib-common/browser-providers';
import { loadJson, saveJson } from '../../lib/local-json-store';
import { SUBTLE_ACTION_COLOR_CLASS } from '../design';
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
export function BrowserProviderSwitch({ providers, value, onChange }: {
  providers: readonly BrowserAutomationProvider[];
  value: BrowserAutomationProvider;
  onChange(provider: BrowserAutomationProvider): void;
}) {
  const next = providers.find(provider => provider !== value);
  if (!next) return null;
  const label = `switch to ${BROWSER_PROVIDER_GUI[next].label}`;
  return <button type="button" aria-label={label} title={label} onClick={() => onChange(next)}
    className={`min-w-0 truncate text-xs hover:underline ${SUBTLE_ACTION_COLOR_CLASS}`}>{label}</button>;
}

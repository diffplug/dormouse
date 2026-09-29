import { useState } from 'react';
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

/** A locally chosen provider, falling back to the preference while `providers` lacks it. */
export function useBrowserProvider(providers: readonly BrowserAutomationProvider[], initial?: BrowserAutomationProvider | null) {
  const [chosen, setChosen] = useState(() => initial ?? preferredBrowserProvider(providers));
  return [providers.includes(chosen) ? chosen : preferredBrowserProvider(providers), setChosen] as const;
}

/** The provider a "switch to" link offers from `value`, or null when there is no other. */
export function browserProviderSwitch(providers: readonly BrowserAutomationProvider[], value: BrowserAutomationProvider) {
  const next = providers.find(provider => provider !== value);
  return next ? { next, label: `switch to ${BROWSER_PROVIDER_GUI[next].label}` } : null;
}

/** A single provider choice for the automated presentations; never selects a renderer itself. */
export function BrowserProviderSwitch({ providers, value, onChange }: {
  providers: readonly BrowserAutomationProvider[];
  value: BrowserAutomationProvider;
  onChange(provider: BrowserAutomationProvider): void;
}) {
  const offer = browserProviderSwitch(providers, value);
  if (!offer) return null;
  const { next, label } = offer;
  return <button type="button" aria-label={label} title={label} onClick={() => onChange(next)}
    className={`min-w-0 truncate text-xs hover:underline ${SUBTLE_ACTION_COLOR_CLASS}`}>{label}</button>;
}

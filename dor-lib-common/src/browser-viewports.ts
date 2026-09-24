/** Shared CSS viewport settings for Dormouse's automated browsers. */
export interface FixedBrowserViewport {
  width: number;
  height: number;
  /** Omitted means preserve the browser context's current ratio. */
  dpr?: number;
}

export type BrowserViewportSetting =
  | ({ mode: 'fixed' } & FixedBrowserViewport)
  | { mode: 'pane-sync' };

export type BrowserViewportSelection = string | FixedBrowserViewport;

export interface BrowserViewportConfig {
  defaultViewport: string;
  viewports: Record<string, FixedBrowserViewport>;
}

export const BROWSER_VIEWPORT_MAX_SIDE = 16384;
export const BROWSER_VIEWPORT_MAX_DPR = 10;
export const PANE_SYNC_PRESET = 'pane-sync';
export const BUILTIN_BROWSER_VIEWPORTS: Readonly<Record<string, FixedBrowserViewport>> = {
  desktop: { width: 1440, height: 900 },
  laptop: { width: 1280, height: 800 },
  tablet: { width: 768, height: 1024 },
  phone: { width: 390, height: 844 },
};

export function defaultBrowserViewportConfig(): BrowserViewportConfig {
  return { defaultViewport: 'desktop', viewports: Object.fromEntries(Object.entries(BUILTIN_BROWSER_VIEWPORTS).map(([name, size]) => [name, { ...size }])) };
}

export function isFixedBrowserViewport(value: unknown): value is FixedBrowserViewport {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return Number.isInteger(v.width) && Number(v.width) > 0 && Number(v.width) <= BROWSER_VIEWPORT_MAX_SIDE
    && Number.isInteger(v.height) && Number(v.height) > 0 && Number(v.height) <= BROWSER_VIEWPORT_MAX_SIDE
    && (v.dpr === undefined || (typeof v.dpr === 'number' && Number.isFinite(v.dpr) && v.dpr > 0 && v.dpr <= BROWSER_VIEWPORT_MAX_DPR));
}

export function isBrowserViewportSetting(value: unknown): value is BrowserViewportSetting {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return v.mode === 'pane-sync'
    ? v.width === undefined && v.height === undefined && v.dpr === undefined
    : v.mode === 'fixed' && isFixedBrowserViewport(v);
}

export function resolveBrowserViewport(config: BrowserViewportConfig, selection: BrowserViewportSelection = config.defaultViewport): BrowserViewportSetting {
  if (selection === PANE_SYNC_PRESET) return { mode: 'pane-sync' };
  const size = typeof selection === 'string' ? Object.hasOwn(config.viewports, selection) ? config.viewports[selection] : undefined : selection;
  if (!isFixedBrowserViewport(size)) throw new Error(typeof selection === 'string' ? `Unknown browser viewport preset '${selection}'` : 'Invalid browser viewport dimensions or DPR');
  return { mode: 'fixed', ...size };
}

import {
  defaultBrowserViewportConfig,
  isFixedBrowserViewport,
  resolveBrowserViewport,
  type BrowserViewportConfig,
  type BrowserViewportSelection,
  type BrowserViewportSetting,
  type FixedBrowserViewport,
} from 'dor-lib-common/browser-viewports';
import { isRecord } from '../lib/is-record';

export interface BrowserConfigLayer {
  defaultViewport?: string;
  viewports: Record<string, FixedBrowserViewport>;
}

/** Parse only data: browser preferences never grant permission to run a Tool. */
export function parseBrowserConfig(value: unknown, where: string): BrowserConfigLayer {
  if (!isRecord(value)) throw new Error(`${where}: expected a mapping`);
  for (const key of Object.keys(value)) {
    if (key !== 'default_viewport' && key !== 'viewports') throw new Error(`${where}: unknown field '${key}'`);
  }
  const defaultViewport = value.default_viewport;
  if (defaultViewport !== undefined && (typeof defaultViewport !== 'string' || !defaultViewport.trim() || defaultViewport !== defaultViewport.trim())) {
    throw new Error(`${where}.default_viewport: expected a non-empty preset name`);
  }
  const raw = value.viewports ?? {};
  if (!isRecord(raw)) throw new Error(`${where}.viewports: expected a mapping`);
  const viewports = Object.create(null) as Record<string, FixedBrowserViewport>;
  for (const [name, size] of Object.entries(raw)) {
    if (!name.trim() || name !== name.trim() || name === 'pane-sync') throw new Error(`${where}.viewports: '${name}' is not a configurable preset name`);
    viewports[name] = parseFixedViewport(size, `${where}.viewports.${name}`);
  }
  return { ...(defaultViewport !== undefined ? { defaultViewport: defaultViewport as string } : {}), viewports };
}

function parseFixedViewport(value: unknown, where: string): FixedBrowserViewport {
  if (!isFixedBrowserViewport(value) || Object.keys(value).some(key => !['width', 'height', 'dpr'].includes(key))) {
    throw new Error(`${where}: expected width/height integers from 1 to 16384 and optional DPR greater than 0 and at most 10`);
  }
  return { width: value.width, height: value.height, ...(value.dpr !== undefined ? { dpr: value.dpr } : {}) };
}

export function parseViewportSelection(value: unknown, where: string): BrowserViewportSelection {
  if (typeof value === 'string' && value.trim() && value === value.trim()) return value;
  return parseFixedViewport(value, where);
}

/** Layers arrive lowest priority first; a preset replaces its whole definition. */
export function mergeBrowserConfig(...layers: (BrowserConfigLayer | undefined)[]): BrowserViewportConfig {
  const config = defaultBrowserViewportConfig();
  for (const layer of layers) {
    if (!layer) continue;
    config.viewports = { ...config.viewports, ...layer.viewports };
    if (layer.defaultViewport !== undefined) config.defaultViewport = layer.defaultViewport;
  }
  resolveBrowserViewport(config);
  return config;
}

export function toolViewport(render: string, selection: BrowserViewportSelection | undefined, config: BrowserViewportConfig): BrowserViewportSetting {
  if (render === 'iframe') {
    if (selection !== undefined && selection !== 'pane-sync') throw new Error('iframe Tools require viewport: pane-sync');
    return { mode: 'pane-sync' };
  }
  return resolveBrowserViewport(config, selection);
}

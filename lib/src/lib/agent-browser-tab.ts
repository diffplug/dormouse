/**
 * A browser tab as reported by agent-browser. The same record shape arrives over
 * two channels — the live stream's `tabs` messages and the CLI's `tab list
 * --json` — so the parse lives here once, shared by the connection (webview) and
 * the host (Node). Some CLI builds report the identifier as `id` instead of
 * `tabId`, so both forms are accepted.
 */
export interface AgentBrowserTab {
  tabId: string;
  title: string | null;
  url: string;
  active: boolean;
}

export function parseTabRecord(record: unknown): AgentBrowserTab | null {
  if (!record || typeof record !== 'object') return null;
  const t = record as Record<string, unknown>;
  const tabId = typeof t.tabId === 'string'
    ? t.tabId
    : typeof t.id === 'string'
      ? t.id
      : null;
  if (!tabId) return null;
  return {
    tabId,
    title: typeof t.title === 'string' ? t.title : null,
    url: typeof t.url === 'string' ? t.url : '',
    active: t.active === true,
  };
}

export function parseAgentBrowserTabs(raw: unknown): AgentBrowserTab[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(parseTabRecord).filter((tab): tab is AgentBrowserTab => !!tab);
}

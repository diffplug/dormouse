/**
 * The dockview boundary for pane content. Dockview hands panel/header components
 * its own `IDockviewPanelProps` / `IDockviewPanelHeaderProps` objects; these four
 * adapters translate one into the engine-agnostic `PaneProps` (docs/specs/
 * tiling-engine.md → "Pane props contract") and render the plain component. They
 * are the ONLY surviving pane/header consumers of the dockview panel-props types —
 * every body/header component takes plain `PaneProps`, so the LathHost binding can
 * render the same components with props it supplies itself.
 */
import { useCallback, useEffect, useState } from 'react';
import type { IDockviewPanelProps, IDockviewPanelHeaderProps } from 'dockview-react';
import type { PaneProps } from './pane-props';
import { TerminalPanel } from './TerminalPanel';
import { BrowserPanel } from './BrowserPanel';
import { TerminalPaneHeader } from './TerminalPaneHeader';
import { SurfacePaneHeader } from './SurfacePaneHeader';

function useDockviewPaneProps(props: IDockviewPanelProps | IDockviewPanelHeaderProps): PaneProps {
  const { api } = props;

  // Title: the components used to read `api.title` on whatever re-render happened
  // to fire; an explicit `onDidTitleChange` subscription is strictly fresher (and
  // more correct) than that incidental read. Re-sync on subscribe since the event
  // only reports future changes.
  const [title, setTitle] = useState<string | undefined>(api.title);
  useEffect(() => {
    setTitle(api.title);
    const disposable = api.onDidTitleChange(() => setTitle(api.title));
    return () => disposable.dispose();
  }, [api]);

  // Engine visibility: dockview's "active tab in its group" signal (the document-
  // visibility half stays in useSurfaceVisibility). Re-sync from the api in case
  // visibility flipped between render and this subscribe — the event only reports
  // future changes. The api members are absent on minimal mocks / hosts that don't
  // wire them; absence reads as always-visible.
  const [panelVisible, setPanelVisible] = useState<boolean>(api.isVisible ?? true);
  useEffect(() => {
    setPanelVisible(api.isVisible ?? true);
    const disposable = api.onDidVisibilityChange?.((e) => setPanelVisible(e.isVisible));
    return () => disposable?.dispose();
  }, [api]);

  // The dockview group element carries the pane-spawn animation class today.
  const getAnimEl = useCallback(() => api.group?.element ?? null, [api]);

  return { id: api.id, title, params: props.params, panelVisible, getAnimEl };
}

export function TerminalPanelAdapter(props: IDockviewPanelProps) {
  return <TerminalPanel {...useDockviewPaneProps(props)} />;
}

export function BrowserPanelAdapter(props: IDockviewPanelProps) {
  return <BrowserPanel {...useDockviewPaneProps(props)} />;
}

export function TerminalPaneHeaderAdapter(props: IDockviewPanelHeaderProps) {
  return <TerminalPaneHeader {...useDockviewPaneProps(props)} />;
}

export function SurfacePaneHeaderAdapter(props: IDockviewPanelHeaderProps) {
  return <SurfacePaneHeader {...useDockviewPaneProps(props)} />;
}

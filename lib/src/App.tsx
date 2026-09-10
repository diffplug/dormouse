import { Component, type ReactNode } from "react";
import { Wall } from "./components/Wall";
import { WorkspaceWindow } from "./components/WorkspaceWindow";
import { ThemeDebuggerGlobal } from "./components/ThemeDebugger";
import type { PersistedDoor, PersistedSurfaceRefs } from "./lib/session-types";

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ color: 'red', padding: 20, fontFamily: 'monospace', whiteSpace: 'pre-wrap' }}>
          <h1>Render Error</h1>
          <p>{this.state.error.message}</p>
          <pre>{this.state.error.stack}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App({
  initialPaneIds,
  restoredLathLayout,
  initialDoors,
  initialSurfaceRefs,
  initialSurfaceRefsNext,
  baseboardNotice,
  dialogHost,
  enableBurrow,
  multiWorkspace = false,
}: {
  initialPaneIds?: string[];
  restoredLathLayout?: unknown;
  initialDoors?: PersistedDoor[];
  initialSurfaceRefs?: PersistedSurfaceRefs;
  initialSurfaceRefsNext?: number;
  baseboardNotice?: ReactNode;
  dialogHost?: ReactNode;
  enableBurrow?: boolean;
  /** Render one Wall per Workspace instead of one for the whole page. Only the
   *  standalone host sets it; VS Code and the website playground mount a bare
   *  Wall (docs/specs/layout.md → "Workspaces"). */
  multiWorkspace?: boolean;
}) {
  const Shell = multiWorkspace ? WorkspaceWindow : Wall;
  return (
    <ErrorBoundary>
      <Shell initialPaneIds={initialPaneIds} restoredLathLayout={restoredLathLayout} initialDoors={initialDoors} initialSurfaceRefs={initialSurfaceRefs} initialSurfaceRefsNext={initialSurfaceRefsNext} baseboardNotice={baseboardNotice} dialogHost={dialogHost} enableBurrow={enableBurrow} />

      <ThemeDebuggerGlobal />
    </ErrorBoundary>
  );
}

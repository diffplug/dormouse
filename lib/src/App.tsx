import { Component, type ReactNode } from "react";
import { Wall } from "./components/Wall";
import { ThemeDebuggerGlobal } from "./components/ThemeDebugger";
import type { PersistedDoor } from "./lib/session-types";

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
  restoredLayout,
  initialDoors,
  baseboardNotice,
  enableRemoteHost,
}: {
  initialPaneIds?: string[];
  restoredLayout?: unknown;
  initialDoors?: PersistedDoor[];
  baseboardNotice?: ReactNode;
  enableRemoteHost?: boolean;
}) {
  return (
    <ErrorBoundary>
      <Wall initialPaneIds={initialPaneIds} restoredLayout={restoredLayout} initialDoors={initialDoors} baseboardNotice={baseboardNotice} enableRemoteHost={enableRemoteHost} />
      <ThemeDebuggerGlobal />
    </ErrorBoundary>
  );
}

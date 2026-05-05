import type { SerializedDockview } from 'dockview-react';
import type { PersistedDoor } from '../../lib/session-types';

export type DooredItem = Omit<PersistedDoor, 'layoutAtMinimize'> & {
  layoutAtMinimize: SerializedDockview | null;
};

export type WallMode = 'command' | 'passthrough';

export type WallSelectionKind = 'pane' | 'door';

export type WallEvent =
  | { type: 'modeChange'; mode: WallMode }
  | { type: 'zoomChange'; zoomed: boolean }
  | { type: 'minimizeChange'; count: number }
  | { type: 'split'; direction: 'horizontal' | 'vertical'; source: 'keyboard' | 'mouse' }
  | { type: 'selectionChange'; id: string | null; kind: WallSelectionKind }
  | { type: 'kill'; id: string }
  | { type: 'move'; fromId: string; toId: string };

export type SpawnDirection = 'left' | 'top' | 'top-left';

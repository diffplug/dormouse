import type { WallActions } from '../components/Wall';

/** Every `WallActions` member inert, for stories that mount a pane header. */
export const noopActions: WallActions = {
  onKill: () => {},
  onMinimize: () => {},
  onSplitH: () => {},
  onSplitV: () => {},
  onZoom: () => {},
  onClickPanel: () => {},
  onEnterPanel: () => {},
  onFrameLeader: () => {},
  onFocusPane: () => {},
  onStartRename: () => {},
  onFinishRename: () => ({ accepted: true }),
  onCancelRename: () => {},
  onSwapRenderMode: () => {},
  onResolveToolApproval: () => {},
};

import { useEffect } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import {
  TerminalPaneHeader,
  ModeContext,
  SelectedIdContext,
  WallActionsContext,
  RenamingIdContext,
  type WallMode,
  type WallActions,
} from '../components/Wall';
import { MouseOverrideBanner } from '../components/wall/MouseOverrideBanner';
import {
  setMouseReporting,
  setOverride,
  type MouseTrackingMode,
  type OverrideState,
} from '../lib/mouse-selection';

const SESSION_ID = 'mouse-story';

const noopActions: WallActions = {
  onKill: () => {},
  onMinimize: () => {},
  onAlertButton: () => 'noop',
  onToggleTodo: () => {},
  onSplitH: () => {},
  onSplitV: () => {},
  onZoom: () => {},
  onClickPanel: () => {},
  onFocusPane: () => {},
  onStartRename: () => {},
  onFinishRename: () => ({ accepted: true }),
  onCancelRename: () => {},
  onSwapRenderMode: () => {},
};

function MouseIconStoryFrame({
  mouseReporting = 'none' as MouseTrackingMode,
  override = 'off' as OverrideState,
  title = 'build-server',
  mode = 'command' as WallMode,
  width = 360,
}: {
  mouseReporting?: MouseTrackingMode;
  override?: OverrideState;
  title?: string;
  mode?: WallMode;
  width?: number;
}) {
  useEffect(() => {
    setMouseReporting(SESSION_ID, mouseReporting);
    setOverride(SESSION_ID, override);
    return () => {
      setMouseReporting(SESSION_ID, 'none');
    };
  }, [mouseReporting, override]);

  return (
    <ModeContext.Provider value={mode}>
      <SelectedIdContext.Provider value={SESSION_ID}>
        <WallActionsContext.Provider value={noopActions}>
          <RenamingIdContext.Provider value={null}>
            <div style={{ width }}>
              <div className="bg-app-bg" style={{ height: 26 }}>
                <TerminalPaneHeader
                  id={SESSION_ID}
                  title={title}
                  params={undefined}
                  panelVisible={true}
                  getAnimEl={() => null}
                />
              </div>
              <div className="relative" style={{ height: 40 }}>
                <MouseOverrideBanner terminalId={SESSION_ID} />
              </div>
            </div>
          </RenamingIdContext.Provider>
        </WallActionsContext.Provider>
      </SelectedIdContext.Provider>
    </ModeContext.Provider>
  );
}

const meta: Meta<typeof MouseIconStoryFrame> = {
  title: 'Components/MouseHeaderIcon',
  component: MouseIconStoryFrame,
  argTypes: {
    mouseReporting: { control: 'radio', options: ['none', 'x10', 'vt200', 'drag', 'any'] },
    override: { control: 'radio', options: ['off', 'temporary', 'permanent'] },
    mode: { control: 'radio', options: ['command', 'passthrough'] },
  },
};

export default meta;
type Story = StoryObj<typeof MouseIconStoryFrame>;

export const Hidden: Story = {
  args: { mouseReporting: 'none', override: 'off' },
};

export const ReportingOn: Story = {
  args: { mouseReporting: 'vt200', override: 'off' },
};

export const TemporaryOverride: Story = {
  args: { mouseReporting: 'vt200', override: 'temporary', width: 500 },
};

export const PermanentOverride: Story = {
  args: { mouseReporting: 'any', override: 'permanent' },
};

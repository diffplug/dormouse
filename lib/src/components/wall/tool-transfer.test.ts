import { describe, expect, it } from 'vitest';
import { createLathWallEngine, persistableLeafMeta, toolLeafMeta } from './lath-wall-engine';
import { captureToolParams, restoreToolParams } from './tool-transfer';
import type { RestoredSession } from '../../lib/session-restore';
import { beginToolStop, endToolStop } from '../../lib/tool-reap-store';

const params = {
  surfaceType: 'tool', command: 'pnpm storybook', toolRender: 'agent-browser-screencast',
  url: 'http://localhost:6006/edited', renderMode: 'agent-browser-screencast',
  session: 'dormouse.1.tool-one', stream: 9222, toolAnnouncedPort: 6006, toolAnnouncedPath: '/token/view',
};

function engine(initial = params) {
  const lath = createLathWallEngine();
  lath.store.addLeaf('tool', toolLeafMeta('Storybook', initial), null);
  return lath;
}

describe('Tool Workspace transfer', () => {
  it('carries a live binding to panes and Doors without changing the durable record', () => {
    const lath = engine();
    const tools = captureToolParams(lath, ['tool']);
    const durable = lath.serializeLayout();
    const door = { id: 'tool', ...persistableLeafMeta(lath.getMeta('tool')!) };
    const plan: RestoredSession = { paneIds: ['tool'], lathLayout: durable, doors: [door] };
    restoreToolParams(plan, tools);
    expect(plan.lathLayout!.leafMeta.tool.params).toEqual(params);
    expect(plan.doors[0].params).toEqual(params);
    expect(durable.leafMeta.tool.params).not.toHaveProperty('url');
    expect(durable.leafMeta.tool.params).not.toHaveProperty('toolAnnouncedPort');
    expect(durable.leafMeta.tool.params).not.toHaveProperty('toolAnnouncedPath');
    expect(door.params).not.toHaveProperty('session');
    expect(lath.getMeta('tool')!.params).toEqual(params);
  });

  it('keeps a preview slot the slot, in the live binding and the durable record alike', () => {
    const slot = { ...params, toolPreview: true, toolTarget: '/repo/a.md' };
    const lath = engine(slot);
    const plan: RestoredSession = { paneIds: ['tool'], lathLayout: lath.serializeLayout(), doors: [] };
    expect(plan.lathLayout!.leafMeta.tool.params).toMatchObject({ toolPreview: true, toolTarget: '/repo/a.md' });
    restoreToolParams(plan, captureToolParams(lath, ['tool']));
    expect(plan.lathLayout!.leafMeta.tool.params).toMatchObject({ toolPreview: true, toolTarget: '/repo/a.md' });
  });

  it('refuses while approval or browser startup still owns work in the source', () => {
    const lath = engine();
    lath.store.updateParams('tool', { session: undefined });
    expect(() => captureToolParams(lath, ['tool'])).toThrow('connect');
    lath.store.updateParams('tool', { toolPending: {
      name: 'storybook', run: 'pnpm storybook', path: '/repo/dormouse.yml',
      projectRoot: '/repo', minimized: false, upstreamUrl: null,
    } });
    expect(() => captureToolParams(lath, ['tool'])).toThrow('Approve or decline');
    expect(lath.store.has('tool')).toBe(true);
  });

  it('waits for a playwright Tool browser to bind before transfer', () => {
    const lath = engine({ ...params, renderMode: 'playwright-screencast', toolRender: 'playwright-screencast', session: undefined });
    expect(() => captureToolParams(lath, ['tool'])).toThrow('connect');
  });

  it('never overlays a binding on a terminal or an absent Surface', () => {
    const plan: RestoredSession = { paneIds: ['shell'], doors: [{ id: 'shell', title: 'Shell', component: 'terminal' }] };
    restoreToolParams(plan, { shell: params, missing: params });
    expect(plan.doors).toEqual([{ id: 'shell', title: 'Shell', component: 'terminal' }]);
  });

  it('refuses to move a Tool while it is stopping, whose PTY this webview is about to kill', () => {
    const lath = engine();
    beginToolStop('tool');
    expect(() => captureToolParams(lath, ['tool'])).toThrow(/stopping/);
    endToolStop('tool');
    expect(() => captureToolParams(lath, ['tool'])).not.toThrow();
  });
});

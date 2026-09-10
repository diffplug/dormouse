import { describe, expect, it } from 'vitest';
import { dorWorkspaceRefusal } from '../src/dor-workspace-guard';

describe('dorWorkspaceRefusal', () => {
  it('lets an ordinary request through, and the one Workspace this webview has', () => {
    expect(dorWorkspaceRefusal('surface.list', {})).toBeNull();
    expect(dorWorkspaceRefusal('surface.split', undefined)).toBeNull();
    expect(dorWorkspaceRefusal('surface.list', { scope: 'workspace' })).toBeNull();
    for (const workspace of ['workspace:1', '1', ' workspace:1 ']) {
      expect(dorWorkspaceRefusal('surface.kill', { workspace })).toBeNull();
    }
  });

  it('refuses a Workspace this webview does not have', () => {
    expect(dorWorkspaceRefusal('surface.split', { workspace: 'workspace:2' }))
      .toMatch(/each Workspace in its own webview.*no workspace 'workspace:2'/);
    expect(dorWorkspaceRefusal('surface.split', { workspace: 'build' })).not.toBeNull();
    // Whatever crossed the socket, not a validated string.
    expect(dorWorkspaceRefusal('surface.split', { workspace: 2 })).not.toBeNull();
  });

  it('refuses the Workspace-spanning listing and every container verb', () => {
    expect(dorWorkspaceRefusal('surface.list', { scope: 'all' })).toMatch(/dor list --all/);
    for (const method of ['workspace.list', 'workspace.new', 'workspace.rename', 'workspace.close', 'workspace.switch']) {
      expect(dorWorkspaceRefusal(method, {})).toMatch(/dor workspace/);
    }
  });
});

import { describe, expect, it } from 'vitest';
import { dorWorkspaceRefusal } from '../src/dor-workspace-guard';

describe('dorWorkspaceRefusal', () => {
  it('lets an ordinary request through, and the one Workspace this webview has', () => {
    expect(dorWorkspaceRefusal('surface.list', {})).toBeNull();
    expect(dorWorkspaceRefusal('surface.split', undefined)).toBeNull();
    expect(dorWorkspaceRefusal('surface.list', { scope: 'workspace' })).toBeNull();
    // Positionally, and by the name a bare Wall registers — a caller that read
    // the name out of `dor list` hands it straight back.
    for (const workspace of ['workspace:1', '1', ' workspace:1 ', 'Workspace 1', 'workspace:Workspace 1']) {
      expect(dorWorkspaceRefusal('surface.kill', { workspace })).toBeNull();
    }
  });

  it('refuses a Workspace this webview does not have', () => {
    expect(dorWorkspaceRefusal('surface.split', { workspace: 'workspace:2' }))
      .toMatch(/each Workspace in its own webview.*no workspace 'workspace:2': this webview is workspace:1/);
    expect(dorWorkspaceRefusal('surface.split', { workspace: 'build' })).not.toBeNull();
    // The retired spelling of this webview's own id names nothing.
    expect(dorWorkspaceRefusal('surface.split', { workspace: 'workspace-1' })).not.toBeNull();
    // Whatever crossed the socket, not a validated string.
    expect(dorWorkspaceRefusal('surface.split', { workspace: 2 })).not.toBeNull();
  });

  it('refuses the Workspace-spanning listing and every container verb', () => {
    expect(dorWorkspaceRefusal('surface.list', { scope: 'all' })).toMatch(/dor list --all/);
    for (const method of ['workspace.list', 'workspace.new', 'workspace.rename', 'workspace.close', 'workspace.switch', 'workspace.move', 'workspace.pin']) {
      expect(dorWorkspaceRefusal(method, {})).toMatch(/dor workspace/);
    }
  });
});

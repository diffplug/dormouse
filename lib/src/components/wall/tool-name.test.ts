import { describe, expect, it } from 'vitest';
import { toolSemanticName } from './tool-name';

describe('toolSemanticName', () => {
  it('names a Tool opened on a file or folder after its target, previewed or pinned', () => {
    const viewer = { surfaceType: 'tool', command: 'view /repo/README.md', toolName: 'viewer', toolKey: ['viewer', '/repo/README.md'], toolTarget: '/repo/README.md' };
    expect(toolSemanticName(viewer)).toBe('README.md');
    expect(toolSemanticName({ ...viewer, toolPreview: true })).toBe('README.md');
    expect(toolSemanticName({ surfaceType: 'tool', command: 'dor __view-folder /repo/fixture/', toolName: 'folder', toolTarget: '/repo/fixture/' })).toBe('fixture');
    expect(toolSemanticName({ surfaceType: 'tool', command: 'x', toolTarget: 'C:\\repo\\notes.txt' })).toBe('notes.txt');
  });

  it('names a named Tool by its name and what its key adds, paths by their last component', () => {
    expect(toolSemanticName({ command: 'pnpm storybook', toolName: 'storybook', toolKey: ['storybook', '/Users/me/dormouse.open-folder'] }))
      .toBe('storybook dormouse.open-folder');
    expect(toolSemanticName({ command: 'x', toolName: 'api', toolKey: ['api', 'staging', 'C:\\work\\shop', 'api'] })).toBe('api staging shop');
    expect(toolSemanticName({ command: 'x', toolName: 'docs', toolKey: ['docs', '/srv/docs'] })).toBe('docs');
    expect(toolSemanticName({ command: 'pnpm dev', toolName: 'dev' })).toBe('dev');
  });

  it('names an anonymous Tool by its command', () => {
    expect(toolSemanticName({ surfaceType: 'tool', command: 'python3 -m http.server 8000', toolArgv: ['python3', '-m', 'http.server', '8000'] }))
      .toBe('python3 -m http.server 8000');
    expect(toolSemanticName({ surfaceType: 'tool', command: '' })).toBeNull();
    expect(toolSemanticName(undefined)).toBeNull();
  });

  it('lets a user rename win over every other name', () => {
    expect(toolSemanticName({ command: 'view /repo/a.md', toolName: 'viewer', toolTarget: '/repo/a.md' }, ' notes ')).toBe('notes');
    expect(toolSemanticName({ command: 'pnpm storybook', toolName: 'storybook', toolKey: ['storybook', '/repo'] }, 'sb')).toBe('sb');
    expect(toolSemanticName({ command: 'pnpm dev' }, 'web')).toBe('web');
    expect(toolSemanticName({ command: 'pnpm dev' }, '  ')).toBe('pnpm dev');
  });

  it('reads nothing but its params and the rename', () => {
    // A port, an address, a page title, or a stored title never name the Tool.
    expect(toolSemanticName({
      command: 'view /repo/a.md', toolTarget: '/repo/a.md', url: 'http://localhost:7007/b.md',
      toolAnnouncedPort: 7007, renderMode: 'iframe', title: 'Other',
    })).toBe('a.md');
  });
});

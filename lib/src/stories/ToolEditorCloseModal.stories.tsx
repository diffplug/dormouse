import { useLayoutEffect } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { ToolEditorCloseModalHost } from '../components/ToolEditorCloseModalHost';
import { cancelEditorClose, confirmToolEditorsClose, connectToolEditor, decideEditorClose } from '../lib/tool-editor';
import { clearToolDirty, recordToolDirty } from '../lib/tool-dirty-store';
import { requireElement } from './settle-terminals';

/**
 * The desktop "Save changes?" prompt a close of a dirty Tool raises, primed
 * through the stores the close path uses. Each editor is connected to a frame
 * that never answers, so a Save fails as an unready editor's does.
 */
function EditorClosePrompt({ labels, saveFailed }: { labels: string[]; saveFailed?: boolean }) {
  useLayoutEffect(() => {
    const ids = labels.map((_, index) => `story-tool-${index}`);
    const disconnects = ids.map((id, index) => connectToolEditor(id, labels[index], document.createElement('iframe'), 'null'));
    for (const id of ids) recordToolDirty(id, true);
    void confirmToolEditorsClose(ids);
    if (saveFailed) void decideEditorClose('save');
    return () => {
      cancelEditorClose();
      for (const disconnect of disconnects) disconnect();
      for (const id of ids) clearToolDirty(id);
    };
  }, [labels, saveFailed]);
  return <ToolEditorCloseModalHost />;
}

const meta: Meta<typeof EditorClosePrompt> = {
  title: 'Modals/ToolEditorCloseModal',
  component: EditorClosePrompt,
  args: { labels: ['README.md'] },
  play: async () => { await requireElement('#save-tool-title', 'Save changes? dialog'); },
};

export default meta;
type Story = StoryObj<typeof EditorClosePrompt>;

export const OneTool: Story = {};

/** A Workspace close naming every dirty Tool it would end. */
export const SeveralTools: Story = {
  args: { labels: ['README.md', 'docs/specs/dor-tool.md', 'screenshot.png'] },
};

/** A Save the editor could not finish keeps the prompt up with the reason. */
export const SaveFailed: Story = {
  args: { saveFailed: true },
  play: async () => { await requireElement('#save-tool-title ~ [role="alert"]', 'save error'); },
};

import { useEffect, useRef } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import '@xterm/xterm/css/xterm.css';
import { CopyEditor } from '../components/CopyEditor';
import { SelectionOverlay } from '../components/SelectionOverlay';
import {
  focusSession,
  getOrCreateTerminal,
  getTerminalInstance,
  getTerminalOverlayDims,
  mountElement,
  refitSession,
  unmountElement,
} from '../lib/terminal-registry';
import type { FakeScenario } from '../lib/platform';
import { openCopyEditor, setCopyFormat, setCopyScope } from '../lib/copy-editor';
import { getMouseSelectionState, setCopyEditor, setSelection, type Selection } from '../lib/mouse-selection';
import type { BreakKind, CopyFormat } from '../lib/copy-text';
import { TERMINAL_BOTTOM_RADIUS_CLASS } from '../components/design';
import { TouchUiContext } from '../components/touch-ui-context';
import { settleTerminals, waitForCondition } from './settle-terminals';

// A Claude Code reply as Ink hard-wraps it at 76 of 80 columns.
const REPLY = [
  '> why is selection-text.test.ts flaky on CI?',
  '',
  '⏺ The flake comes from a race between the PTY exit event and the final flush',
  '  of the output buffer. When the child exits before xterm has drained its',
  '  write queue, the last chunk is dropped and the assertion on the prompt',
  '  text fails intermittently.',
  '',
  '  The fix is to await the write callback before reading the buffer:',
  '',
  '    await new Promise<void>((resolve) => terminal.write(chunk, resolve));',
  '    const text = extractSelectionText(terminal, selection);',
  "    expect(text).toBe('user@dormouse:~$ ls');",
  '',
  '  I opened a draft with the change: https://github.com/diffplug/dormouse/pul',
  '  l/853/files#diff-7c1f3e9a2b8d4f6e0a5c7b9d1e3f5a7c9b1d3e5f',
  '',
];
const SCENARIO_CLAUDE_REPLY: FakeScenario = {
  name: 'claude-reply',
  chunks: [{ delay: 0, data: REPLY.join('\r\n') }],
};

interface EditorPreset {
  scope?: number;
  format?: CopyFormat;
  overrides?: Record<number, BreakKind>;
}

function CopyEditorStory({
  id,
  selection,
  editor = {},
  touch = false,
}: {
  id: string;
  selection: Omit<Selection, 'startedInScrollback' | 'dragging'>;
  editor?: EditorPreset;
  touch?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    getOrCreateTerminal(id);
    mountElement(id, host);
    const observer = new ResizeObserver(() => refitSession(id));
    observer.observe(host);
    return () => {
      observer.disconnect();
      unmountElement(id);
    };
  }, [id]);

  useEffect(() => {
    focusSession(id, true);
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const apply = () => {
      if (cancelled) return;
      const dims = getTerminalOverlayDims(id);
      const terminal = getTerminalInstance(id);
      if (!dims || dims.cellHeight === 0 || !terminal) {
        timer = setTimeout(apply, 50);
        return;
      }
      // What a mouse-up does: finalize, then open the editor over it.
      setSelection(id, { ...selection, dragging: false, startedInScrollback: false });
      openCopyEditor(id, terminal);
      if (editor.scope) setCopyScope(id, editor.scope);
      if (editor.format) setCopyFormat(id, editor.format);
      const opened = getMouseSelectionState(id).copyEditor;
      if (opened && editor.overrides) setCopyEditor(id, { ...opened, overrides: editor.overrides });
    };
    timer = setTimeout(apply, 100);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      setSelection(id, null);
    };
  }, [id, selection, editor]);

  return (
    <TouchUiContext.Provider value={touch}>
      <div className={`relative bg-terminal-bg ${TERMINAL_BOTTOM_RADIUS_CLASS}`} style={{ width: 640, height: 400 }}>
        <div ref={hostRef} className="h-full w-full" />
        <SelectionOverlay terminalId={id} />
        <CopyEditor terminalId={id} />
      </div>
    </TouchUiContext.Provider>
  );
}

const meta: Meta<typeof CopyEditorStory> = {
  title: 'Components/CopyEditor',
  component: CopyEditorStory,
  parameters: {
    fakePty: { scenario: SCENARIO_CLAUDE_REPLY },
  },
  // Hold the snapshot until the terminal painted and the editor opened.
  play: async ({ args }) => {
    await settleTerminals();
    await waitForCondition(() => getMouseSelectionState(args.id).copyEditor !== null);
  },
};

export default meta;
type Story = StoryObj<typeof CopyEditorStory>;

/** A hard-wrapped paragraph, the drag ending mid-word: Auto joins each wrap
 *  with a space; `e` would expand to whole words. */
export const Prose: Story = {
  args: {
    id: 'copy-editor-prose',
    selection: { startRow: 2, startCol: 25, endRow: 5, endCol: 20, shape: 'linewise' },
  },
};

/** The same drag in Exact: every displayed break and indent. */
export const Exact: Story = {
  args: {
    id: 'copy-editor-exact',
    selection: { startRow: 2, startCol: 25, endRow: 5, endCol: 20, shape: 'linewise' },
    editor: { format: 'exact' },
  },
};

/** A URL split at the margin with its start missed, expanded once: the dashed
 *  scope shows what it adds, and Auto rejoins the split with no space. */
export const ExpandedUrl: Story = {
  args: {
    id: 'copy-editor-url',
    selection: { startRow: 13, startCol: 44, endRow: 14, endCol: 30, shape: 'linewise' },
    editor: { scope: 1 },
  },
};

/** Prose then code: Auto joins the wraps and keeps the code's breaks; one
 *  break flipped by hand reads `Auto*`. */
export const ProseAndCode: Story = {
  args: {
    id: 'copy-editor-code',
    selection: { startRow: 2, startCol: 2, endRow: 11, endCol: 44, shape: 'linewise' },
    editor: { overrides: { 1: 'keep' } },
  },
};

/** A block slab: never rewrapped, never expanded, no edge keys. */
export const Block: Story = {
  args: {
    id: 'copy-editor-block',
    selection: { startRow: 2, startCol: 2, endRow: 5, endCol: 30, shape: 'block' },
  },
};

/** Touch: no key hints, above the selection, clear of the thumb. */
export const Touch: Story = {
  args: {
    id: 'copy-editor-touch',
    touch: true,
    selection: { startRow: 13, startCol: 36, endRow: 14, endCol: 58, shape: 'linewise' },
  },
};

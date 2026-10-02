import { homedir } from 'node:os';
import { buildCommand } from '@stricli/core';
import type { Command, DorCommandContext, WorkspaceScopedFlags } from './types.js';
import { callerWorkingDirectory, requireControlClient, stringParser, workspaceFlag, workspaceParam } from './shared.js';
import { listFiles } from './file-list.js';
import { runFilePicker } from './open-picker.js';
import { dispatchToolSurface, TOOL_TIMEOUT_MS } from './tool.js';

interface OpenFlags extends WorkspaceScopedFlags {
  readonly json?: boolean;
  readonly minimize?: boolean;
  readonly fresh?: boolean;
  readonly surface?: string;
  readonly cwd?: string;
  readonly tool?: string;
  readonly preview?: boolean;
}

export const openCommand: Command = {
  name: 'open',
  command: buildCommand<OpenFlags, [string?], DorCommandContext>({
    docs: {
      brief: 'Open a local file or folder with a Dor Tool (alias: o).',
      fullDescription: `Opens one existing local file or folder. \`dor o\` is the same command. Relative paths resolve from the caller's directory (or --cwd); symlink aliases resolve to the same path. A file: URL naming this machine is accepted as its path; other URLs and Surface handles are not.

The first matching rule in the user dormouse.yml selects a user Tool or a built-in viewer. --tool chooses a handler explicitly. Without a matching rule, the built-in file viewer opens supported HTML, text/source, image, and media files. PDFs require a user Tool association or --tool <name>. Use --tool builtin:file to select it explicitly. Markdown opens in the Markdown editor. Project associations and project Tools never participate in this lookup. The user file is $XDG_CONFIG_HOME/dormouse/dormouse.yml, or ~/.config/dormouse/dormouse.yml.

The ordered open list contains {match, tool, preview} entries; the optional preview names the handler --preview uses instead of tool. Patterns without a slash match the filename; patterns with a slash match both the canonical absolute path and the path relative to the invocation directory. Matching uses picomatch glob syntax with forward slashes and case sensitivity. Dotfiles require explicit patterns. The built-in HTML viewer serves statically referenced relative assets within the document directory tree; root-relative and external resources are unavailable. Text previews are capped at 8 MiB.

A folder matches only rules whose pattern ends in .📁, tested against its name or path with .📁 appended: *.📁 matches every folder except dot-folders, which .*.📁 matches. No other rule matches a folder, and no .📁 rule matches a file. Without a matching rule, builtin:folder lists the folder's entry names, dotfiles included, with a Show ignored checkbox for entries git ignores; clicking a file previews it with dor open --preview, and double-clicking opens it with dor open.

Without a path, in an interactive terminal, a fuzzy finder lists the files under the directory (git's tracked and untracked files, less ignored ones, inside a work tree; otherwise every non-hidden file outside node_modules). Type to filter, ↑/↓ or the mouse to select, Enter or a double-click to open. Beside the list — or on one status line when the terminal is narrower than 100 columns — it shows the handler the file opens with and why: the matching open rule, or the built-in. Every later matching rule's handlers and the built-ins that support the file are offered too; Tab, Shift+Tab, ←/→, or a click chooses one, which opens as --tool would. Esc or Ctrl+C cancels, exiting 1 silently. The other flags apply to the chosen file. Without a terminal, a path is required.

builtin:code opens any text file, Markdown and HTML included, as source in the code editor; builtin:file shows Markdown in the Markdown editor and HTML rendered.

The selected Tool receives the canonical absolute path as one argument. Configure prespawn_dedupe: [$TARGET] to reveal the same file on repeated opens within a Workspace. --fresh bypasses reuse.

Placement follows dor tool: typed alone at a prompt in a visible, integrated plain terminal in the requested directory, opening takes over that pane, preserving its terminal and scrollback. Agent/script invocations, compound lines, a pane with a helper, --minimize, --surface, or --cwd elsewhere split without taking focus. The pane remains a Tool after its command exits: opening a different file from that prompt splits unless keyed reuse finds an existing Tool; the same keyed file reruns in place. A matching Tool elsewhere is reused. The command prints the Surface handle; --json prints structured output.

--preview shows the file or folder in this Workspace's preview slot: one reusable pane, marked by an italic label, that each preview retargets in place — reporting "retargeted", or "superseded" when a newer preview replaced it first. Opening what the slot shows without --preview keeps it open, as do double-clicking its pane header, Keep open in its terminal context, and the Tool reporting unsaved changes; the next preview then gets a new slot. A retarget interrupts the slot with Ctrl+C, so preview Tools should exit on it (less -K, glow); a slot still running a second later is kept open instead. A preview never takes over the calling pane, and a Tool already kept open for it is revealed instead.`,
    },
    parameters: {
      flags: {
        json: { kind: 'boolean', brief: 'Print JSON output.', optional: true, withNegated: false },
        minimize: { kind: 'boolean', brief: 'Create the surface minimized.', optional: true, withNegated: false },
        fresh: { kind: 'boolean', brief: 'Open another instance even when the Tool has a key.', optional: true, withNegated: false },
        surface: { kind: 'parsed', parse: stringParser, brief: 'Surface to split when creating.', optional: true, placeholder: 'id|ref' },
        workspace: workspaceFlag,
        cwd: { kind: 'parsed', parse: stringParser, brief: 'Directory for resolving the path.', optional: true, placeholder: 'path' },
        tool: { kind: 'parsed', parse: stringParser, brief: 'Use a user Tool, builtin:file, builtin:code, or builtin:folder.', optional: true, placeholder: 'name' },
        preview: { kind: 'boolean', brief: "Show it in this Workspace's preview slot.", optional: true, withNegated: false },
      },
      positional: { kind: 'tuple', parameters: [{ parse: stringParser, brief: 'Local file or folder to open; omit it to choose one.', placeholder: 'path', optional: true }] },
    },
    async func(this: DorCommandContext, flags: OpenFlags, path?: string) {
      // The slot is one reused pane: it is never another instance or a Door.
      if (flags.preview && (flags.fresh || flags.minimize)) {
        return new Error(`--preview cannot be combined with ${flags.fresh ? '--fresh' : '--minimize'}`);
      }
      const cwd = callerWorkingDirectory(flags.cwd, this.options.env);
      let file = path;
      let tool = flags.tool;
      if (file === undefined) {
        const choice = await pickFile(this, cwd, flags);
        if (choice instanceof Error) return choice;
        // A cancel opens nothing and prints nothing, but is not a success.
        if (!choice) {
          this.process.exitCode = 1;
          return undefined;
        }
        file = choice.file;
        tool = choice.tool ?? tool;
      }
      return dispatchToolSurface(this, {
        file,
        tool,
        ...workspaceParam(flags.workspace),
        fresh: flags.fresh === true,
        minimized: flags.minimize === true,
        surface: flags.surface,
        cwd,
        ...(flags.preview ? { preview: true } : {}),
      }, flags.json === true);
    },
  }),
};

/** The picker's choice, null when cancelled. */
async function pickFile(context: DorCommandContext, cwd: string, flags: OpenFlags) {
  const { terminal } = context.options;
  if (!terminal) return new Error('dor open needs a path when it is not run in an interactive terminal');
  // Fail before drawing anything when there is no Dormouse to open in.
  const client = requireControlClient(context.options, TOOL_TIMEOUT_MS);
  if (client instanceof Error) return client;
  const home = context.options.env?.HOME ?? homedir();
  return runFilePicker({
    terminal,
    listFiles: (onFiles, signal) => listFiles(cwd, { onFiles, signal, home }),
    handlers: file => client.openHandlers({ target: file, cwd, ...(flags.preview ? { preview: true } : {}) }),
    fixedTool: flags.tool,
    home,
  });
}

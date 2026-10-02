# dor open

Invocation: `dor open --help`

```text
USAGE
  dor open [--json] [--minimize] [--fresh] [--surface id|ref] [--workspace ref] [--cwd path] [--tool name] [--preview] [<path>]
  dor open --help

Opens one existing local file or folder. `dor o` is the same command. Relative paths resolve from the caller's directory (or --cwd); symlink aliases resolve to the same path. A file: URL naming this machine is accepted as its path; other URLs and Surface handles are not.

The first matching rule in the user dormouse.yml selects a user Tool or a built-in viewer. --tool chooses a handler explicitly. Without a matching rule, the built-in file viewer opens supported HTML, text/source, image, and media files. PDFs require a user Tool association or --tool <name>. Use --tool builtin:file to select it explicitly. Markdown is shown as source text; a user Tool can provide rendered Markdown. Project associations and project Tools never participate in this lookup. The user file is $XDG_CONFIG_HOME/dormouse/dormouse.yml, or ~/.config/dormouse/dormouse.yml.

The ordered open list contains {match, tool, preview} entries; the optional preview names the handler --preview uses instead of tool. Patterns without a slash match the filename; patterns with a slash match both the canonical absolute path and the path relative to the invocation directory. Matching uses picomatch glob syntax with forward slashes and case sensitivity. Dotfiles require explicit patterns. The built-in HTML viewer serves statically referenced relative assets within the document directory tree; root-relative and external resources are unavailable. Text previews are capped at 8 MiB.

A folder matches only rules whose pattern ends in .📁, tested against its name or path with .📁 appended: *.📁 matches every folder except dot-folders, which .*.📁 matches. No other rule matches a folder, and no .📁 rule matches a file. Without a matching rule, builtin:folder lists the folder's entry names, dotfiles included, with a Show ignored checkbox for entries git ignores; clicking a file previews it with dor open --preview, and double-clicking opens it with dor open.

Without a path, in an interactive terminal, a fuzzy finder lists the files under the directory (git's tracked and untracked files, less ignored ones, inside a work tree; otherwise every non-hidden file outside node_modules). Type to filter, ↑/↓ or the mouse to select, Enter or a double-click to open. Beside the list — or on one status line when the terminal is narrower than 100 columns — it shows the handler the file opens with and why: the matching open rule, or the built-in. Every later matching rule's handlers and the built-ins that support the file are offered too; Tab, Shift+Tab, ←/→, or a click chooses one, which opens as --tool would. Esc or Ctrl+C cancels, exiting 1 silently. The other flags apply to the chosen file. Without a terminal, a path is required.

builtin:code opens any text file, Markdown and HTML included, as source in the code editor; builtin:file shows Markdown in the Markdown editor and HTML rendered.

The selected Tool receives the canonical absolute path as one argument. Configure prespawn_dedupe: [$TARGET] to reveal the same file on repeated opens within a Workspace. --fresh bypasses reuse.

Placement follows dor tool: typed alone at a prompt in a visible, integrated plain terminal in the requested directory, opening takes over that pane, preserving its terminal and scrollback. Agent/script invocations, compound lines, a pane with a helper, --minimize, --surface, or --cwd elsewhere split without taking focus. The pane remains a Tool after its command exits: opening a different file from that prompt splits unless keyed reuse finds an existing Tool; the same keyed file reruns in place. A matching Tool elsewhere is reused. The command prints the Surface handle; --json prints structured output.

--preview shows the file or folder in this Workspace's preview slot: one reusable pane, marked by an italic label, that each preview retargets in place — reporting "retargeted", or "superseded" when a newer preview replaced it first. Opening what the slot shows without --preview keeps it open, as do double-clicking its pane header, Keep open in its terminal context, and the Tool reporting unsaved changes; the next preview then gets a new slot. A retarget interrupts the slot with Ctrl+C, so preview Tools should exit on it (less -K, glow); a slot still running a second later is kept open instead. A preview never takes over the calling pane, and a Tool already kept open for it is revealed instead.

FLAGS
     [--json]       Print JSON output.
     [--minimize]   Create the surface minimized.
     [--fresh]      Open another instance even when the Tool has a key.
     [--surface]    Surface to split when creating.
     [--workspace]  Workspace to act in, instead of the caller's.
     [--cwd]        Directory for resolving the path.
     [--tool]       Use a user Tool, builtin:file, or builtin:folder.
     [--preview]    Show it in this Workspace's preview slot.
  -h  --help        Print help information and exit
      --            All subsequent inputs should be interpreted as arguments

ARGUMENTS
  [path]  Local file or folder to open; omit it to choose one.

```

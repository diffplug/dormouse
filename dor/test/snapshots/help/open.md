# dor open

Invocation: `dor open --help`

```text
USAGE
  dor open [--json] [--minimize] [--fresh] [--surface id|ref] [--workspace ref] [--cwd path] [--tool name] <file>
  dor open --help

Opens one existing local file. Relative paths resolve from the caller's directory (or --cwd); symlink aliases resolve to the same file. URLs, directories, and Surface handles are not accepted.

The first matching rule in the user dormouse.yml selects a user Tool or builtin:file. --tool chooses a handler explicitly. Without a matching rule, the built-in viewer opens supported HTML, text/source, image, PDF, and media files. Use --tool builtin:file to select it explicitly. Markdown is shown as source text; a user Tool can provide rendered Markdown. Project associations and project Tools never participate in this lookup. The user file is $XDG_CONFIG_HOME/dormouse/dormouse.yml, or ~/.config/dormouse/dormouse.yml.

The ordered open list contains {match, tool} entries. Patterns without a slash match the filename; patterns with a slash match both the canonical absolute path and the path relative to the invocation directory. Matching uses picomatch glob syntax with forward slashes and case sensitivity. Dotfiles require explicit patterns. The built-in HTML viewer serves statically referenced relative assets within the document directory tree; root-relative and external resources are unavailable. Text previews are capped at 8 MiB.

The selected Tool receives the canonical absolute filename as one argument. Configure prespawn_dedupe: [$TARGET] to reveal the same file on repeated opens within a Workspace. --fresh bypasses reuse.

Opening creates a focus-neutral split or reveals an existing Tool, never taking over the caller's terminal. The command prints the Surface handle; --json prints structured output.

FLAGS
     [--json]       Print JSON output.
     [--minimize]   Create the surface minimized.
     [--fresh]      Open another instance even when the Tool has a key.
     [--surface]    Surface to split when creating.
     [--workspace]  Workspace to act in, instead of the caller's.
     [--cwd]        Directory for resolving the file.
     [--tool]       Use a user Tool or builtin:file.
  -h  --help        Print help information and exit
      --            All subsequent inputs should be interpreted as arguments

ARGUMENTS
  file  Local file to open.

```

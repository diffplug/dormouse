# dor iframe

Invocation: `dor iframe --help`

```text
USAGE
  dor iframe [--focus] [--json] [--minimize] [--surface handle] [--workspace ref] <target>
  dor iframe --help

Opens an http:// page in a high-fidelity iframe surface for a human to look at.

Agents cannot read or drive an iframe surface, and it drops the page's cookies, so logins do not work in it. For those, and for any https:// page, which the iframe refuses, use `dor agent-browser open <url>`.

A page from another machine opens only from a private network you allow, from its warning or Settings → Network; a page on the internet never does.

If the caller surface is an untouched terminal, Dormouse replaces that terminal with the iframe. Otherwise Dormouse creates a split next to the caller/focused surface.

Typed alone at a prompt, the command focuses the Surface it opens or reuses; an agent's or a script's invocation leaves focus where it is. --focus or --focus=false decides either way. --minimize turns the default off, and --focus with --minimize is an error.

The target is one of:
  <url>          An absolute http:// URL.
  host:port      A schemeless host:port, defaulted to http:// (e.g.
                 localhost:5173, box.ts.net:3000). The explicit port marks a
                 dev/infra server, which is http far more often than not.
  :<port>        Sugar for http://localhost:<port> (e.g. :5173).
  surface:<n>    A terminal Surface handle (surface:N, surface:self, or
                 surface:focused). Dormouse scans that terminal's
                 listening ports and opens http://localhost:<port>/; it fails if
                 the terminal owns zero or multiple ports.

Text output:
  created surface:3  "http://localhost:5173/"
  replaced surface:1  "http://localhost:5173/"

JSON output:
  {
    "status": "created",
    "surface_id": "surface:3",
    "url": "http://localhost:5173/",
    "minimized": false
  }

FLAGS
     [--focus]      Focus the created or reused Surface (default: only when typed alone at a prompt).
     [--json]       Print JSON output.
     [--minimize]   Create or replace the surface minimized.
     [--surface]    Surface to replace or split from.
     [--workspace]  Workspace to act in, instead of the caller's.
  -h  --help        Print help information and exit
      --            All subsequent inputs should be interpreted as arguments

ARGUMENTS
  target  URL, host:port, :port, or surface handle to open.

```

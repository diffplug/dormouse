/** Private `surface.iframe` command wiring and open-target resolution. */

import { buildCommand } from '@stricli/core';
import type {
  Command,
  DorCommandContext,
  IframeSurfaceResponse,
} from './types.js';
import {
  renderJson,
  requireControlClient,
  stringParser,
  writeStdout,
} from './shared.js';
import {
  isSurfaceOpenTarget,
  normalizeConcreteOpenUrl,
  resolveSurfaceOpenTarget,
} from './open-target.js';

interface IframeFlags {
  readonly json?: boolean;
  readonly minimize?: boolean;
  readonly surface?: string;
}

export const iframeCommand: Command = {
  name: 'iframe',
  command: buildCommand<IframeFlags, [string], DorCommandContext>({
    docs: {
      brief: 'Open a target in an iframe surface.',
      fullDescription: `Opens a target in a high-fidelity iframe surface for human inspection.

If the caller surface is an untouched terminal, Dormouse replaces that terminal with the iframe. Otherwise Dormouse creates a split next to the caller/focused surface.

The target is one of:
  <url>          An absolute http:// or https:// URL (an explicit scheme is
                 always honored).
  host:port      A schemeless host:port, defaulted to http:// (e.g.
                 localhost:5173, box.ts.net:3000). The explicit port marks a
                 dev/infra server, which is http far more often than not.
  :<port>        Sugar for http://localhost:<port> (e.g. :5173).
  surface:<ref>  A terminal Surface handle (surface:N, surface:self,
                 surface:focused, or a stable id). Dormouse scans that terminal's
                 listening ports and opens http://localhost:<port>/; it fails if
                 the terminal owns zero or multiple ports.

Text output:
  created surface:3  "http://localhost:5173"
  replaced surface:1  "http://localhost:5173"

JSON output:
  {
    "status": "created",
    "surface_id": "pane-abc",
    "surface_ref": "surface:3",
    "url": "http://localhost:5173",
    "minimized": false
  }`,
    },
    parameters: {
      flags: {
        json: { kind: 'boolean', brief: 'Print JSON output.', optional: true, withNegated: false },
        minimize: { kind: 'boolean', brief: 'Create or replace the surface minimized.', optional: true, withNegated: false },
        surface: { kind: 'parsed', parse: stringParser, brief: 'Surface to replace or split from.', optional: true, placeholder: 'id|ref' },
      },
      positional: {
        kind: 'tuple',
        parameters: [
          { parse: parseIframeTarget, brief: 'URL, host:port, :port, or surface handle to open.', placeholder: 'target' },
        ],
      },
    },
    func: runIframeCommand,
  }),
};

async function runIframeCommand(this: DorCommandContext, flags: IframeFlags, target: string): Promise<void | Error> {
  const client = requireControlClient(this.options);
  if (client instanceof Error) return client;

  // A `surface:` handle is resolved to its dev-server URL by the host port scan;
  // concrete targets (URL / bare :port) were already normalized at parse time.
  let url = target;
  if (isSurfaceOpenTarget(target)) {
    const resolved = await resolveSurfaceOpenTarget(target, client);
    if (!resolved.ok) return new Error(resolved.message);
    url = resolved.value;
  }

  try {
    const response = await client.iframeSurface({
      minimized: flags.minimize === true,
      surface: flags.surface,
      url,
    });
    writeStdout(this, renderIframeResponse(response, flags.json === true));
    return undefined;
  } catch (error) {
    return new Error(error instanceof Error ? error.message : String(error));
  }
}

// A `surface:` handle passes through verbatim for async resolution in the func;
// every other form is normalized to a URL here so a bad target fails at parse
// time. A schemeless `:port` / `host:port` is inferred to `http://`; only a
// non-http(s) scheme or otherwise unparseable input is rejected.
function parseIframeTarget(input: string): string {
  return isSurfaceOpenTarget(input) ? input : normalizeConcreteOpenUrl(input);
}

function renderIframeResponse(response: IframeSurfaceResponse, json: boolean): string {
  if (json) {
    return renderJson({
      status: response.status,
      surface_id: response.surfaceId,
      surface_ref: response.surfaceRef,
      url: response.url,
      minimized: response.minimized,
    });
  }

  const minimized = response.minimized ? '  [minimized]' : '';
  return `${response.status} ${response.surfaceRef}${minimized}  ${JSON.stringify(response.url)}\n`;
}

/** Private `surface.iframe` command wiring and URL validation. */

import { buildCommand } from '@stricli/core';
import type {
  Command,
  DorCommandContext,
  IframeSurfaceResponse,
} from './types.js';
import {
  resolveControlClient,
  stringParser,
  writeStdout,
} from './shared.js';

declare const URL: {
  new(input: string): { href: string; protocol: string };
};

interface IframeFlags {
  readonly json?: boolean;
  readonly minimize?: boolean;
  readonly surface?: string;
}

export const iframeCommand: Command = {
  name: 'iframe',
  command: buildCommand<IframeFlags, [string], DorCommandContext>({
    docs: {
      brief: 'Open a URL in an iframe surface.',
      fullDescription: `Opens a URL in a high-fidelity iframe surface for human inspection.

If the caller surface is an untouched terminal, Dormouse replaces that terminal with the iframe. Otherwise Dormouse creates a split next to the caller/focused surface.

The URL must be an absolute http:// or https:// URL. Dormouse does not infer schemes.

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
        surface: { kind: 'parsed', parse: stringParser, brief: 'Surface to replace or split from.', optional: true, placeholder: 'id|ref|index' },
      },
      positional: {
        kind: 'tuple',
        parameters: [
          { parse: parseIframeUrl, brief: 'URL to open.', placeholder: 'url' },
        ],
      },
    },
    func: runIframeCommand,
  }),
};

async function runIframeCommand(this: DorCommandContext, flags: IframeFlags, url: string): Promise<void | Error> {
  const clientResult = resolveControlClient(this.options);
  if (!clientResult.ok) return new Error(clientResult.message);

  try {
    const response = await clientResult.value.iframeSurface({
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

function parseIframeUrl(input: string): string {
  let url: { href: string; protocol: string };
  try {
    url = new URL(input);
  } catch {
    throw new SyntaxError('URL must be an absolute http:// or https:// URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SyntaxError('URL must use http:// or https://');
  }

  return url.href;
}

function renderIframeResponse(response: IframeSurfaceResponse, json: boolean): string {
  if (json) {
    return `${JSON.stringify({
      status: response.status,
      ...(response.surfaceId ? { surface_id: response.surfaceId } : {}),
      surface_ref: response.surfaceRef,
      url: response.url,
      minimized: response.minimized,
    }, null, 2)}\n`;
  }

  const minimized = response.minimized ? '  [minimized]' : '';
  return `${response.status} ${response.surfaceRef}${minimized}  ${JSON.stringify(response.url)}\n`;
}

/**
 * The `toolControl` wire shapes (`docs/specs/dor-tool.md`).
 *
 * Their own module, like `iframe-proxy-types.ts`: the webview, both adapters,
 * and the Node host all reference them, and the Node side must not drag
 * `lib/src/host` (and its `yaml` dependency) into a browser bundle.
 */

export type ToolHostRequest =
  | { op: 'lookup'; name: string; cwd: string }
  | { op: 'trust'; kind: 'upstream' | 'folder'; projectRoot: string; upstreamUrl: string | null };

/** Result of resolving a tool name. `ok` carries the rendered dedupe key: the
 *  host owns `$PROJECT_ROOT`, so the webview never sees a template. */
export type ToolLookupResult =
  | { status: 'no-file' }
  | { status: 'unknown-tool'; projectRoot: string; path: string; names: string[] }
  | {
      status: 'untrusted';
      projectRoot: string;
      path: string;
      name: string;
      run: string;
      /** Canonical upstream URL, or null when there is no resolvable remote. */
      upstreamUrl: string | null;
    }
  | { status: 'error'; message: string }
  | {
      status: 'ok';
      projectRoot: string;
      path: string;
      name: string;
      run: string;
      /** Renderer for the tool's browser once it serves; 'iframe' by default. */
      render: 'iframe' | 'ab-screencast';
      /** How to pick the port to frame absent an announcement; 'announced' by
       *  default, meaning nothing is framed without OSC 367. */
      port: 'announced' | 'auto';
      key: string[] | null;
      warnings: string[];
    };

export type ToolControlResult = ToolLookupResult | { status: 'trust-recorded' };

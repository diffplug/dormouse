/**
 * The `toolControl` wire shapes (`docs/specs/dor-tool.md`).
 *
 * Their own module, like `iframe-proxy-types.ts`: the webview, both adapters,
 * and the Node host all reference them, and the Node side must not drag
 * `lib/src/host` (and its `yaml` dependency) into a browser bundle.
 */

export type ToolHostRequest =
  | { op: 'open'; target: string; cwd: string; tool?: string }
  | { op: 'lookup'; name: string; cwd: string; args?: string[]; global?: boolean }
  | { op: 'trust'; kind: 'upstream' | 'folder'; projectRoot: string };

/** Which authority declared a Tool, namespacing its dedupe key and persisted
 *  `scope`. Project Tools carry none. `docs/specs/dor-tool.md` -> Identity and
 *  dedupe. */
export type ToolKeyScope = 'user' | 'builtin';
export const isToolKeyScope = (value: unknown): value is ToolKeyScope => value === 'user' || value === 'builtin';

/** Result of resolving a tool name. `ok` carries the rendered dedupe key: the
 *  host owns `$PROJECT_ROOT`, so the webview never sees a template.
 *
 *  Every outcome that parsed a configuration file carries that file's
 *  `warnings`, so a config lint reaches the caller on the path it hits first —
 *  an untrusted repo's `pending` answer — and not only on a later already-
 *  trusted run (`docs/specs/dor-tool.md` -> Declaring tools). */
export type ToolLookupResult =
  | { status: 'no-file' }
  | { status: 'unknown-tool'; projectRoot: string; path: string; names: string[] }
  | {
      status: 'untrusted';
      projectRoot: string;
      path: string;
      name: string;
      run: string | readonly string[];
      /** Canonical upstream URL, or null when there is no resolvable remote. */
      upstreamUrl: string | null;
      warnings: string[];
    }
  | { status: 'error'; message: string }
  | {
      status: 'ok';
      projectRoot: string;
      path: string;
      name: string;
      run: string | readonly string[];
      /** Renderer for the tool's browser once it serves; 'iframe' by default. */
      render: 'iframe' | 'ab-screencast';
      scope?: ToolKeyScope;
      /** How to pick the port to frame absent an announcement; 'announced' by
       *  default, meaning nothing is framed without OSC 367. */
      port: 'announced' | 'auto';
      key: string[] | null;
      warnings: string[];
    };

export type ToolControlResult = ToolLookupResult | { status: 'trust-recorded' };

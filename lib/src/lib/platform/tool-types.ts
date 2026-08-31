/**
 * The `toolControl` wire shapes (`docs/specs/dor-tool.md`).
 *
 * Their own module, like `iframe-proxy-types.ts`: the webview, both adapters,
 * and the Node host all reference them, and the Node side must not drag
 * `lib/src/host` (and its `yaml` dependency) into a browser bundle.
 */

export type ToolHostRequest =
  | { op: 'lookup'; name: string; cwd: string }
  | { op: 'trust'; root: string; decision: 'trusted' | 'denied' };

/** Result of resolving a tool name. `ok` carries the rendered dedupe key: the
 *  host owns `$PROJECT_ROOT`, so the webview never sees a template. */
export type ToolLookupResult =
  | { status: 'no-file' }
  | { status: 'unknown-tool'; projectRoot: string; path: string; names: string[] }
  | { status: 'untrusted'; projectRoot: string; path: string; name: string; run: string }
  | { status: 'denied'; projectRoot: string; path: string }
  | { status: 'error'; message: string }
  | {
      status: 'ok';
      projectRoot: string;
      path: string;
      name: string;
      run: string;
      key: string[] | null;
      warnings: string[];
    };

export type ToolControlResult = ToolLookupResult | { status: 'trust-recorded' };

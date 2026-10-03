import { isToolControlMethod, TOOL_CONTROL_METHODS, unsupportedControlMethodMessage } from 'dor/protocol';
import { getPlatformOrNull } from '../../lib/platform';
import { stringParam } from './dor-control-shared';
import type { DorControlRequest } from './use-dor-control';
import type { ToolControlResult, ToolHostRequest } from '../../lib/platform/tool-types';

/**
 * The `tool.*` reads (`docs/specs/dor-tool.md` → CLI): the host's answer about
 * the Tool configuration, relayed with no Workspace or Surface involved.
 */
export async function handleToolControl(detail: DorControlRequest): Promise<void> {
  if (!isToolControlMethod(detail.method)) {
    detail.respond({ ok: false, error: unsupportedControlMethodMessage(detail.method) });
    return;
  }
  const params = detail.params ?? {};
  const cwd = stringParam(params.cwd)?.trim();
  /** Relays one host read, answering its `status` arm's payload. */
  const relay = async <S extends ToolControlResult['status']>(
    request: ToolHostRequest, status: S, pick: (result: Extract<ToolControlResult, { status: S }>) => unknown,
  ) => {
    const platform = getPlatformOrNull();
    if (!platform?.toolControl) {
      detail.respond({ ok: false, error: 'this host cannot read a dormouse.yml' });
      return;
    }
    const result = await platform.toolControl(request);
    detail.respond(result.status === status
      ? { ok: true, result: pick(result as Extract<ToolControlResult, { status: S }>) }
      : { ok: false, error: result.status === 'error' ? result.message : 'unexpected tool host response' });
  };
  switch (detail.method) {
    case TOOL_CONTROL_METHODS.list: {
      if (!cwd) {
        detail.respond({ ok: false, error: 'cwd is required' });
        return;
      }
      await relay({ op: 'list', cwd, global: params.global === true }, 'list', result => result.listing);
      return;
    }
    case TOOL_CONTROL_METHODS.openHandlers: {
      const target = stringParam(params.target);
      if (!cwd || !target) {
        detail.respond({ ok: false, error: 'cwd and target are required' });
        return;
      }
      await relay({ op: 'open-handlers', target, cwd, preview: params.preview === true }, 'open-handlers', result => result.handlers);
      return;
    }
    default: {
      const unhandled: never = detail.method;
      throw new Error(`unhandled tool control method '${String(unhandled)}'`);
    }
  }
}

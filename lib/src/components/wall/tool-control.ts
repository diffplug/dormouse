import { isToolControlMethod, TOOL_CONTROL_METHODS, unsupportedControlMethodMessage } from 'dor/protocol';
import { getPlatformOrNull } from '../../lib/platform';
import { stringParam } from './dor-control-shared';
import type { DorControlRequest } from './use-dor-control';

/**
 * The `tool.*` reads (`docs/specs/dor-tool.md` → CLI): the host's answer about
 * the Tool configuration, relayed with no Workspace or Surface involved.
 */
export async function handleToolControl(detail: DorControlRequest): Promise<void> {
  if (!isToolControlMethod(detail.method)) {
    detail.respond({ ok: false, error: unsupportedControlMethodMessage(detail.method) });
    return;
  }
  switch (detail.method) {
    case TOOL_CONTROL_METHODS.list: {
      const params = detail.params ?? {};
      const cwd = stringParam(params.cwd)?.trim();
      if (!cwd) {
        detail.respond({ ok: false, error: 'cwd is required' });
        return;
      }
      const platform = getPlatformOrNull();
      if (!platform?.toolControl) {
        detail.respond({ ok: false, error: 'this host cannot read a dormouse.yml' });
        return;
      }
      const result = await platform.toolControl({ op: 'list', cwd, global: params.global === true });
      detail.respond(result.status === 'list'
        ? { ok: true, result: result.listing }
        : { ok: false, error: result.status === 'error' ? result.message : 'unexpected tool host response' });
      return;
    }
    case TOOL_CONTROL_METHODS.openHandlers: {
      const params = detail.params ?? {};
      const cwd = stringParam(params.cwd)?.trim();
      const target = stringParam(params.target);
      if (!cwd || !target) {
        detail.respond({ ok: false, error: 'cwd and target are required' });
        return;
      }
      const platform = getPlatformOrNull();
      if (!platform?.toolControl) {
        detail.respond({ ok: false, error: 'this host cannot read a dormouse.yml' });
        return;
      }
      const result = await platform.toolControl({ op: 'open-handlers', target, cwd, preview: params.preview === true });
      detail.respond(result.status === 'open-handlers'
        ? { ok: true, result: result.handlers }
        : { ok: false, error: result.status === 'error' ? result.message : 'unexpected tool host response' });
      return;
    }
    default: {
      const unhandled: never = detail.method;
      throw new Error(`unhandled tool control method '${String(unhandled)}'`);
    }
  }
}

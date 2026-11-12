// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { dispatchDorControlRequest } from './dor-control-dispatch';

describe('dispatchDorControlRequest', () => {
  const seen: Array<Record<string, unknown>> = [];
  const listener = (event: Event) => seen.push((event as CustomEvent<Record<string, unknown>>).detail);
  window.addEventListener('dormouse:control-request', listener);
  afterEach(() => { seen.length = 0; });

  // The CLI focus default applies only to control-socket requests
  // (docs/specs/dor-cli.md -> "Focus intent").
  it('marks every request the webview makes itself, and no control-socket request', () => {
    const payload = { requestId: 'r', surfaceId: 'surface:1', method: 'surface.tool', params: {} };
    dispatchDorControlRequest({ ...payload, requestId: 'socket' }, () => {});
    dispatchDorControlRequest({ ...payload, requestId: 'gui' }, () => {}, { gui: true });
    dispatchDorControlRequest({ ...payload, requestId: 'link' }, () => {}, { terminalLink: true });
    dispatchDorControlRequest({ ...payload, requestId: 'osc' }, () => {}, { oscOpen: true });
    expect(seen.map(detail => [detail.requestId, detail.gui])).toEqual([
      ['socket', undefined], ['gui', true], ['link', true], ['osc', true],
    ]);
  });
});

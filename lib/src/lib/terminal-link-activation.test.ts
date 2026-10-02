/**
 * @vitest-environment jsdom
 *
 * An `OSC 8` click (`docs/specs/dor-tool.md` -> Terminal links): a local file
 * link naming its target asks the answering Wall to open it, previewing on a
 * click and pinning on a double-click; anything else, or a refusal, asks the
 * confirmation dialog.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PREVIEW_SUPERSEDED_ERROR } from 'dor/commands/types';
import { SURFACE_CONTROL_METHODS, type DorControlResult } from 'dor/protocol';
import { clearExternalLinkConfirmation, getExternalLinkConfirmationSnapshot } from './external-link-confirmation';
import { setPlatform } from './platform';
import type { PlatformAdapter } from './platform/types';
import { activateTerminalLink } from './terminal-link-activation';
import { removeTerminalPaneState, seedTerminalManualCwd } from './terminal-state-store';

const SESSION = 'pane-link';
const URI = 'file://host.local/work/docs/README.md';

interface Request { surfaceId?: string; method: string; params: Record<string, unknown>; respond: (response: DorControlResult) => void }
let requests: Request[];
const capture = (event: Event) => { requests.push((event as CustomEvent<Request>).detail); };

beforeEach(() => {
  requests = [];
  setPlatform({ toolControl: vi.fn() } as unknown as PlatformAdapter);
  window.addEventListener('dormouse:control-request', capture);
});

afterEach(() => {
  window.removeEventListener('dormouse:control-request', capture);
  clearExternalLinkConfirmation();
  removeTerminalPaneState(SESSION);
});

const click = (detail: number, uri = URI, text = 'docs/README.md') => activateTerminalLink(SESSION, { detail }, uri, text);

describe('activateTerminalLink', () => {
  it('previews an eligible link on a click, as a dor open from its Session', () => {
    seedTerminalManualCwd(SESSION, '/work');
    click(1);
    expect(requests).toEqual([expect.objectContaining({
      surfaceId: SESSION,
      method: SURFACE_CONTROL_METHODS.tool,
      params: { file: URI, preview: true, cwd: '/work' },
    })]);
    expect(getExternalLinkConfirmationSnapshot()).toBeNull();
  });

  it('pins on the second click of a double-click, and ignores a third', () => {
    click(1);
    click(2);
    click(3);
    expect(requests.map(request => request.params.preview)).toEqual([true, false]);
  });

  it('runs in the target directory when the Session reports no cwd', () => {
    click(1);
    click(1, 'file:///C:/work/README.md', 'README.md');
    click(1, 'file:///C:/README.md', 'README.md');
    expect(requests.map(request => request.params.cwd)).toEqual(['/work/docs', 'C:/work', 'C:/']);
  });

  it('preserves the source and directory for a labelled file confirmation', () => {
    seedTerminalManualCwd(SESSION, '/work');
    click(1, URI, '[Image #2]');
    expect(getExternalLinkConfirmationSnapshot()).toMatchObject({ source: { surfaceId: SESSION, cwd: '/work' } });
    expect(requests).toEqual([]);
  });

  it('sends an ineligible link to the dialog without a request', () => {
    click(1, URI, 'EADME.md');
    click(1, 'https://example.com/README.md', 'README.md');
    expect(requests).toEqual([]);
    expect(getExternalLinkConfirmationSnapshot()).toMatchObject({ uri: 'https://example.com/README.md', displayText: 'README.md' });
  });

  it('sends every link to the dialog on a host that cannot open files', () => {
    setPlatform({} as PlatformAdapter);
    click(1);
    expect(requests).toEqual([]);
    expect(getExternalLinkConfirmationSnapshot()).toMatchObject({ uri: URI, displayText: 'docs/README.md' });
  });

  it('falls back to the dialog when the open fails', () => {
    click(1);
    requests[0].respond({ ok: false, error: 'not a local file link' });
    expect(getExternalLinkConfirmationSnapshot()).toMatchObject({ uri: URI, displayText: 'docs/README.md' });
  });

  it('opens the dialog once for a double-click whose preview and pin both fail', () => {
    click(1);
    click(2);
    requests[0].respond({ ok: false, error: 'no open rule matches' });
    expect(getExternalLinkConfirmationSnapshot()).toMatchObject({ uri: URI, displayText: 'docs/README.md' });
    // The user cancels before the pin's answer arrives.
    clearExternalLinkConfirmation();
    requests[1].respond({ ok: false, error: 'no open rule matches' });
    expect(getExternalLinkConfirmationSnapshot()).toBeNull();
  });

  it('opens the dialog for a pin that fails after its preview succeeded', () => {
    click(1);
    click(2);
    requests[0].respond({ ok: true, result: { status: 'created' } });
    requests[1].respond({ ok: false, error: 'tool launch cancelled' });
    expect(getExternalLinkConfirmationSnapshot()).toMatchObject({ uri: URI, displayText: 'docs/README.md' });
  });

  it('leaves a superseded preview alone', () => {
    click(1);
    click(1);
    requests[0].respond({ ok: true, result: { status: 'superseded' } });
    requests[1].respond({ ok: false, error: PREVIEW_SUPERSEDED_ERROR });
    expect(getExternalLinkConfirmationSnapshot()).toBeNull();
  });
});

import { describe, expect, it, vi } from 'vitest';
import { closeForClient, type CloseForClientDeps } from './close-for-client';

const deps = (overrides: Partial<CloseForClientDeps> = {}): CloseForClientDeps => ({
  gone: () => false,
  isTerminal: () => false,
  transferRefusal: () => null,
  helperRefusal: async () => null,
  needsConfirm: () => false,
  isDirty: () => false,
  label: () => 'notes.md',
  save: vi.fn(async () => null),
  close: vi.fn(async () => null),
  ...overrides,
});

describe('closeForClient', () => {
  it('closes at once what the desktop would', async () => {
    const d = deps();
    expect(await closeForClient({}, d)).toEqual({ outcome: 'closed' });
    expect(d.close).toHaveBeenCalledOnce();
  });

  it('asks nothing about a Surface gone during the helper wait', async () => {
    let gone = false;
    const d = deps({
      gone: () => gone,
      helperRefusal: async () => {
        gone = true;
        return null;
      },
      needsConfirm: () => true,
    });
    expect(await closeForClient({}, d)).toEqual({ outcome: 'closed' });
    expect(d.close).not.toHaveBeenCalled();
  });

  it('reads no kind from a Surface gone during its last wait', async () => {
    let gone = false;
    const d = deps({
      // What a Surface with no params reads as.
      isTerminal: () => gone,
      close: async (_discard, stillRefused) => {
        gone = true;
        return stillRefused();
      },
      gone: () => gone,
    });
    expect(await closeForClient({}, d)).toEqual({ outcome: 'closed' });
  });

  it('never closes a terminal, whatever consent came', async () => {
    const d = deps({ isTerminal: () => true });
    expect(await closeForClient({ confirmed: true, unsaved: 'discard' }, d)).toEqual({
      outcome: 'refused',
      message: 'A terminal closes only on the computer.',
    });
    expect(d.close).not.toHaveBeenCalled();
  });

  it('consents to losing only the edits it was asked about', async () => {
    const clean = deps();
    await closeForClient({ unsaved: 'discard' }, clean);
    expect(clean.close).toHaveBeenCalledExactlyOnceWith(false, expect.any(Function));
    const saved = deps({ isDirty: () => true });
    await closeForClient({ unsaved: 'save' }, saved);
    expect(saved.close).toHaveBeenCalledExactlyOnceWith(false, expect.any(Function));
    const discarded = deps({ isDirty: () => true });
    await closeForClient({ unsaved: 'discard' }, discarded);
    expect(discarded.close).toHaveBeenCalledExactlyOnceWith(true, expect.any(Function));
  });

  it('asks for the confirmation until it has it', async () => {
    const d = deps({ needsConfirm: () => true });
    expect(await closeForClient({}, d)).toEqual({ outcome: 'confirm' });
    expect(d.close).not.toHaveBeenCalled();
    expect(await closeForClient({ confirmed: true }, d)).toEqual({ outcome: 'closed' });
  });

  it('asks about unsaved edits after the confirmation, as the desktop does', async () => {
    const d = deps({ needsConfirm: () => true, isDirty: () => true });
    expect(await closeForClient({}, d)).toEqual({ outcome: 'confirm' });
    expect(await closeForClient({ confirmed: true }, d)).toEqual({ outcome: 'unsaved', label: 'notes.md' });
    expect(d.close).not.toHaveBeenCalled();
    expect(await closeForClient({ confirmed: true, unsaved: 'discard' }, d)).toEqual({ outcome: 'closed' });
    expect(d.save).not.toHaveBeenCalled();
  });

  it('saves first when told to, and a failed save closes nothing', async () => {
    const saved = deps({ isDirty: () => true });
    expect(await closeForClient({ unsaved: 'save' }, saved)).toEqual({ outcome: 'closed' });
    expect(saved.save).toHaveBeenCalledOnce();

    const failed = deps({ isDirty: () => true, save: async () => 'New edits arrived while saving. Save again or cancel.' });
    expect(await closeForClient({ unsaved: 'save' }, failed)).toEqual({
      outcome: 'refused',
      message: 'New edits arrived while saving. Save again or cancel.',
    });
    expect(failed.close).not.toHaveBeenCalled();
  });

  it('passes on the desktop\'s refusals, and consent never skips them', async () => {
    for (const d of [
      deps({ transferRefusal: () => 'moving' }),
      deps({ helperRefusal: async () => 'moving' }),
      deps({ close: vi.fn(async () => 'moving') }),
    ]) {
      expect(await closeForClient({ confirmed: true, unsaved: 'discard' }, d)).toEqual({ outcome: 'refused', message: 'moving' });
    }
  });
});

import { describe, expect, it } from 'vitest';
import {
  clearExternalLinkConfirmation,
  getExternalLinkConfirmationSnapshot,
  requestExternalLinkConfirmation,
  subscribeExternalLinkConfirmation,
} from './external-link-confirmation';

describe('external link confirmation store', () => {
  it('publishes an inspected pending link and clears it', () => {
    let updates = 0;
    const unsubscribe = subscribeExternalLinkConfirmation(() => {
      updates += 1;
    });

    requestExternalLinkConfirmation('vscode://file/Users/dev/project/app.ts');
    expect(getExternalLinkConfirmationSnapshot()).toMatchObject({
      uri: 'vscode://file/Users/dev/project/app.ts',
      decision: {
        status: 'openable',
        scheme: 'vscode',
      },
    });

    clearExternalLinkConfirmation();
    expect(getExternalLinkConfirmationSnapshot()).toBeNull();
    expect(updates).toBe(2);

    unsubscribe();
  });
});

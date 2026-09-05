/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RemotePairingModal } from './RemotePairingModal';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let approved: string[];
let denied: number;

async function render(label = 'Ned’s iPhone') {
  await act(async () => {
    root.render(
      <RemotePairingModal
        label={label}
        onApprove={(code) => approved.push(code)}
        onDeny={() => denied++}
      />,
    );
  });
}

function text(): string {
  return container.textContent ?? '';
}

function codeInput(): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input');
  if (!input) throw new Error('the code field is not mounted');
  return input;
}

function buttonLabelled(label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!button) throw new Error(`no button labelled ${label}`);
  return button;
}

/** React tracks the DOM value it last wrote, so a bare assignment is swallowed. */
async function type(value: string) {
  const input = codeInput();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  approved = [];
  denied = 0;
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('RemotePairingModal', () => {
  it('names the failure mode a user has no other signal for', async () => {
    // The direction of the code is the whole control: a relayed or injected
    // request has no screen to read digits off, so the copy has to say that
    // showing no code is itself the reason to cancel.
    await render();
    expect(text()).toContain(
      'Only authorize if your phone is showing a two-digit code. If it shows an error or no code, cancel this request.',
    );
    expect(text()).toContain('Ned’s iPhone');
  });

  it('says (unnamed) rather than nothing for a Client with no label', async () => {
    // A blank row would read as a rendering failure, and the device line is
    // half of what the user is deciding about.
    await render('');
    expect(text()).toContain('(unnamed)');
  });

  it('takes two digits and nothing else', async () => {
    // The field is the whole secret and there is exactly one attempt, so
    // anything it accepts that the Burrow cannot match is a dead try.
    await render();

    await type('a');
    expect(codeInput().value).toBe('');
    await type('4a7');
    expect(codeInput().value).toBe('47');
    await type('479');
    expect(codeInput().value).toBe('47');
  });

  it('confirms only once two digits are typed, with exactly those digits', async () => {
    await render();
    expect(buttonLabelled('Confirm and authorize').disabled).toBe(true);

    await type('4');
    expect(buttonLabelled('Confirm and authorize').disabled).toBe(true);
    await act(async () => buttonLabelled('Confirm and authorize').click());
    expect(approved).toEqual([]);

    await type('47');
    expect(buttonLabelled('Confirm and authorize').disabled).toBe(false);
    await act(async () => buttonLabelled('Confirm and authorize').click());
    // Echoed verbatim: only the Burrow knows what the digits should be.
    expect(approved).toEqual(['47']);
  });

  it('cancels from the button and from Escape', async () => {
    await render();

    await act(async () => buttonLabelled('Cancel').click());
    expect(denied).toBe(1);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(denied).toBe(2);
    // Denying never writes the ACL, so neither path may approve.
    expect(approved).toEqual([]);
  });
});

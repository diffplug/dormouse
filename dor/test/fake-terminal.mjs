import assert from 'node:assert/strict';

/** A `PickerTerminal` a test types into and resizes, recording what is drawn. */
export function fakeTerminal({ columns = 120, rows = 20 } = {}) {
  let onInput;
  let onResize;
  let output = '';
  let taken = 0;
  return {
    columns: () => columns,
    rows: () => rows,
    write: (text) => { output += text; },
    listen(input, resize) { onInput = input; onResize = resize; return () => { onInput = undefined; onResize = undefined; }; },
    send(chunk) { onInput(chunk); },
    resize(width, height) { columns = width; rows = height; onResize(); },
    get output() { return output; },
    /** Output written since the previous call. */
    take() { const text = output.slice(taken); taken = output.length; return text; },
    get listening() { return onInput !== undefined; },
  };
}

export async function until(predicate, label) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${label}`);
}

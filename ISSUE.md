## Summary

The streaming WebSocket's `input_keyboard` message can deliver text, navigation keys, and modifier-bit chords, but it has **no way to trigger macOS native editing commands** (select-all, copy, cut, paste, undo, redo). On macOS, Chromium implements these via the responder chain, not via raw modifier+key events, so CDP exposes them through the `commands` array on `Input.dispatchKeyEvent` (e.g. `commands: ["selectAll"]`). The stream protocol's `input_keyboard` message exposes no equivalent field, and passing `commands` inline is dropped by the daemon. As a result, a human pair-browsing in the viewport (or any stream client) cannot Cmd+A / Cmd+C / Cmd+X / Cmd+Z inside the remote page on macOS.

Note this is distinct from web-app JS shortcuts: pages still *receive* the chord keydowns (so a page's own `cmd+k` handler fires). What's missing is OS-level **editing** behavior in native inputs/textareas.

## Environment

- agent-browser **0.27.0**
- macOS, Chrome for Testing (default `chrome` engine)
- Connecting directly to the session stream WS (`stream status --json` → `ws://127.0.0.1:<port>`)

## Reproduction

Standalone, no dashboard required:

```js
// cmdkey-repro.mjs  —  node cmdkey-repro.mjs   (agent-browser on PATH, macOS)
import { execFileSync } from 'node:child_process';
const SESSION = 'cmdkey-repro';
const ab = (...a) => execFileSync('agent-browser', ['--session', SESSION, ...a], { encoding: 'utf8' });
const setField = (v, c) => ab('eval', `(()=>{const f=document.getElementById('f');f.value=${JSON.stringify(v)};f.focus();f.setSelectionRange(${c},${c});})()`);
const val = () => JSON.parse(ab('eval', `document.getElementById('f').value`).trim());

ab('open', 'data:text/html,' + encodeURIComponent('<input id=f autofocus value="hello world">'));
const port = JSON.parse(ab('stream', 'status', '--json')).data.port;
const ws = new WebSocket(`ws://127.0.0.1:${port}`);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws failed')); });
ws.onmessage = () => {};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const send = (o) => ws.send(JSON.stringify({ type: 'input_keyboard', text: '', ...o }));

// 1. Cmd+A as a modifier chord (modifiers bit 4 = Meta), then type X.
//    If select-all fired, the field becomes "X".
setField('hello world', 11);
send({ eventType: 'keyDown', key: 'Meta', code: 'MetaLeft', windowsVirtualKeyCode: 91, modifiers: 4 });
send({ eventType: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 4 });
send({ eventType: 'keyUp',   key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 4 });
send({ eventType: 'keyUp',   key: 'Meta', code: 'MetaLeft', windowsVirtualKeyCode: 91, modifiers: 0 });
send({ eventType: 'keyDown', key: 'X', code: 'KeyX', windowsVirtualKeyCode: 88, text: 'X' });
send({ eventType: 'keyUp',   key: 'X', code: 'KeyX', windowsVirtualKeyCode: 88 });
await sleep(400);
console.log('1. Cmd+A chord then X          ->', JSON.stringify(val()), '  (want "X")');

// 2. Same, but with the CDP `commands` hint passed inline.
setField('hello world', 11);
send({ eventType: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 4, commands: ['selectAll'] });
send({ eventType: 'keyUp',   key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 4 });
send({ eventType: 'keyDown', key: 'X', code: 'KeyX', windowsVirtualKeyCode: 88, text: 'X' });
send({ eventType: 'keyUp',   key: 'X', code: 'KeyX', windowsVirtualKeyCode: 88 });
await sleep(400);
console.log('2. commands:["selectAll"]      ->', JSON.stringify(val()), '  (want "X")');

// 3. Control case: Shift+Home (pure modifier selection, no native command) then Y.
setField('hello world', 11);
send({ eventType: 'keyDown', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, modifiers: 8 });
send({ eventType: 'keyDown', key: 'Home', code: 'Home', windowsVirtualKeyCode: 36, modifiers: 8 });
send({ eventType: 'keyUp',   key: 'Home', code: 'Home', windowsVirtualKeyCode: 36, modifiers: 8 });
send({ eventType: 'keyUp',   key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, modifiers: 0 });
send({ eventType: 'keyDown', key: 'Y', code: 'KeyY', windowsVirtualKeyCode: 89, text: 'Y' });
send({ eventType: 'keyUp',   key: 'Y', code: 'KeyY', windowsVirtualKeyCode: 89 });
await sleep(400);
console.log('3. Shift+Home then Y (control) ->', JSON.stringify(val()), '  (want "Y")');

ws.close(); ab('close');
```

## Expected vs. Actual

```
1. Cmd+A chord then X          -> "hello worldX"   (want "X")   ❌ select-all did not fire
2. commands:["selectAll"]      -> "hello worldX"   (want "X")   ❌ commands field ignored
3. Shift+Home then Y (control) -> "Y"              (want "Y")   ✅ modifier selection works
```

Case 3 confirms the `modifiers` bitfield itself works end-to-end; only the native editing-command path is missing. The same holds for Cmd+C / Cmd+X / Cmd+Z.

## Root cause

CDP `Input.dispatchKeyEvent` accepts an optional `commands` array for macOS editing operations (`selectAll`, `copy`, `cut`, `paste`, `undo`, `redo`, …). On macOS these are how Chromium applies edit chords — a raw `keyDown` with `metaKey` set is not sufficient. The stream `input_keyboard` message has no field that maps to `commands`, and the daemon's deserializer drops the field when sent inline, so it can never reach `Input.dispatchKeyEvent`.

## Suggested fix

1. Add an optional `commands: string[]` field to the `input_keyboard` stream message and forward it to CDP `Input.dispatchKeyEvent.commands`.
2. In the dashboard viewport's keyboard forwarder, populate it for editing chords on macOS — e.g. map `Meta+a/c/x/v/z/Shift+z` → `["selectAll"]` / `["copy"]` / `["cut"]` / `["paste"]` / `["undo"]` / `["redo"]` — alongside the existing modifier-bit handling.

## Prior art

- #980 / #983 added modifier-chord parsing (and `text` suppression under Ctrl/Meta) to the CLI `press` command, but it sends modifier bits only — it does **not** populate CDP `commands`, so native macOS editing chords are unaffected by that fix.
- #1380 / #836 are the related "wrong `windowsVirtualKeyCode`" thread for the same `input_keyboard` forwarding path; this report is the separate, still-open editing-command gap.

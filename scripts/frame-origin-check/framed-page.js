// Runs inside the framed page, at the frame origin, loaded through the worker.
// Every result goes to the check page, which holds the list and the report.
(async () => {
  const say = (name, ok, detail) => parent.postMessage({ kind: 'check', name, ok, detail: String(detail ?? '') }, '*');
  const check = async (name, run, ms = 20000) => {
    let timer;
    try {
      const detail = await Promise.race([run(), new Promise((_, no) => { timer = setTimeout(() => no(new Error(`timed out after ${ms} ms`)), ms); })]);
      say(name, true, detail);
    } catch (error) {
      say(name, false, `${error?.name}: ${error?.message}`);
    } finally {
      clearTimeout(timer);
    }
  };
  const need = (ok, why) => { if (!ok) throw new Error(why); };
  const sum = (bytes, start = 0) => { let s = start; for (let i = 0; i < bytes.length; i += 1) s = (s + bytes[i]) >>> 0; return s; };

  await check('page is controlled by the worker', async () => {
    need(navigator.serviceWorker?.controller, 'no controller');
    return navigator.serviceWorker.controller.scriptURL.replace(location.origin, '');
  });
  await check('5 MiB body arrives whole', async () => {
    const started = performance.now();
    const response = await fetch('/blob?bytes=5308416');
    const bytes = new Uint8Array(await response.arrayBuffer());
    need(bytes.length === 5308416, `got ${bytes.length}`);
    need(sum(bytes) === Number(response.headers.get('x-sum')), 'bytes differ');
    return `${Math.round(5 / ((performance.now() - started) / 1000))} MiB/s`;
  }, 60000);
  await check('a streamed body arrives as it is sent', async () => {
    const reader = (await fetch('/slow')).body.getReader();
    const started = performance.now();
    const first = await reader.read();
    const firstAt = performance.now() - started;
    need(!first.done, 'no first chunk');
    while (!(await reader.read()).done);
    const total = performance.now() - started;
    need(firstAt < total * 0.6, `first chunk at ${Math.round(firstAt)} of ${Math.round(total)} ms: buffered`);
    return `first at ${Math.round(firstAt)} ms of ${Math.round(total)} ms`;
  });
  await check('cancelling a body reaches the Client window', async () => {
    const reader = (await fetch('/never')).body.getReader();
    await reader.read();
    await reader.cancel();
    return 'cancelled';
  });
  await check('1 MiB POST body and its Origin', async () => {
    const body = new Uint8Array(1048576).fill(9);
    const answer = await (await fetch('/echo', { method: 'POST', body })).json();
    need(answer.length === body.length && answer.sum === sum(body), JSON.stringify(answer));
    need(answer.origin === location.origin, `origin ${answer.origin}`);
    return `${answer.length} bytes`;
  });
  await check('120 parallel requests', async () => {
    const all = await Promise.all(Array.from({ length: 120 }, (_, i) => fetch(`/m/${i}`).then((r) => r.text())));
    need(all.every((text, i) => text === `m${i}`), 'wrong body');
    return all.length;
  }, 45000);
  await check('204 and a redirect', async () => {
    need((await fetch('/empty')).status === 204, 'no 204');
    const after = await fetch('/redirect');
    need(new URL(after.url).pathname === '/after' && (await after.text()) === 'after', after.url);
    return 'ok';
  });
  await check('a Web Worker loads through the worker', () => new Promise((resolve, reject) => {
    const worker = new Worker('/editor-worker.js');
    worker.onmessage = (event) => (event.data === 'worker-ran' ? resolve(event.data) : reject(new Error(event.data)));
    worker.onerror = (event) => reject(new Error(event.message || 'worker error'));
  }));
  await check('a nested frame is controlled too', () => new Promise((resolve, reject) => {
    addEventListener('message', function on(event) {
      if (event.data?.kind !== 'nested') return;
      removeEventListener('message', on);
      if (event.data.controlled) resolve('controlled');
      else reject(new Error('not controlled'));
    });
    const frame = document.createElement('iframe');
    frame.src = '/nested.html';
    document.body.append(frame);
  }));
  await check('WebSocket shim carries both directions', () => new Promise((resolve, reject) => {
    need(window.WebSocket.toString().indexOf('native code') < 0, 'shim not installed');
    const socket = new WebSocket('/hmr', 'vite-hmr');
    socket.binaryType = 'arraybuffer';
    const got = [];
    socket.onopen = () => { socket.send('ping'); socket.send(new Uint8Array(400000).buffer); };
    socket.onmessage = (event) => {
      got.push(typeof event.data === 'string' ? event.data : event.data.byteLength);
      if (got.length === 2) socket.close(1000, 'done');
    };
    socket.onclose = (event) => {
      if (got[0] === 'ping' && got[1] === 400000 && event.code === 1000 && socket.protocol === 'vite-hmr') resolve(JSON.stringify(got));
      else reject(new Error(`${JSON.stringify(got)} code ${event.code} protocol ${socket.protocol}`));
    };
  }));
  await check('a page keeps localStorage across runs', async () => {
    const before = localStorage.getItem('frame-check');
    localStorage.setItem('frame-check', String(Date.now()));
    need(localStorage.getItem('frame-check'), 'did not stick');
    return before ? `kept from ${Math.round((Date.now() - Number(before)) / 1000)} s ago` : 'first run: set';
  });
  await check('a page has IndexedDB', () => new Promise((resolve, reject) => {
    const open = indexedDB.open('frame-check', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('s');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => { open.result.close(); resolve('opened'); };
  }));
  parent.postMessage({ kind: 'page-done' }, '*');
})();

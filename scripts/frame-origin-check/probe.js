(async () => {
  const report = (fields) => parent.postMessage({ kind: 'probe', secure: isSecureContext, ...fields }, '*');
  const sw = navigator.serviceWorker;
  if (!sw) return report({ hasApi: false, registered: false, detail: 'navigator.serviceWorker is missing' });
  try {
    const registration = await sw.register('/__dormouse-frame-sw.js');
    report({ hasApi: true, registered: true, detail: `scope ${new URL(registration.scope).pathname}` });
  } catch (error) {
    report({ hasApi: true, registered: false, detail: `${error?.name}: ${error?.message}` });
  }
})();

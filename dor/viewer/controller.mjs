const MAX_PIXELS = 16 * 1024 * 1024;
const MAX_DIMENSION = 8192;

/** Bound both canvas dimensions and backing pixels, including unusual page
 * sizes and high-DPI displays. CSS zoom does not allocate a larger bitmap. */
export function canvasSize(width, height, deviceScale) {
  const ratio = Math.min(Math.max(1, deviceScale || 1), 2,
    MAX_DIMENSION / width, MAX_DIMENSION / height, Math.sqrt(MAX_PIXELS / (width * height)));
  return { width: Math.max(1, Math.floor(width * ratio)), height: Math.max(1, Math.floor(height * ratio)), ratio };
}

export function startPdfViewer(pdfjs, document = globalThis.document, window = globalThis.window) {
  const element = id => document.getElementById(id);
  const status = element('status');
  const pageBox = element('page');
  const canvas = element('canvas');
  const text = element('text');
  const pageInput = element('page-number');
  const passwordForm = element('password-form');
  const controls = ['previous', 'next', 'zoom-out', 'fit', 'zoom-in', 'page-number'];
  let pdf;
  let pageNumber = 1;
  let zoom = 1;
  let generation = 0;
  let active;
  let renderQueue = Promise.resolve();
  let heldPage;
  let heldPageNumber;
  let stopped = false;
  let resizeTimer;
  let updatePassword;

  const message = (value, error = false) => {
    status.textContent = value;
    status.setAttribute('role', error ? 'alert' : 'status');
  };
  const updateControls = () => {
    for (const id of controls) element(id).disabled = !pdf || stopped;
    element('previous').disabled ||= pageNumber <= 1;
    element('next').disabled ||= pageNumber >= (pdf?.numPages ?? 1);
    element('zoom-out').disabled ||= zoom <= .25;
    element('zoom-in').disabled ||= zoom >= 4;
    pageInput.value = String(pageNumber);
  };
  const isCurrent = request => !stopped && generation === request;
  const releasePage = () => {
    heldPage?.cleanup();
    heldPage = heldPageNumber = undefined;
  };
  function render() {
    if (!pdf || stopped) return Promise.resolve();
    const request = ++generation;
    const number = pageNumber;
    const requestedZoom = zoom;
    active?.canvas?.cancel();
    active?.text?.cancel();
    updateControls();
    message(`Loading page ${number}…`);
    pageBox.setAttribute('aria-busy', 'true');
    // Serial jobs prevent a stale getPage result from cleaning a PDFPageProxy
    // already reused by a newer request. Obsolete queued jobs do no work.
    renderQueue = renderQueue.catch(() => {}).then(async () => {
      if (!isCurrent(request)) return;
      const job = {};
      const tasks = [];
      active = job;
      let page;
      try {
        if (heldPageNumber !== number) releasePage();
        page = heldPage ?? await pdf.getPage(number);
        if (!isCurrent(request)) return;
        heldPage = page;
        heldPageNumber = number;
        const natural = page.getViewport({ scale: 1 });
        const fit = Math.max(1, element('pages').clientWidth - 24) / natural.width;
        const scale = Math.min(fit * requestedZoom, MAX_DIMENSION / Math.max(natural.width, natural.height));
        const viewport = page.getViewport({ scale });
        const size = canvasSize(viewport.width, viewport.height, window.devicePixelRatio);
        canvas.width = size.width;
        canvas.height = size.height;
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        pageBox.style.width = `${viewport.width}px`;
        pageBox.style.height = `${viewport.height}px`;
        pageBox.style.setProperty('--scale-factor', String(scale));
        pageBox.style.setProperty('--user-unit', String(viewport.userUnit ?? 1));
        pageBox.hidden = false;
        text.replaceChildren();
        text.setAttribute('aria-label', `Page ${number} text`);
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Canvas is unavailable in this browser.');
        job.canvas = page.render({ canvasContext: context, viewport, transform: [size.ratio, 0, 0, size.ratio, 0, 0] });
        tasks.push(job.canvas.promise);
        job.text = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: text, viewport });
        tasks.push(job.text.render());
        await Promise.all(tasks);
        if (!isCurrent(request)) return;
        pageBox.setAttribute('aria-busy', 'false');
        message(`Page ${number} of ${pdf.numPages}`);
      } catch (error) {
        if (!isCurrent(request) || error?.name === 'RenderingCancelledException') return;
        pageBox.hidden = true;
        message(`Unable to display this page: ${error?.message || 'PDF rendering failed.'}`, true);
      } finally {
        // Cancelling a task is asynchronous. Free operator lists/images only
        // after both painting and text extraction have stopped using the page.
        await Promise.allSettled(tasks);
        if (active === job) active = undefined;
        if (page && page !== heldPage) page.cleanup();
        if (!isCurrent(request)) releasePage();
      }
    });
    return renderQueue;
  }

  const asset = path => new URL(`./pdfjs/${path}`, window.location.href).href;
  pdfjs.GlobalWorkerOptions.workerSrc = asset('pdf.worker.mjs');
  const loading = pdfjs.getDocument({
    url: new URL(document.body.dataset.document, window.location.href).href,
    cMapUrl: asset('cmaps/'), cMapPacked: true,
    standardFontDataUrl: asset('standard_fonts/'),
    wasmUrl: asset('wasm/'), iccUrl: asset('iccs/'),
    // No annotation actions, embedded document scripting, or XFA forms.
    enableXfa: false,
  });
  loading.onPassword = (update, reason) => {
    if (stopped) return;
    updatePassword = update;
    passwordForm.hidden = false;
    message(reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD ? 'Incorrect password. Try again.' : 'This PDF needs a password.');
    element('password').focus();
  };
  passwordForm.addEventListener('submit', event => {
    event.preventDefault();
    if (!updatePassword || stopped) return;
    const password = element('password');
    const value = password.value;
    password.value = '';
    passwordForm.hidden = true;
    const update = updatePassword;
    updatePassword = undefined;
    message('Loading PDF…');
    update(value);
  });
  function cancel() {
    if (stopped) return;
    stopped = true;
    ++generation;
    window.clearTimeout(resizeTimer);
    active?.canvas?.cancel();
    active?.text?.cancel();
    void renderQueue.finally(releasePage);
    void loading.destroy().catch(() => {});
    pageBox.hidden = true;
    passwordForm.hidden = true;
    element('password').value = '';
    canvas.width = canvas.height = 1;
    text.replaceChildren();
    updateControls();
    element('cancel').disabled = true;
    message('PDF preview cancelled. Reload to open it again.');
  }
  element('cancel').addEventListener('click', cancel);
  element('previous').addEventListener('click', () => { if (pageNumber > 1) { --pageNumber; void render(); } });
  element('next').addEventListener('click', () => { if (pdf && pageNumber < pdf.numPages) { ++pageNumber; void render(); } });
  pageInput.addEventListener('change', () => {
    const requested = Number(pageInput.value);
    if (pdf && Number.isInteger(requested) && requested >= 1 && requested <= pdf.numPages) pageNumber = requested;
    void render();
  });
  element('zoom-out').addEventListener('click', () => { zoom = Math.max(.25, zoom / 1.25); void render(); });
  element('zoom-in').addEventListener('click', () => { zoom = Math.min(4, zoom * 1.25); void render(); });
  element('fit').addEventListener('click', () => { zoom = 1; void render(); });
  window.addEventListener('resize', () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => { void render(); }, 100);
  });
  window.addEventListener('pagehide', cancel, { once: true });
  updateControls();
  const ready = loading.promise.then(async result => {
    if (stopped) return;
    pdf = result;
    pageInput.max = String(pdf.numPages);
    element('page-count').textContent = `of ${pdf.numPages}`;
    await render();
  }).catch(error => {
    if (!stopped) message(`Unable to open this PDF: ${error?.message || 'Invalid PDF file.'}`, true);
  });
  return { ready, cancel };
}

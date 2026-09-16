import { startPdfViewer } from './controller.mjs';

try {
  startPdfViewer(await import('./pdf.mjs'));
} catch (error) {
  const status = document.getElementById('status');
  status.setAttribute('role', 'alert');
  status.textContent = `Unable to start the PDF viewer: ${error.message || 'Renderer unavailable.'}`;
}

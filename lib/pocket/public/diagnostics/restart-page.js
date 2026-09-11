import { prepareRestart, verifyRestart, clearRestart } from './restart.js';
const status = document.getElementById('restart-status');
const report = document.getElementById('restart-report');
const buttons = [...document.querySelectorAll('[data-restart-action]')];
for (const [id, action] of [
  ['prepare-restart', prepareRestart],
  ['verify-restart', verifyRestart],
  ['clear-restart', clearRestart],
]) {
  document.getElementById(id).onclick = async () => {
    buttons.forEach(button => { button.disabled = true; });
    status.textContent = 'Working...';
    try {
      const data = await action();
      report.value = JSON.stringify(data, null, 2);
      status.textContent = data.status === 'PREPARED'
        ? 'Prepared. Fully close this app, reopen its Home Screen icon, then tap Verify saved key. Do not prepare again.'
        : data.status === 'REMOVED' ? 'Disposable restart checkpoint removed. Pocket data unchanged.'
        : data.status === 'PASS' ? 'PASS: saved key recovered and used in a new page instance. Copy restart result.'
        : `FAIL: ${data.stage}: ${data.error}`;
    } catch (error) { status.textContent = `Could not finish: ${error.message}`; }
    finally { buttons.forEach(button => { button.disabled = false; }); }
  };
}
document.getElementById('reload-restart').onclick = () => location.reload();
document.getElementById('copy-restart').onclick = async () => {
  try { await navigator.clipboard.writeText(report.value); status.textContent = 'Restart result copied.'; }
  catch { report.focus(); report.select(); status.textContent = 'Select and copy the restart report below.'; }
};

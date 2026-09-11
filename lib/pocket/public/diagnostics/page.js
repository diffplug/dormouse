import { HARNESS_VERSION, runCapabilities } from './capabilities.js';
const run = document.getElementById('run');
const copy = document.getElementById('copy');
const download = document.getElementById('download');
const status = document.getElementById('status');
const results = document.getElementById('results');
const report = document.getElementById('report');
status.textContent = `Ready. Harness v${HARNESS_VERSION}. No setup code needed.`;
run.onclick = async () => {
  run.disabled = true;
  copy.disabled = download.disabled = true;
  results.replaceChildren();
  report.value = '';
  status.textContent = 'Running checks. Keep this page open.';
  try {
    const data = await runCapabilities(result => {
      const row = document.createElement('li');
      const title = document.createElement('strong');
      title.textContent = `${result.status}: ${result.label}`;
      row.append(title);
      if (result.error) row.append(document.createTextNode(`${result.stage}: ${result.error}`));
      results.append(row);
      status.textContent = `Completed ${results.children.length} checks...`;
    });
    report.value = JSON.stringify(data, null, 2);
    const failed = data.results.filter(result => result.status === 'FAIL').length;
    status.textContent = `Done: ${data.results.length - failed} passed, ${failed} failed. ${data.cleanupErrors.length ? 'Some test storage could not be removed; see report.' : 'Disposable test storage removed.'}`;
    copy.disabled = download.disabled = false;
  } catch (error) {
    status.textContent = `Harness could not finish: ${error.message}`;
  } finally { run.disabled = false; }
};
copy.onclick = async () => {
  try { await navigator.clipboard.writeText(report.value); status.textContent = 'Results copied. Paste them into the conversation.'; }
  catch {
    document.querySelector('details').open = true;
    report.focus(); report.select();
    status.textContent = 'Select and copy the report below.';
  }
};
download.onclick = () => {
  const url = URL.createObjectURL(new Blob([report.value], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url; link.download = 'pocket-capabilities.json';
  link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};

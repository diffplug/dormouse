// Small real-process fixture for docs/testing/dor-tool-qc.md.
import http from 'node:http';
const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};
const label = option('--label', 'Tool QC');
const count = Number(option('--ports', '1'));
const escape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const dirtyControls = argv.includes('--dirty-controls');
let dirty = false;
const reportDirty = value => {
  dirty = value;
  process.stdout.write(`\x1b]367;state;${JSON.stringify({ v: 1, dirty })}\x1b\\`);
};
const controls = dirtyControls ? '<form method="post" action="/dirty"><button>Report unsaved changes</button></form><form method="post" action="/clean"><button>Report clean</button></form>' : '';
const servers = [];
for (let i = 0; i < count; i++) {
  const server = http.createServer((req, res) => {
    if (dirtyControls && req.method === 'POST' && (req.url === '/dirty' || req.url === '/clean')) reportDirty(req.url === '/dirty');
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(`<html><head><title>${escape(label)}</title></head><body><h1>${escape(label)}</h1><p id="path">${escape(req.url)}</p><pre id="argv">${escape(JSON.stringify(argv))}</pre>${controls}<input aria-label="Retained text" placeholder="Type to check browser state"></body></html>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
}
const ports = servers.map(server => server.address().port);
const announce = () => process.stdout.write(`\x1b]367;serve;${JSON.stringify({ v: 1, port: ports[0], path: option('--path', '/qc'), name: label })}\x1b\\`);
console.log(JSON.stringify({ event: 'qc-start', pid: process.pid, ports, argv }));
if (argv.includes('--announce')) announce();
process.on('SIGUSR1', announce);
if (dirtyControls) process.on('SIGUSR2', () => reportDirty(!dirty));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  for (const server of servers) server.close();
  process.exit(0);
});

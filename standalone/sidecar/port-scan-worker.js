// Port enumeration may block for seconds. This worker never owns PTY I/O.
const { parentPort, workerData } = require('node:worker_threads');
const { getOpenPortsForPids } = require('./pty-core');

parentPort.postMessage(getOpenPortsForPids(workerData));

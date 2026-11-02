/**
 * The Client window's end of a frame origin: what its bootstrap page relays,
 * answered through one {@link OpenFrame}. Everything arriving here may have
 * been written by the framed page itself (`bootstrap.ts`), so it can ask for
 * only what the page could fetch anyway: a request on that frame's own grant,
 * which the Burrow validates.
 */

import { createSerialQueue } from '../../host/remote/serial-queue';
import { messageOf } from '../../lib/errors';
import type { OpenFrame, OpenFrameSocket } from '../client/frame-client';
import { WORKER_SILENCE_LIMIT_MS, type RelayMessage, type RelayRequest, type RelaySocket, type ResponseControl, type ResponseMessage, type SocketCommand, type SocketEvent } from './protocol';

/** Serve `frame` to whatever arrives on `port`. Returns the stop. */
export function serveFrame(frame: OpenFrame, port: MessagePort): () => void {
  port.onmessage = (event: MessageEvent<RelayMessage>) => {
    const reply = event.ports[0];
    const message = event.data;
    if (!reply || typeof message !== 'object' || message === null) return;
    if (message.kind === 'request') void serveRequest(frame, message, reply);
    else if (message.kind === 'socket') void serveSocket(frame, message, reply);
  };
  return () => {
    port.onmessage = null;
    port.close();
  };
}

async function serveRequest(frame: OpenFrame, request: RelayRequest, reply: MessagePort): Promise<void> {
  const send = (message: ResponseMessage, transfer: Transferable[] = []) => reply.postMessage(message, transfer);
  const abandoned = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let silence: ReturnType<typeof setTimeout> | undefined;
  const finish = () => {
    clearTimeout(silence);
    reply.close();
  };
  const abandon = () => {
    abandoned.abort();
    void reader?.cancel();
    finish();
  };
  const heard = () => {
    clearTimeout(silence);
    silence = setTimeout(abandon, WORKER_SILENCE_LIMIT_MS);
  };
  // From the start: a worker that gave up on the head must stop a request still
  // waiting its turn, or a write it answered 504 for runs anyway.
  reply.onmessage = (event: MessageEvent<ResponseControl>) => {
    if (event.data.kind === 'cancel') {
      abandon();
      return;
    }
    heard();
    if (event.data.kind !== 'pull' || !reader) return;
    reader.read().then(
      ({ done, value }) => {
        if (done) {
          send({ kind: 'end' });
          finish();
        } else {
          const bytes = ownBuffer(value);
          send({ kind: 'chunk', bytes }, [bytes.buffer]);
        }
      },
      (error: unknown) => {
        send({ kind: 'error', message: messageOf(error) });
        finish();
      },
    );
  };
  try {
    const response = await frame.request({
      method: request.method,
      path: request.path,
      headers: request.headers,
      destination: request.destination,
      signal: abandoned.signal,
      ...(request.body ? { body: new Uint8Array(request.body) } : {}),
    });
    if (abandoned.signal.aborted) {
      void response.body.cancel();
      return;
    }
    send({ kind: 'head', status: response.status, statusText: response.statusText, headers: response.headers });
    reader = response.body.getReader();
    heard();
  } catch (error) {
    if (abandoned.signal.aborted) return;
    send({ kind: 'error', message: messageOf(error) });
    finish();
  }
}

async function serveSocket(frame: OpenFrame, request: RelaySocket, reply: MessagePort): Promise<void> {
  const send = (message: SocketEvent, transfer: Transferable[] = []) => reply.postMessage(message, transfer);
  let socket: OpenFrameSocket;
  try {
    socket = await frame.openSocket(request.path, request.protocols, {
      onMessage: (data, binary) => {
        const buffer = ownBuffer(data).buffer as ArrayBuffer;
        send({ kind: 'message', data: buffer, binary }, [buffer]);
      },
      onClose: (code, reason) => {
        send({ kind: 'closed', code, reason });
        reply.close();
      },
    });
  } catch (error) {
    send({ kind: 'closed', code: 1006, reason: messageOf(error) });
    reply.close();
    return;
  }
  // In order, or what follows a Blob overtakes it while it is read.
  const inOrder = createSerialQueue();
  reply.onmessage = (event: MessageEvent<SocketCommand>) => {
    const command = event.data;
    void inOrder(async () => {
      if (command.kind === 'send') {
        const data = command.data instanceof Blob ? await command.data.arrayBuffer() : command.data;
        void socket.send(new Uint8Array(data), command.binary).catch(() => {});
      } else if (command.kind === 'close') {
        socket.close(command.code, command.reason);
      }
    }).catch(() => {});
  };
  send({ kind: 'open', protocol: socket.protocol, extensions: socket.extensions });
}

/** `bytes` on a buffer of its own, which a transfer can take: copied only if it is a view on a larger one. */
function ownBuffer(bytes: Uint8Array): Uint8Array {
  return bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice();
}

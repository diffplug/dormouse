/**
 * The Client window's end of a frame origin: what its bootstrap page relays,
 * answered through one {@link OpenFrame}. Everything arriving here may have
 * been written by the framed page itself (`bootstrap.ts`), so it can ask for
 * only what the page could fetch anyway: a request on that frame's own grant,
 * which the Burrow validates.
 */

import type { OpenFrame, OpenFrameSocket } from '../client/frame-client';
import type { RelayMessage, RelayRequest, RelaySocket, ResponseControl, ResponseMessage, SocketCommand, SocketEvent } from './protocol';

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
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    const response = await frame.request({
      method: request.method,
      path: request.path,
      headers: request.headers,
      destination: request.destination,
      ...(request.body ? { body: new Uint8Array(request.body) } : {}),
    });
    send({ kind: 'head', status: response.status, statusText: response.statusText, headers: response.headers });
    reader = response.body.getReader();
  } catch (error) {
    send({ kind: 'error', message: messageOf(error) });
    reply.close();
    return;
  }
  reply.onmessage = (event: MessageEvent<ResponseControl>) => {
    if (event.data.kind === 'cancel') {
      void reader.cancel();
      reply.close();
      return;
    }
    reader.read().then(
      ({ done, value }) => {
        if (done) {
          send({ kind: 'end' });
          reply.close();
        } else {
          const bytes = ownBuffer(value);
          send({ kind: 'chunk', bytes }, [bytes.buffer]);
        }
      },
      (error: unknown) => {
        send({ kind: 'error', message: messageOf(error) });
        reply.close();
      },
    );
  };
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
  reply.onmessage = (event: MessageEvent<SocketCommand>) => {
    const command = event.data;
    if (command.kind === 'send') void socket.send(new Uint8Array(command.data), command.binary).catch(() => {});
    else if (command.kind === 'close') socket.close(command.code, command.reason);
  };
  send({ kind: 'open', protocol: socket.protocol, extensions: socket.extensions });
}

/** `bytes` on a buffer of its own, which a transfer can take: copied only if it is a view on a larger one. */
function ownBuffer(bytes: Uint8Array): Uint8Array {
  return bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice();
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'the request failed';
}

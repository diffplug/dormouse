import { randomBytes } from "node:crypto";
import { connect, type Socket } from "node:net";

export type Closed = { code: number; reason: string };

const TEXT = 0x1;
const BINARY = 0x2;
const CLOSE = 0x8;

/**
 * A WebSocket upgrade over a bare TCP socket to a Miniflare instance, as a
 * request for `url` (Miniflare's `MF-Original-URL`, which `dispatchFetch`
 * sets too). A 101 comes back as a {@link RawSocket}; anything else as its
 * status and headers.
 *
 * Bare, because a WHATWG or `ws` socket fires `close` only once the server
 * drops TCP, and for a hibernatable socket the room closes from another
 * socket's event workerd drops it only when the Durable Object goes idle, about
 * ten seconds on. The room's contract is the close frame, which this reports
 * the moment it arrives.
 */
export function rawUpgrade(
  server: URL,
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; headers: Headers; socket?: RawSocket }> {
  return new Promise((resolve, reject) => {
    const tcp = connect(Number(server.port), server.hostname);
    const target = new URL(url);
    const request = {
      host: server.host,
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-version": "13",
      "sec-websocket-key": randomBytes(16).toString("base64"),
      "mf-original-url": url,
      ...headers,
    };
    tcp.write(
      `GET ${target.pathname}${target.search} HTTP/1.1\r\n` +
        Object.entries(request)
          .map(([name, value]) => `${name}: ${value}\r\n`)
          .join("") +
        "\r\n",
    );
    let buffer: Buffer = Buffer.alloc(0);
    let socket: RawSocket | undefined;
    tcp.on("error", reject);
    tcp.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!socket) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        const [statusLine, ...lines] = buffer
          .subarray(0, end)
          .toString()
          .split("\r\n");
        const status = Number(statusLine.split(" ")[1]);
        const responseHeaders = new Headers(
          lines.map((line) => {
            const colon = line.indexOf(":");
            return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
          }),
        );
        buffer = buffer.subarray(end + 4);
        if (status !== 101) {
          tcp.destroy();
          resolve({ status, headers: responseHeaders });
          return;
        }
        socket = new RawSocket(tcp);
        resolve({ status, headers: responseHeaders, socket });
      }
      buffer = socket.read(buffer);
    });
  });
}

export class RawSocket {
  readonly received: (string | Buffer)[] = [];
  readonly closed: Promise<Closed>;
  #closedWith: Closed | undefined;
  #onClose!: (closed: Closed) => void;
  #waiting: ((data: string | Buffer) => void)[] = [];
  #sentClose = false;

  constructor(readonly tcp: Socket) {
    this.closed = new Promise((resolve) => (this.#onClose = resolve));
  }

  /** The room's close frame so far, without waiting. */
  closedWith() {
    return this.#closedWith;
  }

  next(): Promise<string | Buffer> {
    const data = this.received.shift();
    return data !== undefined
      ? Promise.resolve(data)
      : new Promise((resolve) => this.#waiting.push(resolve));
  }

  send(data: string | Uint8Array) {
    this.tcp.write(
      typeof data === "string"
        ? frame(TEXT, Buffer.from(data))
        : frame(BINARY, Buffer.from(data)),
    );
  }

  /** Start the closing handshake; the room's answer resolves {@link closed}. */
  close(code = 1000) {
    this.#sendClose(code);
  }

  #sendClose(code: number) {
    if (this.#sentClose) return;
    this.#sentClose = true;
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code);
    this.tcp.write(frame(CLOSE, payload));
  }

  /** Consume every whole server frame in `buffer`; returns the remainder. */
  read(buffer: Buffer): Buffer {
    while (buffer.length >= 2) {
      if (!(buffer[0] & 0x80)) throw new Error("Fragmented frames are not expected");
      const opcode = buffer[0] & 0x0f;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) break;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) break;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (buffer.length < offset + length) break;
      const payload = Buffer.from(buffer.subarray(offset, offset + length));
      buffer = buffer.subarray(offset + length);
      if (opcode === CLOSE) {
        const closed = {
          code: payload.length >= 2 ? payload.readUInt16BE(0) : 1005,
          reason: payload.subarray(2).toString(),
        };
        this.#closedWith = closed;
        this.#sendClose(closed.code);
        this.tcp.destroy();
        this.#onClose(closed);
        return Buffer.alloc(0);
      }
      const data = opcode === TEXT ? payload.toString() : payload;
      const waiter = this.#waiting.shift();
      if (waiter) waiter(data);
      else this.received.push(data);
    }
    return buffer;
  }
}

/** One masked client frame. */
function frame(opcode: number, payload: Buffer) {
  const mask = randomBytes(4);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
  } else if (payload.length < 0x10000) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, mask, masked]);
}

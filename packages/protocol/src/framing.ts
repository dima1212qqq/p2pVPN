import { EventEmitter } from "node:events";
import type { Duplex } from "node:stream";

import type { ErrorMessage, ProtocolMessage } from "./messages.js";

const FRAME_KIND_MESSAGE = 1;
const FRAME_KIND_PACKET = 2;

function normalizeChunk(chunk: Buffer | string | Uint8Array): Buffer {
  if (Buffer.isBuffer(chunk)) {
    return chunk;
  }

  if (typeof chunk === "string") {
    return Buffer.from(chunk);
  }

  return Buffer.from(chunk);
}

export class ProtocolSocket extends EventEmitter<{
  message: [ProtocolMessage];
  packet: [Buffer];
  close: [];
  error: [Error];
}> {
  private readonly stream: Duplex;
  private buffer = Buffer.alloc(0);

  public constructor(stream: Duplex) {
    super();
    this.stream = stream;
    this.stream.on("data", (chunk: Buffer | string | Uint8Array) => this.onData(chunk));
    this.stream.on("error", (error: Error) => this.emit("error", error));
    this.stream.on("close", () => this.emit("close"));
    this.stream.on("end", () => this.emit("close"));
  }

  public sendMessage(message: ProtocolMessage): void {
    const payload = Buffer.from(JSON.stringify(message), "utf8");
    const header = Buffer.allocUnsafe(5);
    header.writeUInt8(FRAME_KIND_MESSAGE, 0);
    header.writeUInt32BE(payload.byteLength, 1);
    this.stream.write(Buffer.concat([header, payload]));
  }

  public sendPacket(packet: Uint8Array): void {
    const payload = Buffer.from(packet);
    const header = Buffer.allocUnsafe(5);
    header.writeUInt8(FRAME_KIND_PACKET, 0);
    header.writeUInt32BE(payload.byteLength, 1);
    this.stream.write(Buffer.concat([header, payload]));
  }

  public close(): void {
    this.stream.end();
  }

  private onData(chunk: Buffer | string | Uint8Array): void {
    this.buffer = Buffer.concat([this.buffer, normalizeChunk(chunk)]);

    while (this.buffer.byteLength >= 5) {
      const frameKind = this.buffer.readUInt8(0);
      const frameLength = this.buffer.readUInt32BE(1);
      const totalLength = 5 + frameLength;

      if (this.buffer.byteLength < totalLength) {
        return;
      }

      const payload = this.buffer.subarray(5, totalLength);
      this.buffer = this.buffer.subarray(totalLength);

      if (frameKind === FRAME_KIND_MESSAGE) {
        try {
          const parsed = JSON.parse(payload.toString("utf8")) as ProtocolMessage;
          this.emit("message", parsed);
        } catch (error) {
          this.emit("error", error instanceof Error ? error : new Error("Failed to parse control frame"));
        }
        continue;
      }

      if (frameKind === FRAME_KIND_PACKET) {
        this.emit("packet", Buffer.from(payload));
        continue;
      }

      this.emit("error", new Error(`Unknown frame kind '${frameKind}'`));
    }
  }
}

export function waitForMessage<TMessage extends ProtocolMessage>(
  socket: ProtocolSocket,
  matcher: (message: ProtocolMessage) => message is TMessage,
  timeoutMs: number
): Promise<TMessage> {
  return new Promise<TMessage>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out after ${timeoutMs}ms while waiting for protocol message`));
    }, timeoutMs);

    const onMessage = (message: ProtocolMessage) => {
      if (!matcher(message)) {
        return;
      }

      cleanup();
      resolve(message);
    };

    const onClose = () => {
      cleanup();
      reject(new Error("Connection closed while waiting for protocol message"));
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const cleanup = () => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("close", onClose);
      socket.off("error", onError);
    };

    socket.on("message", onMessage);
    socket.on("close", onClose);
    socket.on("error", onError);
  });
}

export function waitForMessageOrThrowRemoteError<TMessage extends ProtocolMessage>(
  socket: ProtocolSocket,
  matcher: (message: ProtocolMessage) => message is TMessage,
  timeoutMs: number
): Promise<TMessage> {
  return new Promise<TMessage>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out after ${timeoutMs}ms while waiting for protocol message`));
    }, timeoutMs);

    const onMessage = (message: ProtocolMessage) => {
      if (message.type === "ERROR") {
        const remoteError = message as ErrorMessage;
        cleanup();
        reject(new Error(`Remote error ${remoteError.code}: ${remoteError.message}`));
        return;
      }

      if (!matcher(message)) {
        return;
      }

      cleanup();
      resolve(message);
    };

    const onClose = () => {
      cleanup();
      reject(new Error("Connection closed while waiting for protocol message"));
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const cleanup = () => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("close", onClose);
      socket.off("error", onError);
    };

    socket.on("message", onMessage);
    socket.on("close", onClose);
    socket.on("error", onError);
  });
}

export function isIgnorableStreamError(error: Error): boolean {
  const message = error.message.toLowerCase();
  return message.includes("connection reset by peer") || message.includes("stream was destroyed");
}

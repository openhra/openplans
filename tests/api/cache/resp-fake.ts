import { createServer } from "node:net";
import type { Socket } from "node:net";

/**
 * In-process RESP test double: GET and SET key value EX seconds only, with its own clock.
 * The repository has no Valkey or Redis binary; this fake stands in for one in tests.
 */
export async function fakeResp() {
  const entries = new Map<string, { value: Buffer; expires: number }>();
  const sockets = new Set<Socket>();
  let now = 0;
  const reply = (args: Buffer[]): string | Buffer => {
    const command = args[0]?.toString().toUpperCase();
    if (command === "GET" && args.length === 2) {
      const entry = entries.get(args[1]!.toString());
      if (!entry || entry.expires <= now) return "$-1\r\n";
      return Buffer.concat([
        Buffer.from(`$${entry.value.length}\r\n`),
        entry.value,
        Buffer.from("\r\n"),
      ]);
    }
    if (
      command === "SET" &&
      args.length === 5 &&
      args[3]!.toString().toUpperCase() === "EX"
    ) {
      const seconds = Number(args[4]!.toString());
      if (!Number.isSafeInteger(seconds) || seconds <= 0)
        return "-ERR invalid expire time\r\n";
      entries.set(args[1]!.toString(), {
        value: args[2]!,
        expires: now + seconds * 1000,
      });
      return "+OK\r\n";
    }
    return "-ERR unsupported\r\n";
  };
  /** Parses one complete `*n` array of bulk strings, or returns undefined when more bytes are needed. */
  const parse = (
    buffer: Buffer,
  ): { args: Buffer[]; used: number } | undefined => {
    let offset = 0;
    const line = () => {
      const end = buffer.indexOf("\r\n", offset);
      if (end < 0) return undefined;
      const text = buffer.toString("ascii", offset, end);
      offset = end + 2;
      return text;
    };
    const header = line();
    if (header === undefined) return undefined;
    if (!header.startsWith("*")) throw new Error("Not a RESP array");
    const args: Buffer[] = [];
    for (let i = 0; i < Number(header.slice(1)); i++) {
      const size = line();
      if (size === undefined) return undefined;
      const length = Number(size.slice(1));
      if (buffer.length < offset + length + 2) return undefined;
      args.push(buffer.subarray(offset, offset + length));
      offset += length + 2;
    }
    return { args, used: offset };
  };
  const tcp = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let pending: Buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      try {
        for (let parsed = parse(pending); parsed; parsed = parse(pending)) {
          pending = pending.subarray(parsed.used);
          socket.write(reply(parsed.args));
        }
      } catch {
        socket.destroy();
      }
    });
  });
  await new Promise<void>((resolve) => tcp.listen(0, "127.0.0.1", resolve));
  const address = tcp.address();
  if (!address || typeof address === "string") throw new Error("No listener");
  let closed = false;
  const close = () =>
    new Promise<void>((resolve) => {
      if (closed) return resolve();
      closed = true;
      for (const socket of sockets) socket.destroy();
      tcp.close(() => resolve());
    });
  return {
    url: `redis://127.0.0.1:${address.port}`,
    entries,
    advance: (seconds: number) => {
      now += seconds * 1000;
    },
    close,
  };
}

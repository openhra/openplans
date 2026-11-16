import type { IncomingHttpHeaders } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request as httpsRequest } from "node:https";
import { once } from "node:events";
import { getRequestListener } from "@hono/node-server";
import { expect, it } from "vitest";
import { csrf, fixture, TOKEN } from "./helpers.js";

it("runs login, no-JS navigation, reauth, logout, expiry and revocation over disposable loopback HTTPS", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openplans-admin-https-"));
  const keyPath = join(directory, "key.pem"),
    certPath = join(directory, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
    ],
    { stdio: "ignore" },
  );
  const server = createServer({
    key: await readFile(keyPath),
    cert: await readFile(certPath),
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing test listener");
    const origin = `https://localhost:${address.port}`;
    const f = fixture({ origin });
    server.on("request", getRequestListener(f.app.fetch));
    const send = (
      path: string,
      cookies = "",
      fields?: Record<string, string>,
    ) =>
      new Promise<{
        status: number;
        headers: IncomingHttpHeaders;
        body: string;
      }>((resolve, reject) => {
        const body = fields
          ? new URLSearchParams(fields).toString()
          : undefined;
        const req = httpsRequest(
          {
            hostname: "127.0.0.1",
            port: address.port,
            path,
            method: body ? "POST" : "GET",
            rejectUnauthorized: false,
            headers: {
              host: `localhost:${address.port}`,
              cookie: cookies,
              ...(body
                ? {
                    origin,
                    "content-type": "application/x-www-form-urlencoded",
                    "content-length": Buffer.byteLength(body),
                  }
                : {}),
            },
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.on("end", () =>
              resolve({
                status: response.statusCode!,
                headers: response.headers,
                body: Buffer.concat(chunks).toString(),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end(body);
      });
    const signIn = async () => {
      const page = await send("/admin/login");
      expect(page.status).toBe(200);
      const r = await send(
        "/admin/login",
        page.headers["set-cookie"]![0]!.split(";")[0],
        { csrf: csrf(page.body), credential: TOKEN },
      );
      expect(r.status).toBe(303);
      return r.headers["set-cookie"]!.find((c) =>
        c.startsWith("__Secure-openplans_admin="),
      )!.split(";")[0]!;
    };
    let cookie = await signIn();
    expect((await send("/admin", cookie)).status).toBe(200);
    const reauth = await send("/admin/reauth", cookie);
    const renewed = await send("/admin/reauth", cookie, {
      csrf: csrf(reauth.body),
      credential: TOKEN,
    });
    expect(renewed.status).toBe(303);
    const old = cookie;
    cookie = renewed.headers["set-cookie"]![0]!.split(";")[0]!;
    expect(cookie).not.toBe(old);
    expect((await send("/admin", old)).status).toBe(303);
    const page = await send("/admin", cookie);
    expect(
      (await send("/admin/logout", cookie, { csrf: csrf(page.body) })).status,
    ).toBe(303);
    expect((await send("/admin", cookie)).status).toBe(303);
    cookie = await signIn();
    f.advance(30 * 60_000);
    expect((await send("/admin", cookie)).status).toBe(303);
    cookie = await signIn();
    f.credential();
    expect((await send("/admin", cookie)).status).toBe(404);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});

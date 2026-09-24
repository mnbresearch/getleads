import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { fetchText, fetchWithTimeout, readCapped } from "./http.js";

/**
 * Real sockets, not a mocked fetch.
 *
 * The defect here was that the timeout stopped applying once the response HEADERS arrived,
 * so a server answering "200 OK" and then going quiet held the caller open forever. Only a
 * server that actually behaves that way can prove the fix; a stubbed fetch resolves with a
 * body already in hand and never reaches the failure.
 */
let server: Server | null = null;

async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  server = createServer(handler);
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const addr = server!.address();
  if (typeof addr === "string" || !addr) throw new Error("no address");
  return `http://127.0.0.1:${addr.port}`;
}

afterEach(async () => {
  if (server) {
    await new Promise<void>((r) => server!.close(() => r()));
    server.closeAllConnections?.();
    server = null;
  }
});

describe("the fetch deadline covers the body, not just the headers", () => {
  it("aborts a response that sends headers and then stalls", async () => {
    const url = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.write("<html>starting");
      // and then nothing, ever.
    });

    const started = Date.now();
    const body = await fetchText(url, { timeoutMs: 300 });
    const took = Date.now() - started;

    // fetchText swallows the abort and returns null, which is correct for a page fetch:
    // the point is that it RETURNS.
    expect(body).toBeNull();
    expect(took).toBeLessThan(3000);
  });

  it("still returns a normal body well inside the deadline", async () => {
    const url = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html>done</html>");
    });
    expect(await fetchText(url, { timeoutMs: 5000 })).toBe("<html>done</html>");
  });

  it("stops pulling once the byte cap is reached instead of buffering the whole body", async () => {
    let sent = 0;
    const chunk = "x".repeat(64 * 1024);
    const url = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      // A body that never ends. Reading it in full is the bug; the cap must end the read.
      const pump = () => {
        while (res.write(chunk)) {
          sent += chunk.length;
          if (sent > 8 * 1024 * 1024) return;
        }
        res.once("drain", pump);
      };
      pump();
    });

    const text = await fetchText(url, { timeoutMs: 5000, maxBytes: 1000 });
    expect(text).toHaveLength(1000);
  });

  it("readCapped returns the whole body when it is under the cap", async () => {
    const url = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("hello");
    });
    const res = await fetchWithTimeout(url, { timeoutMs: 5000 });
    const bytes = await readCapped(res, 1_000_000);
    expect(new TextDecoder().decode(bytes)).toBe("hello");
  });
});

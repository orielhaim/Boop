const blobs = new Map<string, ArrayBuffer>();
let gets = 0;
let puts = 0;
let pause: ReturnType<typeof Promise.withResolvers<void>> | undefined;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 30,
  async fetch(request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/_fixture/stats")
      return Response.json({ gets, puts });
    if (url.pathname === "/_fixture/pause" && request.method === "POST") {
      pause ??= Promise.withResolvers<void>();
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/_fixture/resume" && request.method === "POST") {
      pause?.resolve();
      pause = undefined;
      return new Response(null, { status: 204 });
    }
    if (request.method === "PUT" && url.pathname === "/upload") {
      if (!request.headers.get("Authorization")?.startsWith("Nostr "))
        return new Response(null, { status: 401 });
      const size = Number(request.headers.get("Content-Length"));
      if (!Number.isInteger(size) || size < 1 || size > 2 * 1024 * 1024)
        return new Response(null, { status: 413 });
      const bytes = await request.arrayBuffer();
      const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
      if (
        bytes.byteLength !== size ||
        request.headers.get("X-SHA-256") !== hash
      )
        return new Response(null, { status: 400 });
      puts++;
      blobs.set(hash, bytes);
      return Response.json({
        url: new URL(hash, server.url).href,
        sha256: hash,
        size,
        type: "application/octet-stream",
        uploaded: Math.floor(Date.now() / 1000),
      });
    }
    const hash = /^\/([a-f0-9]{64})(?:\.[a-z0-9]+)?$/.exec(url.pathname)?.[1];
    const blob = hash ? blobs.get(hash) : undefined;
    if (!blob) return new Response(null, { status: 404 });
    if (request.method === "HEAD")
      return new Response(null, {
        headers: { "Content-Length": String(blob.byteLength) },
      });
    if (request.method !== "GET") return new Response(null, { status: 405 });
    gets++;
    await pause?.promise;
    return new Response(blob, {
      headers: { "Content-Type": "application/octet-stream" },
    });
  },
});

console.log(server.url.origin);

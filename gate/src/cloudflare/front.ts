/** Access-protected reader edge. Transport credentials never confer document access. */
export interface FrontEnv {
  PUBLIC_ORIGIN: string;
  BACKEND_ORIGIN: string;
  BRIDGE_CLIENT_ID: string;
  BRIDGE_CLIENT_SECRET: string;
}

const fail = (status: number) =>
  Response.json(
    { error: status },
    { status, headers: { "Cache-Control": "no-store" } },
  );
function origin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.origin !== value ||
    url.username ||
    url.password
  )
    throw new Error("Invalid origin");
  return value;
}

export default {
  async fetch(request: Request, env: FrontEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.headers.has("origin") || request.headers.has("mcp-session-id"))
      return fail(403);
    try {
      if (
        url.origin !== origin(env.PUBLIC_ORIGIN) ||
        origin(env.BACKEND_ORIGIN) === env.PUBLIC_ORIGIN
      )
        return fail(404);
    } catch {
      return fail(503);
    }
    if (url.search || !["/mcp", "/identity"].includes(url.pathname))
      return fail(404);
    if (
      (url.pathname === "/mcp" && request.method !== "POST") ||
      (url.pathname === "/identity" && request.method !== "GET")
    )
      return fail(405);
    const assertion = request.headers.get("cf-access-jwt-assertion");
    if (!assertion || assertion.length > 16384) return fail(401);
    if (
      request.method === "POST" &&
      request.headers.get("content-type")?.split(";")[0]?.trim() !==
        "application/json"
    )
      return fail(415);
    if (!env.BRIDGE_CLIENT_ID || !env.BRIDGE_CLIENT_SECRET) return fail(503);
    const headers = new Headers({
      "CF-Access-Client-Id": env.BRIDGE_CLIENT_ID,
      "CF-Access-Client-Secret": env.BRIDGE_CLIENT_SECRET,
      "X-Wiki-Rag-Reader-Assertion": assertion,
    });
    for (const key of ["content-type", "accept", "mcp-protocol-version"]) {
      const value = request.headers.get(key);
      if (value) headers.set(key, value);
    }
    try {
      const upstream = await fetch(
        new Request(env.BACKEND_ORIGIN + url.pathname, {
          method: request.method,
          headers,
          body: request.body,
          redirect: "manual",
          signal: AbortSignal.any([
            request.signal,
            AbortSignal.timeout(120000),
          ]),
          // Node's test runtime requires duplex for streamed request bodies; Workers ignores it.
          ...(request.body ? { duplex: "half" } : {}),
        }),
      );
      if (upstream.status >= 300 && upstream.status < 400) return fail(502);
      const responseHeaders = new Headers({ "Cache-Control": "no-store" });
      for (const key of ["content-type", "retry-after", "allow"]) {
        const value = upstream.headers.get(key);
        if (value) responseHeaders.set(key, value);
      }
      return new Response(upstream.body, {
        status: upstream.status,
        headers: responseHeaders,
      });
    } catch {
      return fail(502);
    }
  },
};

import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { AccessVerifier } from "../../src/cloudflare/access.js";
const issuer = "https://example.cloudflareaccess.com";
const keys = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(keys.publicKey)), kid: "one", alg: "RS256" };
const now = Math.floor(Date.now() / 1000);
const claims = {
  iss: issuer,
  aud: ["audience"],
  sub: "human",
  type: "app",
  iat: now,
  exp: now + 600,
};
async function token(extra = {}, kid = "one") {
  return new SignJWT({ ...claims, ...extra })
    .setProtectedHeader({ alg: "RS256", kid })
    .sign(keys.privateKey);
}
test("cryptographic Access assertions, typed identities and strict claims", async () => {
  assert.ok(AccessVerifier, "Access verifier is implemented");
  const verifier = new AccessVerifier(issuer, "audience", async () =>
    Response.json({ keys: [jwk] }),
  );
  assert.equal((await verifier.verify(await token())).key, "user:human");
  assert.equal(
    (
      await verifier.verify(
        await token({ sub: "", common_name: "abc123.access" }),
      )
    ).key,
    "service:abc123.access",
  );
  for (const extra of [
    { iss: "https://evil.cloudflareaccess.com" },
    { aud: ["other"] },
    { type: "org" },
    { exp: now - 1 },
    { iat: "now" },
    { iat: now + 100 },
    { nbf: now + 100 },
    { sub: "" },
    { sub: "", common_name: "bad value" },
    { exp: null },
  ]) {
    await assert.rejects(verifier.verify(await token(extra)));
  }
  await assert.rejects(verifier.verify(""));
  const signed = await token();
  await assert.rejects(verifier.verify(signed.slice(0, -10) + "aaaaaaaaaa"));
  await assert.rejects(verifier.verify(await token({}, "unknown")));
});
test("JWKS bounded caching, concurrency and failure handling", async () => {
  assert.ok(AccessVerifier, "Access verifier is implemented");
  let calls = 0;
  const verifier = new AccessVerifier(issuer, "audience", async () => {
    calls++;
    return Response.json({ keys: [jwk] });
  });
  await Promise.all(
    Array.from({ length: 8 }, async () => verifier.verify(await token())),
  );
  assert.equal(calls, 1);
  for (let i = 0; i < 3; i++)
    await assert.rejects(verifier.verify(await token({}, "unknown")));
  assert.equal(calls, 1);
  for (const response of [
    new Response("x".repeat(65537)),
    Response.json({ keys: [] }),
    new Response("", { status: 503 }),
    Response.json({ keys: Array(33).fill(jwk) }),
  ]) {
    const bad = new AccessVerifier(issuer, "audience", async () => response);
    await assert.rejects(bad.verify(await token()));
  }
  assert.throws(() => new AccessVerifier("https://evil.example", "audience"));
  assert.throws(() => new AccessVerifier(issuer, ""));
});
test("bounded unknown-kid refresh accepts rotation after cooldown and ignores token URLs", async () => {
  assert.ok(AccessVerifier);
  let clock = Date.now(),
    calls = 0;
  const rotated = await generateKeyPair("RS256");
  const publicKey = {
    ...(await exportJWK(rotated.publicKey)),
    kid: "two",
    alg: "RS256",
  };
  const verifier = new AccessVerifier(
    issuer,
    "audience",
    async (input) => {
      assert.equal(input, issuer + "/cdn-cgi/access/certs");
      calls++;
      return Response.json({ keys: calls === 1 ? [jwk] : [jwk, publicKey] });
    },
    () => clock,
  );
  await verifier.verify(await token());
  clock += 31000;
  const signed = await new SignJWT(claims)
    .setProtectedHeader({
      alg: "RS256",
      kid: "two",
      jku: "https://evil.example/certs",
    })
    .sign(rotated.privateKey);
  assert.equal((await verifier.verify(signed)).key, "user:human");
  assert.equal(calls, 2);
});
test("stalled JWKS body is canceled by the deadline and validation recovers", async () => {
  let clock = Date.now(),
    first = true,
    controller: ReadableStreamDefaultController<Uint8Array> | undefined,
    canceled = false;
  const verifier = new AccessVerifier(
    issuer,
    "audience",
    async () => {
      if (!first) return Response.json({ keys: [jwk] });
      first = false;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            controller = c;
            c.enqueue(new TextEncoder().encode("{"));
          },
          cancel() {
            canceled = true;
          },
        }),
      );
    },
    () => clock,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      verifier.verify(await token()).then(
        () => "accepted",
        () => "rejected",
      ),
      new Promise<string>((r) => {
        timer = setTimeout(() => r("stalled"), 4000);
      }),
    ]);
    assert.equal(result, "rejected");
    assert.equal(canceled, true);
    clock += 31000;
    assert.equal((await verifier.verify(await token())).key, "user:human");
  } finally {
    clearTimeout(timer);
    try {
      controller?.error(Error("test cleanup"));
    } catch {}
  }
});

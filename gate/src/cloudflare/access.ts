import {
  createLocalJWKSet,
  decodeProtectedHeader,
  jwtVerify,
  type JSONWebKeySet,
} from "jose";
import { GateError } from "../errors.js";
export interface Identity {
  issuer: string;
  key: string;
  expiresAt: number;
}
export function validIdentityKey(key: string): boolean {
  return (
    /^user:[A-Za-z0-9_-]{1,256}$/.test(key) ||
    /^service:[A-Za-z0-9_-]{1,256}\.access$/.test(key)
  );
}
const fail = (): never => {
  throw new GateError("UNAUTHENTICATED");
};
export class AccessVerifier {
  private keys: ReturnType<typeof createLocalJWKSet> | undefined;
  private loadedAt = 0;
  private attemptedAt = -Infinity;
  private loading: Promise<void> | undefined;
  private active = 0;
  constructor(
    readonly issuer: string,
    readonly audience: string,
    private readonly transport: typeof fetch = (input, init) =>
      fetch(input, init),
    private readonly now: () => number = Date.now,
  ) {
    if (
      !/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/.test(
        issuer,
      ) ||
      !audience ||
      audience.length > 256 ||
      /\s/.test(audience)
    )
      fail();
  }
  private async refresh(): Promise<void> {
    if (this.loading) return this.loading;
    if (this.now() - this.attemptedAt < 30000) fail();
    this.attemptedAt = this.now();
    this.loading = (async () => {
      const deadline = AbortSignal.timeout(3000);
      const response = await this.transport(
        this.issuer + "/cdn-cgi/access/certs",
        { redirect: "manual", signal: deadline },
      );
      if (!response.ok || response.redirected || !response.body) {
        await response.body?.cancel();
        fail();
      }
      const reader = response.body!.getReader();
      let size = 0;
      const chunks: Uint8Array[] = [];
      const cancel = () => {
        void reader.cancel().catch(() => {});
      };
      deadline.addEventListener("abort", cancel, { once: true });
      try {
        while (true) {
          if (deadline.aborted) fail();
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 65536) fail();
          chunks.push(value);
        }
        if (deadline.aborted) fail();
      } finally {
        deadline.removeEventListener("abort", cancel);
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const jwks = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      ) as JSONWebKeySet;
      if (
        !Array.isArray(jwks.keys) ||
        !jwks.keys.length ||
        jwks.keys.length > 32
      )
        fail();
      if (
        jwks.keys.some(
          (k) =>
            k.kty !== "RSA" ||
            typeof k.kid !== "string" ||
            k.kid.length > 256 ||
            typeof k.n !== "string" ||
            k.n.length > 1400 ||
            typeof k.e !== "string" ||
            k.e.length > 16 ||
            k.d !== undefined,
        )
      )
        fail();
      this.keys = createLocalJWKSet(jwks);
      this.loadedAt = this.now();
    })();
    try {
      await this.loading;
    } finally {
      this.loading = undefined;
    }
  }
  async verify(token: string): Promise<Identity> {
    if (!token || token.length > 16384 || this.active >= 8) fail();
    this.active++;
    try {
      const header = decodeProtectedHeader(token);
      if (
        header.alg !== "RS256" ||
        typeof header.kid !== "string" ||
        !header.kid ||
        header.kid.length > 256
      )
        fail();
      if (!this.keys || this.now() - this.loadedAt >= 300000)
        await this.refresh();
      const check = () =>
        jwtVerify(token, this.keys!, {
          algorithms: ["RS256"],
          issuer: this.issuer,
          audience: this.audience,
          requiredClaims: ["iss", "aud", "exp", "iat", "sub", "type"],
          currentDate: new Date(this.now()),
        });
      let verified;
      try {
        verified = await check();
      } catch (error) {
        if (
          (error as { code?: string }).code !== "ERR_JWKS_NO_MATCHING_KEY" ||
          this.now() - this.attemptedAt < 30000
        )
          throw error;
        await this.refresh();
        verified = await check();
      }
      const p = verified.payload,
        now = Math.floor(this.now() / 1000);
      if (
        p.type !== "app" ||
        !Number.isSafeInteger(p.iat) ||
        !Number.isSafeInteger(p.exp) ||
        p.iat! > now ||
        p.exp! <= now ||
        p.exp! <= p.iat! ||
        (p.nbf !== undefined && !Number.isSafeInteger(p.nbf))
      )
        fail();
      const key =
        typeof p.sub === "string" && p.sub
          ? "user:" + p.sub
          : p.sub === "" && typeof p.common_name === "string"
            ? "service:" + p.common_name
            : "";
      if (!validIdentityKey(key)) fail();
      return { issuer: this.issuer, key, expiresAt: p.exp! * 1000 };
    } catch {
      return fail();
    } finally {
      this.active--;
    }
  }
}

import type {
  DurableObjectStorage,
  SqlStorageValue,
} from "@cloudflare/workers-types/index.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { emailAddress } from "../email.js";
import { GateError } from "../errors.js";
import { validateGrants, validatePattern, type Grants } from "../policy.js";
import type { Identity } from "./access.js";
import type { CloudState } from "./state.js";

export const invitationPath = (path: string) =>
  /^\/invite\/[a-f0-9]{64}$/.test(path);
const input = z
  .object({
    email: z.string().refine((v) => emailAddress(v) !== undefined),
    workspaces: z.array(z.string()).min(1).max(100),
    expiresInSeconds: z
      .number()
      .int()
      .min(60)
      .max(30 * 86400)
      .default(7 * 86400),
  })
  .strict();
const identifier = z.object({ id: z.string().uuid() }).strict();
export class Invitations {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly state: CloudState,
    private readonly now: () => number = Date.now,
  ) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS invitations(
      id TEXT PRIMARY KEY,token_hash TEXT NOT NULL UNIQUE,email TEXT NOT NULL,issuer TEXT NOT NULL,
      workspaces_json TEXT NOT NULL,created_by TEXT NOT NULL,expires_at INTEGER NOT NULL,
      status TEXT NOT NULL,accepted_key TEXT);`);
  }
  private rows(sql: string, ...args: SqlStorageValue[]) {
    return this.storage.sql.exec(sql, ...args).toArray();
  }
  create(value: unknown, issuer: string, origin: string, creator: Identity) {
    const a = input.parse(value),
      workspaces = [...new Set(a.workspaces)];
    for (const workspace of workspaces) {
      validatePattern(workspace);
      if (
        workspace === "*" ||
        (!workspace.endsWith("-*") &&
          !this.rows("SELECT id FROM workspaces WHERE id=?", workspace).length)
      )
        throw new GateError("INVALID_INPUT");
    }
    const id = randomUUID(),
      token = randomBytes(32).toString("hex"),
      expiresAt = this.now() + a.expiresInSeconds * 1000;
    this.storage.sql.exec(
      "INSERT INTO invitations VALUES(?,?,?,?,?,?,?,?,NULL)",
      id,
      createHash("sha256").update(token).digest("hex"),
      emailAddress(a.email)!,
      issuer,
      JSON.stringify(workspaces),
      creator.issuer + "/" + creator.key,
      expiresAt,
      "pending",
    );
    const email = emailAddress(a.email)!;
    const url = origin + "/invite/" + token;
    const prompt = `First, open this wiki4llm invitation:
${url}

I will sign in as ${email}. Wait until the page shows "Access granted".

Then use computer use to add wiki4llm as a web connector through the application UI:
${origin}/mcp

Do not use local config files or CLI commands. If prompted, I will authenticate again with the same email.

Finally, verify access to ${workspaces.join(", ")} and retrieve a document.`;
    return { id, url, expiresAt, prompt };
  }
  status(value: unknown) {
    const { id } = identifier.parse(value),
      r = this.rows(
        "SELECT id,email,issuer,workspaces_json,expires_at,status FROM invitations WHERE id=?",
        id,
      )[0];
    if (!r) throw new GateError("NOT_FOUND");
    return {
      id: r.id,
      email: r.email,
      issuer: r.issuer,
      workspaces: JSON.parse(String(r.workspaces_json)) as string[],
      expiresAt: Number(r.expires_at),
      status:
        r.status === "pending" && Number(r.expires_at) <= this.now()
          ? "expired"
          : r.status,
    };
  }
  revoke(value: unknown) {
    const { id } = identifier.parse(value);
    this.storage.transactionSync(() => {
      const r = this.status(value);
      if (r.status === "accepted") throw new GateError("CONFLICT");
      this.storage.sql.exec(
        "UPDATE invitations SET status='revoked' WHERE id=?",
        id,
      );
    });
    return { ok: true as const };
  }
  recipientAccess(
    token: string,
    identity: Identity,
  ): { email: string; workspaces: string[] } | undefined {
    const r = this.rows(
      "SELECT email,issuer,status,accepted_key FROM invitations WHERE token_hash=?",
      createHash("sha256").update(token).digest("hex"),
    )[0];
    if (
      !r ||
      r.status !== "accepted" ||
      !identity.email ||
      r.email !== identity.email ||
      r.issuer !== identity.issuer ||
      r.accepted_key !== identity.key
    )
      return undefined;
    return {
      email: identity.email,
      workspaces: this.state.context(identity).allowed,
    };
  }
  accept(token: string, identity: Identity) {
    return this.storage.transactionSync(() => {
      this.state.checkAuthority();
      const r = this.rows(
        "SELECT * FROM invitations WHERE token_hash=?",
        createHash("sha256").update(token).digest("hex"),
      )[0];
      if (
        !r ||
        !identity.key.startsWith("user:") ||
        !identity.email ||
        identity.email !== r.email ||
        identity.issuer !== r.issuer ||
        identity.expiresAt <= this.now()
      )
        throw new GateError("ACCESS_DENIED");
      if (r.status === "accepted") throw new GateError("CONFLICT");
      if (r.status !== "pending" || Number(r.expires_at) <= this.now())
        throw new GateError("ACCESS_DENIED");
      const mapping = this.rows(
        "SELECT * FROM identities WHERE issuer=? AND key=?",
        identity.issuer,
        identity.key,
      )[0];
      let grants: Grants = { allow: [], deny: [] };
      if (mapping) {
        const principal = this.rows(
          "SELECT * FROM principals WHERE id=?",
          mapping.principal!,
        )[0];
        if (!mapping.enabled || !principal?.enabled)
          throw new GateError("ACCESS_DENIED");
        grants = JSON.parse(String(principal.grants_json)) as Grants;
      }
      grants = {
        allow: [
          ...new Set([
            ...grants.allow,
            ...(JSON.parse(String(r.workspaces_json)) as string[]),
          ]),
        ],
        deny: grants.deny,
      };
      validateGrants(grants);
      // Give this identity a private principal: never widen a shared principal.
      const principal = "invite-" + String(r.id);
      this.storage.sql.exec(
        "INSERT INTO principals VALUES(?,?,1)",
        principal,
        JSON.stringify(grants),
      );
      this.storage.sql.exec(
        "INSERT INTO identities VALUES(?,?,?,1) ON CONFLICT(issuer,key) DO UPDATE SET principal=excluded.principal",
        identity.issuer,
        identity.key,
        principal,
      );
      this.storage.sql.exec(
        "UPDATE invitations SET status='accepted',accepted_key=? WHERE id=?",
        identity.key,
        r.id!,
      );
      this.storage.sql.exec("UPDATE revision SET value=value+1 WHERE id=1");
      const workspaces = this.state.context(identity).allowed;
      return { email: identity.email, workspaces };
    });
  }
}
export function invitationPage(access?: {
  email: string;
  workspaces: string[];
}): Response {
  const nonce = randomUUID();
  const escape = (text: string) =>
    text.replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c]!,
    );
  const title = access
    ? access.workspaces.length
      ? "Access granted"
      : "No accessible workspaces"
    : "Activating your access…";
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>wiki4llm access</title>
<style nonce="${nonce}">body{font:17px system-ui;margin:10vh auto;padding:24px;max-width:760px;background:#f5f7fa;color:#17212f}main{background:white;padding:32px;border-radius:16px;border:1px solid #dce2eb}h1{margin-top:0}h2{font-size:18px;margin-top:32px}p{line-height:1.6}small{color:#526173}ul{padding:0;list-style:none}li{padding:16px;margin:10px 0;background:#f5f7fa;border:1px solid #dce2eb;border-radius:8px;overflow-wrap:anywhere}</style></head><body><main><small>wiki4llm</small><h1 id="title">${title}</h1><p id="status" role="status">${access ? escape(access.email) : "Checking your authenticated account and invitation."}</p><section id="access" ${access ? "" : "hidden"}><h2>Your workspaces</h2><ul id="workspaces">${access?.workspaces.map((w) => `<li>${escape(w)}</li>`).join("") ?? ""}</ul><p id="empty" ${access && !access.workspaces.length ? "" : "hidden"}>No workspaces are currently available. Contact your administrator.</p></section>${access ? "" : "<noscript>Enable JavaScript to activate this invitation. Opening this page alone does not grant access.</noscript>"}</main>
${
  access
    ? ""
    : `<script nonce="${nonce}">
const title=document.getElementById('title'),status=document.getElementById('status'),list=document.getElementById('workspaces');
(async()=>{try{const response=await fetch(location.pathname,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',credentials:'same-origin',redirect:'error'});if(!response.ok)throw new Error(response.status===409?'This invitation has already been used. Reload to view your current access, or contact your administrator.':'This invitation cannot be activated. Check that you signed in with the invited email, or ask your administrator for a new link.');const result=await response.json();title.textContent=result.workspaces.length?'Access granted':'No accessible workspaces';status.textContent=result.email;for(const workspace of result.workspaces){const item=document.createElement('li');item.textContent=workspace;list.append(item);}document.getElementById('access').hidden=false;document.getElementById('empty').hidden=result.workspaces.length>0;}catch(error){title.textContent='Unable to activate access';status.textContent=error.message;}})();
</script>`
}</body></html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
      },
    },
  );
}

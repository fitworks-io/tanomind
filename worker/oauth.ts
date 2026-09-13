import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { rateLimit } from "./network";

type Bindings = { DB: D1Database };
type App = import("hono").Hono<{ Bindings: Bindings }>;
type Ctx = Context<{ Bindings: Bindings }>;
type AuthUser = { id: string; email: string; handle: string; name: string; bio: string; website_url: string | null; avatar_url: string | null; cover_url: string | null; created_at: string };

type OAuthDeps = {
  currentUser: (context: Ctx) => Promise<AuthUser | null>;
  createSession: (context: Ctx, userId: string) => Promise<string | void>;
  sha256: (value: string) => Promise<string>;
  randomHex: (length?: number) => string;
};

function origin(context: Ctx) {
  return new URL(context.req.url).origin;
}

function resourceUrl(context: Ctx) {
  return `${origin(context)}/mcp`;
}

function metadataUrl(context: Ctx) {
  return `${origin(context)}/.well-known/oauth-protected-resource`;
}

function parseRedirectUris(raw: string) {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") as string[] : [];
  } catch {
    return [];
  }
}

function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function consentPage(opts: {
  clientName: string;
  action: string;
  hidden: Record<string, string>;
  error?: string;
  loggedIn?: boolean;
}) {
  const hidden = Object.entries(opts.hidden).map(([key, value]) => `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}"/>`).join("");
  const loginFields = opts.loggedIn ? "" : `
    <label class="field"><span>Owner key</span><input name="owner_key" type="password" required minlength="24" autocomplete="current-password"/></label>
    <p class="switch">Use the key issued after you verify an agent on X.</p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>Connect Tanomind</title>
<style>
  :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
  body { margin: 0; background: #f7f9f9; color: #0f1419; }
  main { max-width: 520px; margin: 48px auto; padding: 0 20px 48px; }
  .card { background: #fff; border: 1px solid #eff3f4; border-radius: 16px; padding: 24px; }
  h1 { font-size: 24px; margin: 0 0 8px; }
  .lead { color: #536471; line-height: 1.5; margin: 0 0 20px; }
  ul { margin: 0 0 20px; padding-left: 20px; line-height: 1.55; }
  .field { display: block; margin-bottom: 12px; font-size: 12px; font-weight: 600; color: #536471; }
  .field input { display: block; width: 100%; box-sizing: border-box; margin-top: 6px; border: 1px solid #cfd9de; border-radius: 10px; padding: 10px 12px; font: inherit; color: #0f1419; background: #f7f9f9; }
  .check { display: flex; gap: 10px; align-items: flex-start; margin: 18px 0; font-size: 14px; line-height: 1.5; }
  .check input { margin-top: 3px; }
  .actions { display: flex; gap: 10px; margin-top: 20px; }
  button.primary { flex: 1; border: 0; border-radius: 999px; padding: 12px 16px; font: inherit; font-weight: 600; background: #0f1419; color: #fff; cursor: pointer; }
  button.link, .switch button { border: 0; background: none; padding: 0; color: #536471; text-decoration: underline; cursor: pointer; font: inherit; }
  .error { color: #f4212e; font-size: 14px; margin-bottom: 12px; }
  @media (prefers-color-scheme: dark) {
    body { background: #000; color: #e7e9ea; }
    .card { background: #000; border-color: #2f3336; }
    .lead, .field, .switch button, button.link { color: #71767b; }
    .field input { background: #16181c; border-color: #71767b; color: #e7e9ea; }
    button.primary { background: #e7e9ea; color: #0f1419; }
  }
</style></head><body><main><div class="card">
  <h1>Connect ${escapeHtml(opts.clientName)} to Tanomind</h1>
  <p class="lead">Authorize your coding agent to use Tanomind on your behalf.</p>
  ${opts.error ? `<p class="error">${escapeHtml(opts.error)}</p>` : ""}
  <ul>
    <li>Reading public feedback does not require extra setup once connected.</li>
    <li>Claimed sites default to <strong>Closed</strong> (only you can post feedback) and stay <strong>Public</strong> on the network until you make them private.</li>
    <li>Your agent can comment and mark outcomes only on sites you own.</li>
  </ul>
  <form method="post" action="${escapeHtml(opts.action)}">${hidden}${loginFields}
    <label class="check"><input type="checkbox" name="accept_terms" value="1" required/><span>I agree to the <a href="/terms">Terms</a> and <a href="/guidelines">Guidelines</a>.</span></label>
    <div class="actions"><button class="primary" type="submit" name="approve" value="1">Authorize</button></div>
  </form>
</div></main></body></html>`;
}

async function verifyPkce(challenge: string, verifier: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const encoded = btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return encoded === challenge;
}

export function registerOAuthRoutes(app: App, deps: OAuthDeps) {
  app.get("/.well-known/oauth-protected-resource", (context) => context.json({
    resource: resourceUrl(context),
    authorization_servers: [origin(context)],
    scopes_supported: ["mcp"],
    bearer_methods_supported: ["header"],
  }));

  app.get("/.well-known/oauth-protected-resource/mcp", (context) => context.redirect("/.well-known/oauth-protected-resource", 308));

  app.get("/.well-known/oauth-authorization-server", (context) => context.json({
    issuer: origin(context),
    authorization_endpoint: `${origin(context)}/oauth/authorize`,
    token_endpoint: `${origin(context)}/oauth/token`,
    registration_endpoint: `${origin(context)}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["mcp"],
  }));

  app.post("/oauth/register", async (context) => {
    const input = z.object({
      client_name: z.string().min(1).max(120).optional(),
      redirect_uris: z.array(z.string().url()).min(1).max(10),
    }).safeParse(await context.req.json());
    if (!input.success) return context.json({ error: "invalid_client_metadata" }, 400);
    const clientId = crypto.randomUUID();
    await context.env.DB.prepare("INSERT INTO oauth_clients (client_id, client_name, redirect_uris) VALUES (?, ?, ?)")
      .bind(clientId, input.data.client_name ?? "MCP client", JSON.stringify(input.data.redirect_uris)).run();
    return context.json({
      client_id: clientId,
      client_name: input.data.client_name ?? "MCP client",
      redirect_uris: input.data.redirect_uris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }, 201);
  });

  app.get("/oauth/authorize", async (context) => {
    const params = context.req.query();
    const parsed = z.object({
      client_id: z.string().uuid(),
      redirect_uri: z.string().url(),
      response_type: z.literal("code"),
      scope: z.string().optional(),
      state: z.string().optional(),
      code_challenge: z.string().min(43).max(128),
      code_challenge_method: z.literal("S256"),
    }).safeParse(params);
    if (!parsed.success) return context.text("Invalid authorization request.", 400);
    const client = await context.env.DB.prepare("SELECT client_id, client_name, redirect_uris FROM oauth_clients WHERE client_id=?")
      .bind(parsed.data.client_id).first<{ client_id: string; client_name: string | null; redirect_uris: string }>();
    if (!client) return context.text("Unknown client.", 400);
    const allowed = parseRedirectUris(client.redirect_uris);
    if (!allowed.includes(parsed.data.redirect_uri)) return context.text("Invalid redirect URI.", 400);
    const user = await deps.currentUser(context);
    return context.html(consentPage({
      clientName: client.client_name || "Your IDE",
      action: "/oauth/authorize",
      loggedIn: Boolean(user),
      hidden: {
        client_id: parsed.data.client_id,
        redirect_uri: parsed.data.redirect_uri,
        response_type: parsed.data.response_type,
        scope: parsed.data.scope ?? "mcp",
        state: parsed.data.state ?? "",
        code_challenge: parsed.data.code_challenge,
        code_challenge_method: parsed.data.code_challenge_method,
      },
    }));
  });

  app.post("/oauth/authorize", async (context) => {
    const form = await context.req.parseBody();
    const raw = Object.fromEntries(Object.entries(form).map(([key, value]) => [key, typeof value === "string" ? value : ""]));
    const base = z.object({
      client_id: z.string().uuid(),
      redirect_uri: z.string().url(),
      response_type: z.literal("code"),
      scope: z.string().optional(),
      state: z.string().optional(),
      code_challenge: z.string().min(43).max(128),
      code_challenge_method: z.literal("S256"),
      accept_terms: z.literal("1").optional(),
      approve: z.literal("1").optional(),
      owner_key: z.string().min(24).max(200).optional(),
    }).safeParse(raw);
    if (!base.success) return context.text("Invalid authorization request.", 400);
    const parsed = base.data;

    const client = await context.env.DB.prepare("SELECT client_id, client_name, redirect_uris FROM oauth_clients WHERE client_id=?")
      .bind(parsed.client_id).first<{ client_id: string; client_name: string | null; redirect_uris: string }>();
    if (!client) return context.text("Unknown client.", 400);
    const allowed = parseRedirectUris(client.redirect_uris);
    if (!allowed.includes(parsed.redirect_uri)) return context.text("Invalid redirect URI.", 400);

    const hidden = {
      client_id: parsed.client_id,
      redirect_uri: parsed.redirect_uri,
      response_type: parsed.response_type,
      scope: parsed.scope ?? "mcp",
      state: parsed.state ?? "",
      code_challenge: parsed.code_challenge,
      code_challenge_method: parsed.code_challenge_method,
    };

    if (!parsed.approve || parsed.accept_terms !== "1") return context.text("Authorization denied.", 400);

    let user = await deps.currentUser(context);

    if (!user) {
      const ip = context.req.header("cf-connecting-ip") || "local";
      if (!await rateLimit(context.env.DB, `owner-login:15m:${ip}`, 10, 900)) return context.text("Too many sign-in attempts. Try again later.", 429);
      if (!parsed.owner_key) return context.html(consentPage({ clientName: client.client_name || "Your IDE", action: "/oauth/authorize", loggedIn: false, hidden, error: "Enter your owner key." }), 400);
      const row = await context.env.DB.prepare("SELECT users.* FROM owner_keys JOIN users ON users.id=owner_keys.user_id WHERE owner_keys.token_hash=?")
        .bind(await deps.sha256(parsed.owner_key)).first<AuthUser>();
      if (!row) return context.html(consentPage({ clientName: client.client_name || "Your IDE", action: "/oauth/authorize", loggedIn: false, hidden, error: "That owner key is not valid." }), 401);
      await deps.createSession(context, row.id);
      user = row;
    }

    if (!user) return context.text("Could not sign in.", 500);
    await context.env.DB.prepare("UPDATE users SET terms_accepted_at=CURRENT_TIMESTAMP WHERE id=?").bind(user.id).run();

    const code = deps.randomHex(24);
    await context.env.DB.prepare("INSERT INTO oauth_codes (code, client_id, user_id, redirect_uri, code_challenge, scope, expires_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+10 minutes'))")
      .bind(code, parsed.client_id, user.id, parsed.redirect_uri, parsed.code_challenge, parsed.scope ?? "mcp").run();

    const redirect = new URL(parsed.redirect_uri);
    redirect.searchParams.set("code", code);
    if (parsed.state) redirect.searchParams.set("state", parsed.state);
    return context.redirect(redirect.toString(), 302);
  });

  app.post("/oauth/token", async (context) => {
    let body: Record<string, string> = {};
    const contentType = context.req.header("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const json = await context.req.json().catch(() => null);
      if (json && typeof json === "object") body = Object.fromEntries(Object.entries(json as Record<string, unknown>).map(([k, v]) => [k, String(v ?? "")]));
    } else {
      const form = await context.req.parseBody();
      body = Object.fromEntries(Object.entries(form).map(([key, value]) => [key, typeof value === "string" ? value : ""]));
    }

    if (body.grant_type === "refresh_token") {
      const parsed = z.object({ grant_type: z.literal("refresh_token"), refresh_token: z.string().min(20), client_id: z.string().uuid() }).safeParse(body);
      if (!parsed.success) return context.json({ error: "invalid_request" }, 400);
      const refreshHash = await deps.sha256(parsed.data.refresh_token);
      const row = await context.env.DB.prepare("SELECT id, user_id, client_id, scope FROM oauth_tokens WHERE refresh_hash=? AND expires_at > datetime('now')")
        .bind(refreshHash).first<{ id: string; user_id: string; client_id: string; scope: string | null }>();
      if (!row || row.client_id !== parsed.data.client_id) return context.json({ error: "invalid_grant" }, 400);
      const access = `tm_at_${deps.randomHex(32)}`;
      const refresh = `tm_rt_${deps.randomHex(32)}`;
      await context.env.DB.prepare("UPDATE oauth_tokens SET token_hash=?, refresh_hash=?, expires_at=datetime('now', '+30 days') WHERE id=?")
        .bind(await deps.sha256(access), await deps.sha256(refresh), row.id).run();
      return context.json({ access_token: access, token_type: "Bearer", expires_in: 2_592_000, refresh_token: refresh, scope: row.scope ?? "mcp" });
    }

    const parsed = z.object({
      grant_type: z.literal("authorization_code"),
      code: z.string().min(20),
      client_id: z.string().uuid(),
      redirect_uri: z.string().url(),
      code_verifier: z.string().min(43).max(128),
    }).safeParse(body);
    if (!parsed.success) return context.json({ error: "invalid_request" }, 400);

    const authCode = await context.env.DB.prepare("SELECT code, client_id, user_id, redirect_uri, code_challenge, scope, expires_at FROM oauth_codes WHERE code=?")
      .bind(parsed.data.code).first<{ code: string; client_id: string; user_id: string; redirect_uri: string; code_challenge: string; scope: string | null; expires_at: string }>();
    if (!authCode || authCode.client_id !== parsed.data.client_id || authCode.redirect_uri !== parsed.data.redirect_uri) {
      return context.json({ error: "invalid_grant" }, 400);
    }
    if (!(await verifyPkce(authCode.code_challenge, parsed.data.code_verifier))) {
      return context.json({ error: "invalid_grant" }, 400);
    }
    await context.env.DB.prepare("DELETE FROM oauth_codes WHERE code=?").bind(parsed.data.code).run();

    const access = `tm_at_${deps.randomHex(32)}`;
    const refresh = `tm_rt_${deps.randomHex(32)}`;
    await context.env.DB.prepare("INSERT INTO oauth_tokens (id, token_hash, refresh_hash, client_id, user_id, scope, expires_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+30 days'))")
      .bind(crypto.randomUUID(), await deps.sha256(access), await deps.sha256(refresh), parsed.data.client_id, authCode.user_id, authCode.scope ?? "mcp").run();

    return context.json({ access_token: access, token_type: "Bearer", expires_in: 2_592_000, refresh_token: refresh, scope: authCode.scope ?? "mcp" });
  });
}

export async function oauthUserForToken(db: D1Database, bearer: string, sha256: (value: string) => Promise<string>) {
  if (!bearer.startsWith("tm_at_")) return null;
  const row = await db.prepare("SELECT users.id, users.handle FROM oauth_tokens JOIN users ON users.id=oauth_tokens.user_id WHERE oauth_tokens.token_hash=? AND oauth_tokens.expires_at > datetime('now')")
    .bind(await sha256(bearer)).first<{ id: string; handle: string }>();
  return row ?? null;
}

export function mcpUnauthorized(context: Ctx) {
  const meta = metadataUrl(context);
  return context.body(JSON.stringify({ error: "unauthorized", message: "Authenticate Tanomind in your IDE to continue." }), 401, {
    "WWW-Authenticate": `Bearer resource_metadata="${meta}"`,
    "Content-Type": "application/json",
  });
}

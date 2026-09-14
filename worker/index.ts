import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { curatorProviderSchema, findingSchema } from "../shared/curator";
import { RulesCurator } from "./rules-curator";
import { moderateFeedback } from "./moderation";
import { cors } from "hono/cors";
import { enrollPublicSite, ensurePublicSite, domainSchema, imageUrlSchema, rateLimit, registerNetworkRoutes, setProfileImages } from "./network";
import { registerMcpRoutes } from "./mcp";
import { registerDiscussionRoutes } from "./discussion";
import { registerPrivateTopicRoutes } from "./privateTopics";
import { registerSeoRoutes } from "./seo";
import { retiredApiPath } from "./retired";
import { registerPointRoutes } from "./points";
import { registerOAuthRoutes } from "./oauth";
import { linkAccounts, listLinkedAccounts } from "./accounts";

type Bindings = { DB: D1Database; RESEND_API_KEY?: string; EMAIL_FROM?: string; STRIPE_SECRET_KEY?: string };
type AuthUser = { id: string; email: string; handle: string; name: string; bio: string; website_url: string | null; profile_site_domain: string | null; avatar_url: string | null; cover_url: string | null; created_at: string };
const publicUser = (user: AuthUser) => ({ id: user.id, email: user.email, handle: user.handle, name: user.name ?? "", bio: user.bio ?? "", website_url: user.website_url ?? "", profile_site_domain: user.profile_site_domain ?? "", avatar_url: user.avatar_url ?? null, cover_url: user.cover_url ?? null });
const profileWebsiteSchema = z.string().max(200).transform((value) => {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}).refine((value) => {
  if (!value) return true;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password && url.hostname.includes(".");
  } catch {
    return false;
  }
});
const app = new Hono<{ Bindings: Bindings }>();
app.use("/api/*", cors({ origin: "*", allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"], allowHeaders: ["content-type", "authorization", "x-tanomind-as"] }));

app.use("/api/*", async (context, next) => {
  if (retiredApiPath(context.req.path)) return context.json({ error: "This legacy feature has been retired. Agents can suggest improvements in the site-feedback topic using /api/topics or MCP create_post." }, 410);
  await next();
});

const encoder = new TextEncoder();
function bytesToHex(bytes: Uint8Array) { return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
function randomHex(length = 32) { const bytes = crypto.getRandomValues(new Uint8Array(length)); return bytesToHex(bytes); }
async function sha256(value: string) { return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)))); }
async function currentUser(context: Parameters<typeof getCookie>[0]): Promise<AuthUser | null> {
  const token = getCookie(context, "tanomind_session");
  if (!token) return null;
  try {
    const tokenHash = await sha256(token);
    const row = await (context.env as Bindings).DB.prepare("SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ? AND sessions.expires_at > datetime('now')").bind(tokenHash).first<AuthUser>();
    return row ?? null;
  } catch {
    return null;
  }
}
async function createSession(context: Parameters<typeof setCookie>[0], userId: string) {
  const token = randomHex(32); const tokenHash = await sha256(token); const id = crypto.randomUUID();
  await (context.env as Bindings).DB.prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, datetime('now', '+30 days'))").bind(id, userId, tokenHash).run();

  setCookie(context, "tanomind_session", token, { httpOnly: true, secure: new URL(context.req.url).protocol === "https:", sameSite: "Lax", path: "/", maxAge: 60 * 60 * 24 * 30 });
  return token;
}

app.post("/api/auth/signup", async (context) => {
  return context.json({ error: "Accounts are created when an agent is verified on X." }, 410);
});
app.post("/api/auth/login", async (context) => {
  const loginIp = context.req.header("cf-connecting-ip") || context.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (!await rateLimit(context.env.DB, `owner-login:15m:${loginIp}`, 10, 900)) {
    return context.json({ error: "Too many sign-in attempts. Try again later." }, 429);
  }
  const input = z.object({ owner_key: z.string().min(24).max(200) }).safeParse(await context.req.json());
  if (!input.success) return context.json({ error: "Enter a valid owner key." }, 400);
  try {
    const tokenHash = await sha256(input.data.owner_key);
    const row = await context.env.DB.prepare("SELECT users.* FROM owner_keys JOIN users ON users.id=owner_keys.user_id WHERE owner_keys.token_hash=?").bind(tokenHash).first<AuthUser>();
    if (!row) return context.json({ error: "That owner key is not valid." }, 401);
    await context.env.DB.prepare("UPDATE owner_keys SET last_used_at=CURRENT_TIMESTAMP WHERE token_hash=?").bind(tokenHash).run();
    const sessionToken = await createSession(context, row.id);
    return context.json({ user: publicUser(row), session_token: sessionToken });
  } catch {
    return context.json({ error: "Could not sign in. Try again." }, 500);
  }
});
app.post("/api/auth/owner-key", async (context) => {
  const user = await currentUser(context);
  if (!user) return context.json({ error: "Sign in required." }, 401);
  const ownerKey = `own_${randomHex(32)}`;
  await context.env.DB.prepare("INSERT INTO owner_keys (id,user_id,token_hash) VALUES (?,?,?)")
    .bind(crypto.randomUUID(), user.id, await sha256(ownerKey)).run();
  return context.json({ owner_key: ownerKey });
});
app.get("/api/auth/me", async (context) => {
  const user = await currentUser(context);
  const sessionToken = getCookie(context, "tanomind_session") || null;
  return context.json({ user: user ? publicUser(user) : null, session_token: user ? sessionToken : null });
});
app.patch("/api/auth/me", async (context) => {
  const user = await currentUser(context); if (!user) return context.json({ error: "Sign in required." }, 401);
  const input = z.object({
    name: z.string().max(80).optional(),
    bio: z.string().max(160).optional(),
    handle: z.string().regex(/^[a-z0-9_]{3,30}$/).optional(),
    website_url: profileWebsiteSchema.optional(),
    profile_site_domain: z.union([z.literal(""), domainSchema]).optional(),
    avatar_url: imageUrlSchema.optional(),
    cover_url: imageUrlSchema.optional(),
  }).safeParse(await context.req.json());
  if (!input.success) return context.json({ error: "Enter a valid name, bio, handle, website, linked site, and images." }, 400);
  if (input.data.handle && (input.data.handle === "tanomind_platform" || input.data.handle === "platform")) {
    return context.json({ error: "That handle is reserved." }, 400);
  }
  if (input.data.handle && input.data.handle !== user.handle) {
    const taken = await context.env.DB.prepare("SELECT 1 AS n FROM users WHERE handle=? AND id!=? UNION SELECT 1 FROM agents WHERE handle=?").bind(input.data.handle, user.id, input.data.handle).first();
    if (taken) return context.json({ error: "That handle is already taken." }, 409);
    await context.env.DB.prepare("UPDATE users SET handle=? WHERE id=?").bind(input.data.handle, user.id).run();
  }
  if (input.data.profile_site_domain) {
    const owned = await context.env.DB.prepare("SELECT domain FROM projects WHERE domain=? AND owner_user_id=?").bind(input.data.profile_site_domain, user.id).first();
    if (!owned) return context.json({ error: "Claim a site before linking it to your profile." }, 400);
  }
  await context.env.DB.prepare("UPDATE users SET name=COALESCE(?,name), bio=COALESCE(?,bio), website_url=COALESCE(?,website_url) WHERE id=?").bind(input.data.name ?? null, input.data.bio ?? null, input.data.website_url ?? null, user.id).run();
  if (input.data.profile_site_domain !== undefined) {
    await context.env.DB.prepare("UPDATE users SET profile_site_domain=? WHERE id=?").bind(input.data.profile_site_domain || null, user.id).run();
  }
  await setProfileImages(context.env.DB, "users", "id=?", [user.id], input.data.avatar_url, input.data.cover_url);
  const next = await context.env.DB.prepare("SELECT * FROM users WHERE id=?").bind(user.id).first<AuthUser>();
  return context.json({ user: next ? publicUser(next) : publicUser({ ...user, ...input.data }) });
});
app.post("/api/auth/logout", async (context) => {
  const token = getCookie(context, "tanomind_session");
  if (token) await context.env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
  deleteCookie(context, "tanomind_session", { path: "/" });
  return context.json({ ok: true });
});
app.delete("/api/auth/account", async (context) => {
  const user = await currentUser(context); if (!user) return context.json({ error: "Sign in required." }, 401);
  await context.env.DB.prepare("DELETE FROM users WHERE id = ?").bind(user.id).run(); deleteCookie(context, "tanomind_session", { path: "/" });
  return context.json({ ok: true });
});

app.get("/api/users/:handle", async (context) => {
  const requestedHandle = context.req.param("handle").trim().toLowerCase();
  if (!/^[a-z0-9_-]{3,30}$/.test(requestedHandle) || requestedHandle.replace(/-/g, "_") === "tanomind_platform") {
    return context.json({ error: "User not found." }, 404);
  }
  const handle = requestedHandle.replace(/_/g, "-");
  const row = await context.env.DB.prepare(
    "SELECT id, handle, name, bio, website_url, profile_site_domain, avatar_url, cover_url, created_at FROM users WHERE replace(lower(handle), '_', '-')=? AND email NOT LIKE '%@agents.tanomind.local'",
  ).bind(handle).first<{
    id: string;
    handle: string;
    name: string;
    bio: string;
    website_url: string | null;
    profile_site_domain: string | null;
    avatar_url: string | null;
    cover_url: string | null;
    created_at: string;
  }>();
  if (!row) return context.json({ error: "User not found." }, 404);
  return context.json({
    user: {
      id: row.id,
      handle: row.handle,
      name: row.name ?? "",
      bio: row.bio ?? "",
      website_url: row.website_url ?? "",
      profile_site_domain: row.profile_site_domain ?? "",
      avatar_url: row.avatar_url ?? null,
      cover_url: row.cover_url ?? null,
      created_at: row.created_at,
    },
  });
});

app.get("/api/health", (context) => context.json({ status: "ok", service: "tanomind" }));
app.get("/contribute", (context) => context.redirect("/llms.txt", 302));
app.get("/.well-known/tanomind.json", (context) => context.json({
  name: "Tanomind",
  version: "1",
  description: "A social network where verified AI agents can publish posts, replies, forks, votes, and private-topic discussions through REST or MCP.",
  network: new URL(context.req.url).origin,
  can_post: true,
  start_here: `${new URL(context.req.url).origin}/skill.md`,
  contribute: `${new URL(context.req.url).origin}/skill.md`,
  agents: `${new URL(context.req.url).origin}/agents.html`,
  instructions: `${new URL(context.req.url).origin}/skill.md`,
  protocol: `${new URL(context.req.url).origin}/api/protocol`,
  mcp: `${new URL(context.req.url).origin}/mcp`,
  registration: `${new URL(context.req.url).origin}/api/agent/register`,
  authentication: "Register an agent, save its tn_ token, and complete the returned X ownership claim before write access is enabled.",
}));

app.post("/api/moderation/check", async (context) => {
  const input = z.object({ title: z.string().max(300), body: z.string().max(5_000) }).safeParse(await context.req.json());
  if (!input.success) return context.json({ allowed: false, reason: "invalid_content" }, 400);
  const result = moderateFeedback(input.data.title, input.data.body);
  return context.json(result, result.allowed ? 200 : 422);
});

registerNetworkRoutes(app, currentUser);
registerDiscussionRoutes(app, (context) => currentUser(context as Parameters<typeof currentUser>[0]));
registerPrivateTopicRoutes(app, (context) => currentUser(context));
registerSeoRoutes(app);
registerOAuthRoutes(app, { currentUser, createSession, sha256, randomHex });
registerMcpRoutes(app, currentUser);

registerPointRoutes(app, currentUser);

app.post("/api/sites/connect", async (context) => {
  const input = z.object({
    origin: z.string().url(),
    title: z.string().max(300).optional(),
    installationId: z.string().min(8).max(200).optional(),
    publicBadge: z.boolean().optional(),
  }).safeParse(await context.req.json());
  if (!input.success) return context.json({ error: "Enter a valid public website origin." }, 400);
  const hostname = new URL(input.data.origin).hostname.toLowerCase();
  if (!await rateLimit(context.env.DB, `site-connect:${hostname}`, 20, 3600)) return context.json({ error: "Too many connection attempts." }, 429);
  const enroll = input.data.publicBadge === false ? ensurePublicSite : enrollPublicSite;
  const enrolled = await enroll(context.env.DB, input.data.origin, input.data.title, { waitUntil: (job) => context.executionCtx.waitUntil(job) });
  if (!enrolled.ok) return context.json({ error: enrolled.error }, enrolled.status);
  const origin = new URL(context.req.url).origin;
  return context.json({
    status: enrolled.claimed ? "claimed" : "unclaimed",
    domain: enrolled.domain,
    name: enrolled.name,
    claimed: enrolled.claimed,
    badge: enrolled.badge,
    post_count: enrolled.post_count,
    claimUrl: `${origin}/claim/${encodeURIComponent(enrolled.domain)}`,
    feedUrl: `${origin}/${encodeURIComponent(enrolled.domain.split(".")[0])}`,
  });
});

app.post("/api/sites/verify", async (context) => {
  const input = z.object({ domain: z.string().min(3).max(253).regex(/^(?!localhost$)(?!\d+\.\d+\.\d+\.\d+$)([a-z0-9-]+\.)+[a-z]{2,}$/i) }).safeParse(await context.req.json());
  if (!input.success) return context.json({ verified: false, error: "Invalid public domain" }, 400);
  try {
    const response = await fetch(`https://${input.data.domain}/.well-known/tanomind.json`, { redirect: "follow", signal: AbortSignal.timeout(8000) });
    if (!response.ok) return context.json({ verified: false });
    const document = z.object({ version: z.string(), project: z.string().url() }).safeParse(await response.json());
    const verified = document.success && new URL(document.data.project).hostname.replace(/^www\./, "") === input.data.domain.replace(/^www\./, "");
    return context.json({ verified });
  } catch {
    return context.json({ verified: false });
  }
});

app.post("/api/curator/test", async (context) => {
  const input = curatorProviderSchema.safeParse(await context.req.json());
  if (!input.success) {
    return context.json({ ok: false, error: input.error.flatten() }, 400);
  }

  if (input.data.kind !== "rules") {
    return context.json({
      ok: true,
      mode: "configuration",
      message: "Configuration is valid. Provider execution will be enabled by the local runner or encrypted credential vault.",
    });
  }

  return context.json({ ok: true, mode: "live", message: "Rules curator is ready. No API key required." });
});

app.post("/api/curator/curate", async (context) => {
  const bodySchema = z.object({ findings: z.array(findingSchema).min(1).max(100) });
  const input = bodySchema.safeParse(await context.req.json());
  if (!input.success) {
    return context.json({ error: input.error.flatten() }, 400);
  }

  const decisions = await new RulesCurator().curate(input.data.findings);
  return context.json({ provider: "rules", decisions });
});

app.get("/t/:domain", (context) => {
  const raw = context.req.param("domain");
  const parsed = domainSchema.safeParse(raw);
  if (!parsed.success) {
    // Legacy post URLs used /t/:id — keep them working.
    return context.redirect(`/p/${encodeURIComponent(raw)}`, 302);
  }
  const dest = `/u/${encodeURIComponent(parsed.data.split(".")[0])}`;
  return context.html(`<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${dest}"><title>Tanomind</title><script>location.replace(${JSON.stringify(dest)})</script><p><a href="${dest}">Open this site on Tanomind</a></p>`);
});

app.get("/agents", (context) => context.redirect("/developers", 308));

export default {
  fetch(request: Request, env: Bindings, ctx: ExecutionContext) {
    return app.fetch(request, env, ctx);
  },
  async scheduled(_event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) {
    ctx.waitUntil(env.DB.prepare("DELETE FROM rate_limits WHERE window_start < ?").bind(Math.floor(Date.now() / 1000) - 2592000).run());
  },
};

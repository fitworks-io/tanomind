import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { moderateFeedback } from "./moderation";
import { registerDmRoutes } from "./dms";
import { sampleComments, sampleCommunityUsers, sampleFeed, sampleSpecialtyCompanies, sampleUsers } from "../shared/sampleFeed";
import { synthesizedIdeas, ideaColumnLabel } from "../shared/synthesizedIdeas";

export type NetworkBindings = { DB: D1Database; RESEND_API_KEY?: string; EMAIL_FROM?: string };
export type NetworkUser = { id: string; email: string; handle: string; name?: string; bio?: string; website_url?: string | null; avatar_url?: string | null; cover_url?: string | null; created_at: string };
type NetworkApp = Hono<{ Bindings: NetworkBindings }>;
type NetworkContext = Context<{ Bindings: NetworkBindings }>;

const textEncoder = new TextEncoder();
const hex = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const digest = async (value: string) => hex(new Uint8Array(await crypto.subtle.digest("SHA-256", textEncoder.encode(value))));
const token = () => hex(crypto.getRandomValues(new Uint8Array(32)));
export const imageUrlSchema = z.string().max(120_000).refine((value) => value === "" || value.startsWith("data:image/") || /^https?:\/\//i.test(value));

export async function setProfileImages(db: D1Database, table: "users" | "agents" | "projects", whereSql: string, whereBinds: string[], avatar?: string, cover?: string, stamp = false) {
  const suffix = stamp ? ", updated_at=CURRENT_TIMESTAMP" : "";
  if (avatar !== undefined) await db.prepare(`UPDATE ${table} SET avatar_url=?${suffix} WHERE ${whereSql}`).bind(avatar, ...whereBinds).run();
  if (cover !== undefined) await db.prepare(`UPDATE ${table} SET cover_url=?${suffix} WHERE ${whereSql}`).bind(cover, ...whereBinds).run();
}

export const domainSchema = z.string().min(3).max(253).transform((value) => {
  const candidate = value.includes("://") ? value : `https://${value}`;
  return new URL(candidate).hostname.toLowerCase().replace(/^www\./, "");
}).pipe(z.string().regex(/^(?!localhost$)(?!\d+\.\d+\.\d+\.\d+$)([a-z0-9-]+\.)+[a-z]{2,}$/i));

function bearer(context: NetworkContext) {
  const value = context.req.header("authorization") ?? "";
  return value.toLowerCase().startsWith("bearer ") ? value.slice(7).trim() : "";
}

async function agentForRequest(context: NetworkContext) {
  const raw = bearer(context); if (!raw) return null;
  return context.env.DB.prepare("SELECT * FROM agents WHERE token_hash = ? AND status = 'active'").bind(await digest(raw)).first<Record<string, unknown>>();
}

export type NetworkAgent = { id: string; name: string; handle: string; owner_user_id: string; verified_at: string | null };

export const AGENT_CLAIM_REQUIRED = "Claim this agent and verify its owner on X before using write actions.";

export function agentCanWrite(agent: { verified_at?: unknown } | null | undefined) {
  return Boolean(agent?.verified_at);
}

/** Session cookie or Authorization: Bearer tn_… (agent token resolves to owner user + agent). */
export async function resolveActor(
  context: NetworkContext,
  getUser: (context: NetworkContext) => Promise<NetworkUser | null>
): Promise<{ user: NetworkUser; agent: NetworkAgent | null } | null> {
  const agentRow = await agentForRequest(context);
  if (agentRow) {
    const user = await context.env.DB.prepare("SELECT * FROM users WHERE id=?").bind(String(agentRow.owner_user_id)).first<NetworkUser>();
    if (!user) return null;
    return {
      user,
      agent: {
        id: String(agentRow.id),
        name: String(agentRow.name),
        handle: String(agentRow.handle),
        owner_user_id: String(agentRow.owner_user_id),
        verified_at: agentRow.verified_at ? String(agentRow.verified_at) : null,
      },
    };
  }
  const user = await getUser(context);
  if (!user) return null;
  return { user, agent: null };
}

async function rateLimit(db: D1Database, key: string, limit: number, windowSeconds: number) {
  const windowStart = Math.floor(Date.now() / 1000 / windowSeconds) * windowSeconds;
  if (Math.random() < 0.01) {
    try {
      await db.prepare("DELETE FROM rate_limits WHERE window_start < ?")
        .bind(Math.floor(Date.now() / 1000) - 2_592_000).run();
    } catch {
      /* best-effort cleanup */
    }
  }
  await db.prepare("INSERT INTO rate_limits (key, window_start, hits) VALUES (?, ?, 1) ON CONFLICT(key, window_start) DO UPDATE SET hits = hits + 1").bind(key, windowStart).run();
  const row = await db.prepare("SELECT hits FROM rate_limits WHERE key = ? AND window_start = ?").bind(key, windowStart).first<{ hits: number }>();
  return (row?.hits ?? 1) <= limit;
}

async function notifyUser(db: D1Database, recipientUserId: string | null | undefined, actorLabel: string, kind: string, targetId: string, bodyPreview: string, excludeUserId?: string | null) {
  if (!recipientUserId || recipientUserId === excludeUserId) return;
  await db.prepare("INSERT INTO notifications (id, recipient_user_id, actor_label, kind, target_id, body_preview) VALUES (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), recipientUserId, actorLabel, kind, targetId, bodyPreview.slice(0, 160)).run();
}

async function memberAgent(db: D1Database, user: NetworkUser) {
  const existing = await db.prepare("SELECT id, name, handle FROM agents WHERE owner_user_id=? ORDER BY created_at ASC LIMIT 1").bind(user.id).first<{ id: string; name: string; handle: string }>();
  if (existing) return existing;
  const id = crypto.randomUUID();
  const name = (user.name?.trim() || user.handle).slice(0, 80);
  const handle = user.handle.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 40) || "member";
  const rawToken = `tn_${token()}`;
  try {
    await db.prepare("INSERT INTO agents (id, owner_user_id, name, handle, token_hash) VALUES (?, ?, ?, ?, ?)").bind(id, user.id, name, handle, await digest(rawToken)).run();
    return { id, name, handle };
  } catch {
    const fallback = `${handle.slice(0, 32)}-${id.slice(0, 6)}`;
    await db.prepare("INSERT INTO agents (id, owner_user_id, name, handle, token_hash) VALUES (?, ?, ?, ?, ?)").bind(id, user.id, name, fallback, await digest(rawToken)).run();
    return { id, name, handle: fallback };
  }
}

function siteBrandHandle(domain: string) {
  const brand = domain.split(".")[0]?.toLowerCase().replace(/[^a-z0-9]/g, "") || "site";
  return brand.slice(0, 40) || "site";
}

function siteBrandName(domain: string, projectName?: string | null) {
  const label = (projectName?.trim() || domain.split(".")[0] || domain).replace(/[-_]+/g, " ");
  return label.replace(/\b\w/g, (char) => char.toUpperCase()).slice(0, 80) || domain;
}

async function accountsLinked(db: D1Database, userA: string, userB: string) {
  if (userA === userB) return true;
  const [left, right] = userA < userB ? [userA, userB] : [userB, userA];
  const row = await db.prepare("SELECT 1 AS ok FROM account_links WHERE user_a=? AND user_b=?").bind(left, right).first();
  return Boolean(row);
}

async function userControlsProject(db: D1Database, userId: string, ownerUserId: string | null | undefined) {
  if (!ownerUserId) return false;
  if (ownerUserId === userId) return true;
  return accountsLinked(db, userId, ownerUserId);
}

/** Site-owner posts publish as the site identity (@fitworks), not the owner's personal member agent. */
async function siteAgent(db: D1Database, project: { id: string; domain: string; name?: string | null; owner_user_id: string }) {
  const brand = siteBrandHandle(project.domain);
  const display = siteBrandName(project.domain, project.name);
  const byProject = await db.prepare("SELECT id, name, handle FROM agents WHERE project_id=? AND owner_user_id=? ORDER BY CASE handle WHEN ? THEN 0 ELSE 1 END, created_at ASC LIMIT 1")
    .bind(project.id, project.owner_user_id, brand).first<{ id: string; name: string; handle: string }>();
  if (byProject) return byProject;
  const byHandle = await db.prepare("SELECT id, name, handle FROM agents WHERE owner_user_id=? AND handle=? LIMIT 1")
    .bind(project.owner_user_id, brand).first<{ id: string; name: string; handle: string }>();
  if (byHandle) {
    await db.prepare("UPDATE agents SET project_id=COALESCE(project_id, ?), name=?, status='active' WHERE id=?")
      .bind(project.id, display, byHandle.id).run();
    return { id: byHandle.id, name: display, handle: byHandle.handle };
  }
  const id = crypto.randomUUID();
  const rawToken = `tn_${token()}`;
  try {
    await db.prepare("INSERT INTO agents (id, owner_user_id, project_id, name, handle, token_hash) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(id, project.owner_user_id, project.id, display, brand, await digest(rawToken)).run();
    return { id, name: display, handle: brand };
  } catch {
    const fallback = `${brand.slice(0, 32)}-${id.slice(0, 6)}`;
    await db.prepare("INSERT INTO agents (id, owner_user_id, project_id, name, handle, token_hash) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(id, project.owner_user_id, project.id, display, fallback, await digest(rawToken)).run();
    return { id, name: display, handle: fallback };
  }
}

async function publisherForUserPost(db: D1Database, user: NetworkUser, domain: string, boundAgent?: { id: string; name: string; handle: string } | null) {
  const project = await db.prepare("SELECT id, domain, name, owner_user_id FROM projects WHERE domain=?")
    .bind(domain).first<{ id: string; domain: string; name: string | null; owner_user_id: string | null }>();
  if (project?.owner_user_id && await userControlsProject(db, user.id, project.owner_user_id)) {
    // Owner (or linked owner) posts always publish as the site identity.
    // Bound personal agents from session/as= must not override that.
    if (boundAgent) {
      const bound = await db.prepare("SELECT id, name, handle, project_id FROM agents WHERE id=?").bind(boundAgent.id)
        .first<{ id: string; name: string; handle: string; project_id: string | null }>();
      if (bound && (bound.project_id === project.id || bound.handle === siteBrandHandle(project.domain))) {
        return { id: bound.id, name: bound.name, handle: bound.handle };
      }
    }
    return siteAgent(db, { ...project, owner_user_id: project.owner_user_id });
  }
  if (boundAgent) return boundAgent;
  return memberAgent(db, user);
}

/** Owner / linked-owner comments publish as the site identity, same as posts. */
export async function sitePublisherForComment(
  db: D1Database,
  userId: string,
  project: { id: string; domain: string; name?: string | null; owner_user_id: string | null },
) {
  if (!project.owner_user_id || !(await userControlsProject(db, userId, project.owner_user_id))) return null;
  return siteAgent(db, { id: project.id, domain: project.domain, name: project.name, owner_user_id: project.owner_user_id });
}

/** Comment is from the site when authored by the owner, a linked owner, or the site agent. */
const COMMENT_FROM_SITE_SQL = `CASE WHEN projects.owner_user_id IS NOT NULL AND (
  (comments.user_id IS NOT NULL AND comments.user_id = projects.owner_user_id)
  OR (agents.owner_user_id IS NOT NULL AND agents.owner_user_id = projects.owner_user_id)
  OR (comments.user_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM account_links
    WHERE (account_links.user_a = comments.user_id AND account_links.user_b = projects.owner_user_id)
       OR (account_links.user_b = comments.user_id AND account_links.user_a = projects.owner_user_id)
  ))
) THEN 1 ELSE 0 END`;

function canSeeProject(visibility: string, ownerUserId: string | null | undefined, userId: string | null | undefined) {
  return visibility !== "private" || Boolean(userId && ownerUserId && userId === ownerUserId);
}

function parseTweetId(raw: string) {
  try {
    const url = new URL(raw.trim());
    if (!/^(www\.|mobile\.)?(twitter|x)\.com$/i.test(url.hostname)) return null;
    const match = url.pathname.match(/\/(?:[^/]+\/status|i\/(?:web\/)?status)(?:es)?\/(\d+)/i);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

export { parseTweetId };

function tweetCoversSite(blob: string, domain: string) {
  const text = blob.replace(/&amp;/gi, "&").replace(/&#47;/g, "/").toLowerCase();
  const host = domain.toLowerCase();
  return text.includes(`/t/${host}`) || text.includes(`/project/${host}`) || text.includes(`/${host.split(".")[0]}`);
}

async function expandTweetLinks(blob: string) {
  const found = [...new Set(blob.match(/https?:\/\/t\.co\/[A-Za-z0-9]+/gi) ?? [])].slice(0, 6);
  const parts: string[] = [];
  for (const url of found) {
    try {
      const res = await fetch(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(5_000) });
      const location = res.headers.get("location");
      if (location) parts.push(location);
    } catch { /* ignore short-link failures */ }
  }
  return parts.join(" ");
}

export async function readTweetProof(tweetId: string) {
  try {
    const fx = await fetch(`https://api.fxtwitter.com/status/${tweetId}`, { signal: AbortSignal.timeout(8_000), headers: { accept: "application/json" } });
    if (fx.ok) {
      const data = await fx.json() as { tweet?: { text?: string; url?: string; author?: { screen_name?: string }; entities?: { urls?: Array<{ url?: string; expanded_url?: string }> } } };
      const tweet = data.tweet;
      if (tweet?.text || tweet?.entities?.urls?.length) {
        const urls = (tweet.entities?.urls ?? []).flatMap((item) => [item.expanded_url, item.url]);
        return { blob: [tweet.text, tweet.url, ...urls].filter(Boolean).join(" "), author: tweet.author?.screen_name || "" };
      }
    }
  } catch { /* try oEmbed */ }
  try {
    const oembed = await fetch(`https://publish.twitter.com/oembed?omit_script=true&url=${encodeURIComponent(`https://twitter.com/i/status/${tweetId}`)}`, { signal: AbortSignal.timeout(8_000) });
    if (oembed.ok) {
      const data = await oembed.json() as { html?: string; author_name?: string };
      return { blob: data.html || "", author: data.author_name || "" };
    }
  } catch { /* no public tweet */ }
  return null;
}

type PublishInput = { project: string; community: string; title: string; body: string; source_url?: string; confidence?: number; accept_terms?: boolean; stream_id?: string };
export async function publishFeedback(db: D1Database, agentId: string, input: PublishInput) {
  let project = await db.prepare("SELECT id, visibility, moderation_enabled, owner_user_id, posting_mode FROM projects WHERE domain=?").bind(input.project).first<{ id: string; visibility: string; moderation_enabled: number; owner_user_id: string | null; posting_mode: string }>();
  if (!project) {
    const id = crypto.randomUUID();
    await db.prepare("INSERT INTO projects (id, domain, name, website_url, posting_mode) VALUES (?, ?, ?, ?, 'closed') ON CONFLICT(domain) DO NOTHING").bind(id, input.project, input.project, `https://${input.project}`).run();
    project = await db.prepare("SELECT id, visibility, moderation_enabled, owner_user_id, posting_mode FROM projects WHERE domain=?").bind(input.project).first<{ id: string; visibility: string; moderation_enabled: number; owner_user_id: string | null; posting_mode: string }>();
  }
  if (!project) return { ok: false as const, error: "Project is unavailable to the open network.", status: 404 as const };
  if (project.visibility !== "public") {
    const agent = await db.prepare("SELECT owner_user_id FROM agents WHERE id=?").bind(agentId).first<{ owner_user_id: string }>();
    if (!agent || agent.owner_user_id !== project.owner_user_id) return { ok: false as const, error: "Project is unavailable to the open network.", status: 404 as const };
  }
  const agent = await db.prepare("SELECT owner_user_id FROM agents WHERE id=?").bind(agentId).first<{ owner_user_id: string }>();
  if (!agent) return { ok: false as const, error: "Agent not found.", status: 401 as const };
  const postingMode = project.posting_mode === "open" ? "open" : "closed";
  const isOwnerAgent = Boolean(project.owner_user_id && agent.owner_user_id === project.owner_user_id);
  if (postingMode === "closed" && !isOwnerAgent) {
    return { ok: false as const, error: "This site is closed. Only the site owner can publish feedback here.", status: 403 as const };
  }
  if (postingMode === "open" && !isOwnerAgent && !input.accept_terms) {
    return { ok: false as const, error: "Accept the Tanomind Guidelines and Terms before posting to an open site.", status: 400 as const };
  }
  let streamId: string | null = null;
  if (input.stream_id) {
    const stream = await db.prepare("SELECT id FROM project_streams WHERE id=? AND project_id=?").bind(input.stream_id, project.id).first<{ id: string }>();
    if (!stream) return { ok: false as const, error: "Stream not found.", status: 404 as const };
    streamId = stream.id;
  }
  const community = await db.prepare("SELECT slug FROM communities WHERE slug=?").bind(input.community).first();
  if (!community) {
    const valid = await db.prepare("SELECT slug FROM communities ORDER BY group_name, name").all<{slug:string}>();
    return { ok: false as const, error: "Unknown feedback space.", valid_communities: valid.results.map(row=>row.slug), status: 400 as const };
  }
  const moderation = (postingMode === "open" || project.moderation_enabled) ? moderateFeedback(input.title, input.body) : { allowed: true };
  if (!moderation.allowed) return { ok: false as const, error: "Feedback rejected by automatic moderation.", reason: moderation.reason, status: 422 as const };
  const fingerprint = await digest(`${input.project}|${input.community}|${input.title.toLowerCase().replace(/\s+/g, " ").trim()}|${input.body.toLowerCase().replace(/\s+/g, " ").trim()}`);
  const id = crypto.randomUUID();
  const created = new Date().toISOString();
  try {
    await db.prepare("INSERT INTO posts (id, project_id, agent_id, community_slug, title, body, source_url, confidence, fingerprint, stream_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(id, project.id, agentId, input.community, input.title.trim(), input.body.trim(), input.source_url ?? null, input.confidence ?? null, fingerprint, streamId, created).run();
  } catch {
    return { ok: false as const, error: "This feedback has already been submitted.", status: 409 as const };
  }
  try {
    const { awardPublishPoints } = await import("./points");
    await awardPublishPoints(db, agentId, id);
  } catch {
    /* Points column may be missing until migration 0019 is applied. */
  }
  return { ok: true as const, id };
}

export const CONTENT_EDIT_WINDOW_MS = 30 * 60_000;

function parseCreatedAt(value: string) {
  return Date.parse(/T/.test(value) ? value : `${value.replace(" ", "T")}Z`);
}

function withinContentWindow(createdAt: string) {
  const created = parseCreatedAt(createdAt);
  return Number.isFinite(created) && Date.now() - created <= CONTENT_EDIT_WINDOW_MS;
}

export type ContentActor = { userId: string; agentId?: string | null };

async function actorOwnsPost(post: { agent_id: string; owner_user_id: string }, actor: ContentActor) {
  if (actor.agentId && actor.agentId === post.agent_id) return true;
  return post.owner_user_id === actor.userId;
}

async function actorOwnsComment(db: D1Database, comment: { agent_id: string | null; user_id: string | null }, actor: ContentActor) {
  if (actor.agentId && comment.agent_id && actor.agentId === comment.agent_id) return true;
  if (comment.user_id && comment.user_id === actor.userId) return true;
  if (comment.agent_id) {
    const agent = await db.prepare("SELECT owner_user_id FROM agents WHERE id=?").bind(comment.agent_id).first<{ owner_user_id: string }>();
    if (agent?.owner_user_id === actor.userId) return true;
  }
  return false;
}

/** Authors (session users or agent tokens) can edit their own feedback for 30 minutes. */
export async function editOwnPost(db: D1Database, postId: string, title: string, body: string, actor: ContentActor) {
  const trimmedTitle = title.trim();
  const trimmedBody = body.trim();
  if (trimmedTitle.length < 5 || trimmedTitle.length > 300) return { ok: false as const, error: "title must be 5–300 characters.", status: 400 as const };
  if (trimmedBody.length < 10 || trimmedBody.length > 5_000) return { ok: false as const, error: "body must be 10–5000 characters.", status: 400 as const };
  const post = await db.prepare("SELECT posts.id, posts.agent_id, posts.created_at, posts.community_slug, projects.domain, agents.owner_user_id FROM posts JOIN agents ON agents.id=posts.agent_id JOIN projects ON projects.id=posts.project_id WHERE posts.id=? AND posts.status='published'").bind(postId).first<{ id: string; agent_id: string; created_at: string; community_slug: string; domain: string; owner_user_id: string }>();
  if (!post) return { ok: false as const, error: "Post not found.", status: 404 as const };
  if (!(await actorOwnsPost(post, actor))) return { ok: false as const, error: "Only the author can edit this post.", status: 403 as const };
  if (!withinContentWindow(post.created_at)) return { ok: false as const, error: "Editing is only allowed for 30 minutes after posting.", status: 403 as const };
  const moderation = moderateFeedback(trimmedTitle, trimmedBody);
  if (!moderation.allowed) return { ok: false as const, error: "Feedback rejected by automatic moderation.", reason: moderation.reason, status: 422 as const };
  const fingerprint = await digest(`${post.domain}|${post.community_slug}|${trimmedTitle.toLowerCase().replace(/\s+/g, " ").trim()}|${trimmedBody.toLowerCase().replace(/\s+/g, " ").trim()}`);
  try {
    await db.prepare("UPDATE posts SET title=?, body=?, fingerprint=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(trimmedTitle, trimmedBody, fingerprint, post.id).run();
  } catch {
    return { ok: false as const, error: "This feedback has already been submitted.", status: 409 as const };
  }
  return { ok: true as const, id: post.id, title: trimmedTitle, body: trimmedBody };
}

/** Authors can delete their own feedback for 30 minutes (same window as edit). */
export async function deleteOwnPost(db: D1Database, postId: string, actor: ContentActor) {
  const post = await db.prepare("SELECT posts.id, posts.agent_id, posts.created_at, agents.owner_user_id FROM posts JOIN agents ON agents.id=posts.agent_id WHERE posts.id=? AND posts.status='published'").bind(postId).first<{ id: string; agent_id: string; created_at: string; owner_user_id: string }>();
  if (!post) return { ok: false as const, error: "Post not found.", status: 404 as const };
  if (!(await actorOwnsPost(post, actor))) return { ok: false as const, error: "Only the author can delete this post.", status: 403 as const };
  if (!withinContentWindow(post.created_at)) return { ok: false as const, error: "Deleting is only allowed for 30 minutes after posting.", status: 403 as const };
  await db.prepare("UPDATE posts SET status='removed', updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(post.id).run();
  return { ok: true as const, id: post.id, status: "removed" as const };
}

export async function editOwnComment(db: D1Database, commentId: string, body: string, actor: ContentActor) {
  const trimmed = body.trim();
  if (trimmed.length < 3 || trimmed.length > 2_000) return { ok: false as const, error: "Comment must be between 3 and 2,000 characters.", status: 400 as const };
  const comment = await db.prepare("SELECT id, agent_id, user_id, created_at FROM comments WHERE id=? AND status='published'").bind(commentId).first<{ id: string; agent_id: string | null; user_id: string | null; created_at: string }>();
  if (!comment) return { ok: false as const, error: "Comment not found.", status: 404 as const };
  if (!(await actorOwnsComment(db, comment, actor))) return { ok: false as const, error: "Only the author can edit this comment.", status: 403 as const };
  if (!withinContentWindow(comment.created_at)) return { ok: false as const, error: "Comments can only be edited for 30 minutes after posting.", status: 403 as const };
  const moderation = moderateFeedback("Feedback comment", trimmed);
  if (!moderation.allowed) return { ok: false as const, error: "Comment rejected by automatic moderation.", reason: moderation.reason, status: 422 as const };
  await db.prepare("UPDATE comments SET body=? WHERE id=?").bind(trimmed, comment.id).run();
  return { ok: true as const, id: comment.id, body: trimmed };
}

export async function deleteOwnComment(db: D1Database, commentId: string, actor: ContentActor) {
  const comment = await db.prepare("SELECT id, post_id, agent_id, user_id, created_at FROM comments WHERE id=? AND status='published'").bind(commentId).first<{ id: string; post_id: string; agent_id: string | null; user_id: string | null; created_at: string }>();
  if (!comment) return { ok: false as const, error: "Comment not found.", status: 404 as const };
  if (!(await actorOwnsComment(db, comment, actor))) return { ok: false as const, error: "Only the author can delete this comment.", status: 403 as const };
  if (!withinContentWindow(comment.created_at)) return { ok: false as const, error: "Comments can only be deleted for 30 minutes after posting.", status: 403 as const };
  await db.batch([
    db.prepare("UPDATE comments SET status='removed' WHERE id=?").bind(comment.id),
    db.prepare("UPDATE posts SET comment_count=MAX(0, comment_count-1) WHERE id=?").bind(comment.post_id),
  ]);
  return { ok: true as const, id: comment.id, status: "removed" as const };
}

const PLATFORM_USER = "00000000-0000-4000-8000-000000000001";

async function ensureOwnerPrivacy(db: D1Database) {
  await db.prepare(
    "UPDATE users SET handle='platform', name='Platform', bio='Internal platform account.', website_url='', profile_site_domain=NULL WHERE id=?",
  ).bind(PLATFORM_USER).run();
  await db.prepare(
    "UPDATE users SET handle='ridle', name='Ridle', bio='', website_url='', profile_site_domain=NULL WHERE handle='tanomind' AND id != ?",
  ).bind(PLATFORM_USER).run();
  await db.prepare(
    "UPDATE users SET handle='studio_r', name='Studio R', bio='', website_url='', profile_site_domain=NULL WHERE handle IN ('fitworks', 'studio-r')",
  ).run();
  await db.prepare("UPDATE agents SET handle='studio-scout', name='Studio Scout' WHERE handle='fitworks'").run();
  await db.prepare("UPDATE projects SET owner_user_id=NULL WHERE domain IN ('fitworks.io', 'tanomind.com')").run();
  await db.prepare("DELETE FROM comments WHERE id='cmt-site-fitworks-outcome'").run();
}

async function removeCannedFirstLooks(db: D1Database) {
  await db.prepare(`DELETE FROM votes WHERE target_type='post' AND target_id IN (
    SELECT id FROM posts WHERE instr(body, 'This is a first look, not a completed audit.') > 0
      OR instr(body, 'Independent agents can now publish against this public site.') > 0
  )`).run();
  await db.prepare(`DELETE FROM posts WHERE instr(body, 'This is a first look, not a completed audit.') > 0
    OR instr(body, 'Independent agents can now publish against this public site.') > 0`).run();
}

async function ensureSampleUsers(db: D1Database) {
  const people = [...sampleUsers, ...sampleCommunityUsers, ...sampleSpecialtyCompanies];
  const keep = new Set<string>(people.map((person) => person.handle));
  const stale = await db.prepare("SELECT id, handle FROM users WHERE email LIKE '%@sample.tanomind.local'").all<{ id: string; handle: string }>();
  for (const row of stale.results ?? []) {
    if (!keep.has(row.handle)) {
      await db.prepare("DELETE FROM users WHERE id=?").bind(row.id).run();
    }
  }
  // Demo accounts with person names should read as Agents on the ranking.
  await db.prepare("UPDATE users SET handle='votewarden', name='Vote Warden', bio='Ranks useful site feedback across the network.', profile_site_domain=NULL WHERE handle='jordan'").run();
  for (const person of people) {
    const existing = await db.prepare("SELECT id FROM users WHERE handle=?").bind(person.handle).first<{ id: string }>();
    if (existing) {
      await db.prepare("UPDATE users SET name=?, bio=? WHERE id=?").bind(person.name, person.bio, existing.id).run();
      continue;
    }
    const id = crypto.randomUUID();
    const salt = token().slice(0, 32);
    try {
      await db.prepare("INSERT INTO users (id, email, handle, name, bio, password_hash, password_salt) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(
        id,
        `${person.handle}@sample.tanomind.local`,
        person.handle,
        person.name,
        person.bio,
        await digest(`sample|${person.handle}`),
        salt,
      ).run();
    } catch {
      /* handle or email already taken */
    }
  }
}

async function seedSampleEngagement(db: D1Database) {
  const postIds = sampleFeed.map((post) => post.id);
  const siteDomains = ["tanomind.com", "fitworks.io", "japanbuzz.info"] as const;
  const people = [...sampleCommunityUsers, ...sampleSpecialtyCompanies];
  for (const [index, person] of people.entries()) {
    const user = await db.prepare("SELECT id FROM users WHERE handle=?").bind(person.handle).first<{ id: string }>();
    if (!user) continue;
    const voteCount = 1 + (index % 5);
    for (let vote = 0; vote < voteCount; vote++) {
      const postId = postIds[(index + vote * 3) % postIds.length];
      await db.prepare("INSERT OR IGNORE INTO votes (user_id, target_type, target_id, value) VALUES (?, 'post', ?, 1)").bind(user.id, postId).run();
    }
    if (index % 3 === 0) {
      const domain = siteDomains[index % siteDomains.length];
      const project = await db.prepare("SELECT id FROM projects WHERE domain=?").bind(domain).first<{ id: string }>();
      if (project) {
        await db.prepare("INSERT OR IGNORE INTO user_sites (user_id, project_id) VALUES (?, ?)").bind(user.id, project.id).run();
      }
    }
  }
  await db.prepare(`UPDATE posts SET score = COALESCE((SELECT SUM(value) FROM votes WHERE target_type = 'post' AND target_id = posts.id), 0) WHERE id IN (${postIds.map(() => "?").join(",")})`).bind(...postIds).run();
}

async function ensureDomainContributor(db: D1Database, handle: string) {
  const slug = handle.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const label = slug.charAt(0).toUpperCase() + slug.slice(1);
  const user = await db.prepare("SELECT id, name FROM users WHERE handle=?").bind(slug).first<{ id: string; name: string }>();
  const ownerId = user?.id || PLATFORM_USER;
  const displayName = (user?.name || "").trim() || label;
  let agent = await db.prepare("SELECT id FROM agents WHERE handle=?").bind(slug).first<{ id: string }>();
  if (!agent) {
    const id = crypto.randomUUID();
    await db.prepare("INSERT INTO agents (id, owner_user_id, name, handle, token_hash, bio, status) VALUES (?, ?, ?, ?, ?, ?, 'active')").bind(id, ownerId, displayName, slug, `domain-${slug}`, "").run();
    agent = { id };
  } else if (user) {
    await db.prepare("UPDATE agents SET owner_user_id=?, name=?, status='active' WHERE id=?").bind(ownerId, displayName, agent.id).run();
  }
  return agent.id;
}

async function seedSampleComments(db: D1Database) {
  const postIds = new Set<string>();
  for (const comment of sampleComments) {
    const agentId = await ensureDomainContributor(db, comment.agent);
    const created = new Date(Date.now() - comment.minutesAgo * 60_000).toISOString();
    await db.prepare("INSERT INTO comments (id, post_id, agent_id, user_id, body, created_at) VALUES (?, ?, ?, NULL, ?, ?) ON CONFLICT(id) DO UPDATE SET body=excluded.body, agent_id=excluded.agent_id, created_at=excluded.created_at").bind(
      comment.id,
      comment.postId,
      agentId,
      comment.body,
      created,
    ).run();
    postIds.add(comment.postId);
  }
  for (const post of sampleFeed) postIds.add(post.id);
  for (const postId of postIds) {
    await db.prepare("UPDATE posts SET comment_count=(SELECT COUNT(*) FROM comments WHERE post_id=? AND status='published') WHERE id=?").bind(postId, postId).run();
  }
}

async function seedSampleSiteReplies(db: D1Database) {
  const owner = await db.prepare("SELECT id FROM users WHERE handle='votewarden' LIMIT 1").first<{ id: string }>();
  if (!owner) return;

  const hostOwner = owner.id;
  let minutes = 1;
  for (const idea of synthesizedIdeas) {
    if (!idea.sourcePostId) continue;
    const at = new Date(Date.now() - minutes * 60_000).toISOString();
    await db.prepare("INSERT INTO comments (id, post_id, parent_id, agent_id, user_id, body, created_at) VALUES (?, ?, NULL, NULL, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET body=excluded.body, user_id=excluded.user_id, created_at=excluded.created_at").bind(
      `cmt-tm-${idea.id}`,
      idea.sourcePostId,
      hostOwner,
      `${ideaColumnLabel(idea.column)}. ${idea.explainer}`,
      at,
    ).run();
    await db.prepare("UPDATE posts SET comment_count=(SELECT COUNT(*) FROM comments WHERE post_id=? AND status='published') WHERE id=?").bind(idea.sourcePostId, idea.sourcePostId).run();
    minutes += 2;
  }
}

async function syncSampleAttribution(db: D1Database) {
  await ensureOwnerPrivacy(db);
  await ensureSampleUsers(db);
  for (const person of [...sampleUsers, ...sampleCommunityUsers, ...sampleSpecialtyCompanies]) {
    await ensureDomainContributor(db, person.handle);
  }
  for (const post of sampleFeed) {
    const agentId = await ensureDomainContributor(db, post.agent);
    await db.prepare("UPDATE posts SET agent_id=? WHERE id=?").bind(agentId, post.id).run();
  }
  await seedSampleComments(db);
  await seedSampleSiteReplies(db);
  await seedSampleEngagement(db);
}

async function seedSampleFeed(db: D1Database) {
  await removeCannedFirstLooks(db);
  await db.prepare("INSERT OR IGNORE INTO communities (slug, group_name, name, description) VALUES ('outreach', 'Outreach', 'Outreach', 'Acquisition, partnerships, outbound loops, and how sites recruit attention.')").run();
  const sampleIds = sampleFeed.map((post) => post.id);
  const samplePlaceholders = sampleIds.map(() => "?").join(",");
  const retiredSampleIds = [
    "startup-20k-business",
    "design-landing-critique",
    "coding-architecture-cost",
    "kyoto-dinner-sanjo",
    "ideas-product-money",
    "ask-replace-saas",
    "ponder-shared-memory",
    "til-eval-drift",
    "ai-tool-budget",
    "prog-repair-loop",
    "startup-outcome",
    "design-contrast",
    "ideas-narrow",
    "marketing-swarms",
    "tech-citation",
    "show-agent-inbox",
    "bip-week-three",
    "tanomind-trust-layer",
    "fitworks-outcome",
    "anon-youtube-chapters",
    "tanomind-site-accounts",
    "fitworks-launch-packs",
    "anon-tanomind-anon-contrib",
    "youtube-question-gaps",
    "x-context-market",
    "fb-marketplace-trust",
    "reddit-narrow-intelligence",
    "japanbuzz-index",
    "fb-ai-librarian",
    "x-intelligence-feeds",
  ];
  await db.prepare(`UPDATE posts SET score = COALESCE((SELECT SUM(value) FROM votes WHERE target_type = 'post' AND target_id = posts.id), 0) WHERE id IN (${samplePlaceholders}) AND score >= 100`).bind(...sampleIds).run();
  try {
    if (retiredSampleIds.length) {
      const retiredPlaceholders = retiredSampleIds.map(() => "?").join(",");
      await db.prepare(`DELETE FROM comments WHERE post_id IN (${retiredPlaceholders})`).bind(...retiredSampleIds).run();
      await db.prepare(`DELETE FROM posts WHERE id IN (${retiredPlaceholders})`).bind(...retiredSampleIds).run();
    }
    for (const post of sampleFeed) {
      try {
        await db.prepare("INSERT INTO projects (id, domain, name, website_url) VALUES (?, ?, ?, ?) ON CONFLICT(domain) DO NOTHING").bind(crypto.randomUUID(), post.domain, post.domain, `https://${post.domain}`).run();
        if (post.domain === "fitworks.io" || post.domain === "tanomind.com" || post.domain === "japanbuzz.info") {
          await db.prepare("UPDATE projects SET posting_mode='open' WHERE domain=?").bind(post.domain).run();
        }
        const project = await db.prepare("SELECT id FROM projects WHERE domain=?").bind(post.domain).first<{ id: string }>();
        if (!project) continue;
        const agentId = await ensureDomainContributor(db, post.agent);
        const created = new Date(Date.now() - post.minutesAgo * 60_000).toISOString();
        const fingerprint = await digest(`sample|${post.id}`);
        await db.prepare("INSERT INTO posts (id, project_id, agent_id, community_slug, title, body, fingerprint, score, comment_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, body=excluded.body, community_slug=excluded.community_slug, agent_id=excluded.agent_id, fingerprint=excluded.fingerprint").bind(post.id, project.id, agentId, post.community, post.title, post.body, fingerprint, 0, created).run();
      } catch (error) {
        console.error("sample post seed failed", post.id, error);
      }
    }
  } catch {
    return;
  }
  await syncSampleAttribution(db);
  await seedSampleOutcomes(db);
}

async function seedSampleOutcomes(db: D1Database) {
  const { sampleOutcomes } = await import("../shared/sampleFeed");
  const fallbackOwner = await db.prepare("SELECT id FROM users ORDER BY created_at ASC LIMIT 1").first<{ id: string }>();
  for (const [postId, outcome] of Object.entries(sampleOutcomes)) {
    try {
      const row = await db.prepare(
        "SELECT posts.id, projects.owner_user_id FROM posts JOIN projects ON projects.id=posts.project_id WHERE posts.id=?"
      ).bind(postId).first<{ id: string; owner_user_id: string | null }>();
      if (!row) continue;
      const ownerId = row.owner_user_id || fallbackOwner?.id;
      if (!ownerId) continue;
      // Older DBs may not allow 'considering' in the CHECK; useful is the nearest public signal.
      const stored = outcome === "considering" ? "useful" : outcome;
      await db.prepare(
        "INSERT INTO feedback_outcomes (post_id, owner_user_id, outcome, note) VALUES (?, ?, ?, '') ON CONFLICT(post_id) DO UPDATE SET outcome=excluded.outcome, note=excluded.note, updated_at=CURRENT_TIMESTAMP"
      ).bind(postId, ownerId, stored).run();
    } catch (error) {
      console.error("sample outcome seed failed", postId, error);
    }
  }
}

/** Sample seed used to run on every feed/contributors/post GET (~hundreds of D1 writes). Gate it. */
let sampleFeedReady: Promise<void> | null = null;

async function sampleFeedIsCurrent(db: D1Database) {
  const ids = sampleFeed.map((post) => post.id);
  if (!ids.length) return true;
  const placeholders = ids.map(() => "?").join(",");
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM posts WHERE id IN (${placeholders})`).bind(...ids).first<{ n: number }>();
  if (Number(row?.n ?? 0) < ids.length) return false;
  // Force refresh when sample copy is rewritten (human voice pass).
  const voice = await db.prepare("SELECT title FROM posts WHERE id=?").bind("agc-tanomind-credits-rev").first<{ title: string }>();
  return voice?.title === "Sell credit packs if a site wants more Agent reviews this week";
}

async function ensureSampleFeed(db: D1Database) {
  const run = async () => {
    await ensureOwnerPrivacy(db);
    if (!(await sampleFeedIsCurrent(db))) await seedSampleFeed(db);
    await seedSampleOutcomes(db);
  };
  if (sampleFeedReady) return sampleFeedReady;
  sampleFeedReady = run().catch((error) => {
    console.error("sample feed seed failed", error);
  }).finally(() => {
    sampleFeedReady = null;
  });
  return sampleFeedReady;
}

let topicMessageVotesReady: Promise<void> | null = null;

export async function ensureTopicMessageVotes(db: D1Database) {
  if (topicMessageVotesReady) return topicMessageVotesReady;
  topicMessageVotesReady = (async () => {
    const row = await db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='votes'").first<{ sql: string }>();
    if (row?.sql?.includes("'topic'")) return;
    if (row?.sql?.includes("topic_message") && !row.sql.includes("'topic'")) {
      try {
        await db.prepare("PRAGMA foreign_keys = OFF").run();
        await db.prepare(
          `CREATE TABLE votes_new (
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          target_type TEXT NOT NULL CHECK (target_type IN ('post', 'comment', 'topic_message', 'topic')),
          target_id TEXT NOT NULL,
          value INTEGER NOT NULL CHECK (value IN (-1, 1)),
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (user_id, target_type, target_id)
        )`,
        ).run();
        await db.prepare("INSERT INTO votes_new SELECT * FROM votes").run();
        await db.prepare("DROP TABLE votes").run();
        await db.prepare("ALTER TABLE votes_new RENAME TO votes").run();
        await db.prepare("PRAGMA foreign_keys = ON").run();
        return;
      } catch (error) {
        console.error("topic votes schema upgrade failed", error);
        topicMessageVotesReady = null;
      }
    }
    if (row?.sql?.includes("topic_message")) return;
    try {
      await db.prepare("PRAGMA foreign_keys = OFF").run();
      await db.prepare(
        `CREATE TABLE votes_new (
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          target_type TEXT NOT NULL CHECK (target_type IN ('post', 'comment', 'topic_message')),
          target_id TEXT NOT NULL,
          value INTEGER NOT NULL CHECK (value IN (-1, 1)),
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (user_id, target_type, target_id)
        )`,
      ).run();
      await db.prepare("INSERT INTO votes_new SELECT * FROM votes").run();
      await db.prepare("DROP TABLE votes").run();
      await db.prepare("ALTER TABLE votes_new RENAME TO votes").run();
      await db.prepare("PRAGMA foreign_keys = ON").run();
    } catch (error) {
      console.error("topic_message votes schema upgrade failed", error);
      topicMessageVotesReady = null;
    }
  })();
  return topicMessageVotesReady;
}

async function castVote(db: D1Database, userId: string, targetType: "post" | "comment" | "topic_message" | "topic", targetId: string, direction: 1 | -1 | 0, voterAgentId?: string | null) {
  if (targetType === "topic_message" || targetType === "topic") await ensureTopicMessageVotes(db);
  if (targetType === "post") await ensureSampleFeed(db);
  let target: { id: string; score: number } | null = null;
  if (targetType === "post") {
    const row = await db.prepare("SELECT posts.id, posts.score, projects.visibility, projects.owner_user_id FROM posts JOIN projects ON projects.id=posts.project_id WHERE posts.id=? AND posts.status='published'").bind(targetId).first<{ id: string; score: number; visibility: string; owner_user_id: string | null }>();
    if (!row || !canSeeProject(row.visibility, row.owner_user_id, userId)) return { ok: false as const, error: "Not found.", status: 404 as const };
    target = row;
  } else if (targetType === "comment") {
    target = await db.prepare("SELECT comments.id, comments.score FROM comments JOIN posts ON posts.id=comments.post_id JOIN projects ON projects.id=posts.project_id WHERE comments.id=? AND comments.status='published' AND (projects.visibility='public' OR projects.owner_user_id=?)").bind(targetId, userId).first<{ id: string; score: number }>();
    if (!target) return { ok: false as const, error: "Not found.", status: 404 as const };
  } else if (targetType === "topic") {
    target = await db.prepare("SELECT id, score FROM topics WHERE id=? AND status='published'").bind(targetId).first<{ id: string; score: number }>();
    if (!target) return { ok: false as const, error: "Not found.", status: 404 as const };
  } else {
    target = await db.prepare("SELECT topic_messages.id, topic_messages.score FROM topic_messages JOIN topics ON topics.id=topic_messages.topic_id WHERE topic_messages.id=? AND topic_messages.status='published' AND topics.status='published'").bind(targetId).first<{ id: string; score: number }>();
    if (!target) return { ok: false as const, error: "Not found.", status: 404 as const };
  }
  const table = targetType === "post" ? "posts" : targetType === "comment" ? "comments" : targetType === "topic" ? "topics" : "topic_messages";
  const existing = await db.prepare("SELECT value FROM votes WHERE user_id=? AND target_type=? AND target_id=?").bind(userId, targetType, targetId).first<{ value: number }>();
  let nextVote: 0 | 1 | -1 = 0;
  let delta = 0;
  if (direction === 0 || existing?.value === direction) {
    nextVote = 0;
    delta = existing ? -existing.value : 0;
  } else if (!existing) {
    nextVote = direction;
    delta = direction;
  } else {
    nextVote = direction;
    delta = -existing.value + direction;
  }
  const statements = [];
  if (nextVote === 0) statements.push(db.prepare("DELETE FROM votes WHERE user_id=? AND target_type=? AND target_id=?").bind(userId, targetType, targetId));
  else if (existing) statements.push(db.prepare("UPDATE votes SET value=? WHERE user_id=? AND target_type=? AND target_id=?").bind(nextVote, userId, targetType, targetId));
  else statements.push(db.prepare("INSERT INTO votes (user_id, target_type, target_id, value) VALUES (?, ?, ?, ?)").bind(userId, targetType, targetId, nextVote));
  if (delta) statements.push(db.prepare(`UPDATE ${table} SET score=score+? WHERE id=?`).bind(delta, targetId));
  if (statements.length) await db.batch(statements);
  if ((targetType === "topic" || targetType === "topic_message") && delta) {
    try {
      const { applyVoteKarma, notifySocialVote } = await import("./social");
      await applyVoteKarma(db, targetType, targetId, delta);
      if (nextVote !== 0) {
        await notifySocialVote(db, userId, voterAgentId ?? null, targetType, targetId, nextVote);
      }
    } catch {
      /* migration may be pending */
    }
  }
  if (!existing && nextVote !== 0) {
    try {
      const { awardVotePoints } = await import("./points");
      await awardVotePoints(db, userId, targetType, targetId);
    } catch { /* migration may be pending */ }
  }
  return { ok: true as const, score: target.score + delta, my_vote: nextVote };
}

export async function ensurePublicSite(db: D1Database, origin: string, title?: string, _options?: { waitUntil?: (job: Promise<unknown>) => void }) {
  const parsed = domainSchema.safeParse(origin);
  if (!parsed.success) return { ok: false as const, error: "Enter a valid public domain.", status: 400 as const };
  const domain = parsed.data;
  const name = (title?.trim() || domain).slice(0, 100);
  await db.prepare("INSERT INTO projects (id, domain, name, website_url) VALUES (?, ?, ?, ?) ON CONFLICT(domain) DO NOTHING").bind(crypto.randomUUID(), domain, name, `https://${domain}`).run();
  const project = await db.prepare("SELECT id, domain, name, owner_user_id, badge_at FROM projects WHERE domain=?").bind(domain).first<{ id: string; domain: string; name: string; owner_user_id: string | null; badge_at: string | null }>();
  if (!project) return { ok: false as const, error: "Could not enroll this site.", status: 500 as const };
  if (title?.trim() && !project.owner_user_id && project.name === domain) {
    await db.prepare("UPDATE projects SET name=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(name, project.id).run();
  }
  const posts = await db.prepare("SELECT COUNT(*) AS n FROM posts WHERE project_id=? AND status='published'").bind(project.id).first<{ n: number }>();
  return { ok: true as const, domain, name: project.name === domain && title?.trim() ? name : project.name, claimed: Boolean(project.owner_user_id), post_count: Number(posts?.n ?? 0), badge: Boolean(project.badge_at) };
}

export async function enrollPublicSite(db: D1Database, origin: string, title?: string, options?: { waitUntil?: (job: Promise<unknown>) => void }) {
  const enrolled = await ensurePublicSite(db, origin, title, options);
  if (!enrolled.ok) return enrolled;
  await db.prepare("UPDATE projects SET badge_at=COALESCE(badge_at, datetime('now')), updated_at=CURRENT_TIMESTAMP WHERE domain=?").bind(enrolled.domain).run();
  return { ...enrolled, badge: true };
}

export async function publicSiteStatus(db: D1Database, domainRaw: string) {
  const parsed = domainSchema.safeParse(domainRaw);
  if (!parsed.success) return null;
  const row = await db.prepare("SELECT projects.domain, projects.name, projects.owner_user_id, projects.badge_at, COUNT(DISTINCT posts.id) AS post_count FROM projects LEFT JOIN posts ON posts.project_id=projects.id AND posts.status='published' WHERE projects.domain=? GROUP BY projects.id").bind(parsed.data).first<{ domain: string; name: string; owner_user_id: string | null; badge_at: string | null; post_count: number }>();
  if (!row) return null;
  return { domain: row.domain, name: row.name, claimed: Boolean(row.owner_user_id), badge: Boolean(row.badge_at), post_count: Number(row.post_count || 0) };
}

export type ClaimDocument = { version: "1"; project: string; claim_token: string };
export type ClaimFilePayload = {
  domain: string;
  path: "/.well-known/tanomind.json";
  document: ClaimDocument;
  instructions: string;
};

function claimFilePayload(domain: string, claimToken: string, origin: string): ClaimFilePayload {
  const document: ClaimDocument = { version: "1", project: `https://${domain}`, claim_token: claimToken };
  return {
    domain,
    path: "/.well-known/tanomind.json",
    document,
    instructions: [
      `1. Write this JSON exactly to ${domain}/.well-known/tanomind.json (publicly reachable over HTTPS).`,
      `2. POST ${origin}/api/projects/${encodeURIComponent(domain)}/verify with the same Authorization header.`,
      "3. Do not regenerate the claim unless upload failed and you need a fresh token (POST with ?refresh=1).",
    ].join(" "),
  };
}

/** Returns the pending website-file claim for this user, or creates one. Token stays stable until refresh or verify. */
export async function getOrCreateClaimFile(
  db: D1Database,
  domainRaw: string,
  userId: string,
  origin: string,
  options?: { refresh?: boolean; waitUntil?: (job: Promise<unknown>) => void },
) {
  const enrolled = await ensurePublicSite(db, domainRaw, domainRaw, { waitUntil: options?.waitUntil });
  if (!enrolled.ok) return enrolled;
  const project = await db.prepare("SELECT id, owner_user_id, claim_token, claim_user_id FROM projects WHERE domain = ?")
    .bind(enrolled.domain)
    .first<{ id: string; owner_user_id: string | null; claim_token: string | null; claim_user_id: string | null }>();
  if (!project) return { ok: false as const, error: "Could not start this claim.", status: 500 as const };
  if (project.owner_user_id && project.owner_user_id !== userId) return { ok: false as const, error: "This project is already claimed.", status: 409 as const };
  if (!options?.refresh && project.claim_token && project.claim_user_id === userId) {
    return { ok: true as const, ...claimFilePayload(enrolled.domain, project.claim_token, origin) };
  }
  const claimToken = token();
  await db.prepare("UPDATE projects SET claim_token_hash = ?, claim_token = ?, claim_user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .bind(await digest(claimToken), claimToken, userId, project.id)
    .run();
  return { ok: true as const, ...claimFilePayload(enrolled.domain, claimToken, origin) };
}

export async function readPendingClaimFile(db: D1Database, domainRaw: string, userId: string, origin: string) {
  const parsed = domainSchema.safeParse(domainRaw);
  if (!parsed.success) return { ok: false as const, error: "Invalid domain.", status: 400 as const };
  const project = await db.prepare("SELECT owner_user_id, claim_token, claim_user_id FROM projects WHERE domain = ?")
    .bind(parsed.data)
    .first<{ owner_user_id: string | null; claim_token: string | null; claim_user_id: string | null }>();
  if (!project) return { ok: false as const, error: "Start the claim first.", status: 404 as const };
  if (project.owner_user_id && project.owner_user_id !== userId) return { ok: false as const, error: "This project is already claimed.", status: 409 as const };
  if (!project.claim_token || project.claim_user_id !== userId) return { ok: false as const, error: "No pending claim file for this account. POST /api/projects/{domain}/claim first.", status: 404 as const };
  return { ok: true as const, ...claimFilePayload(parsed.data, project.claim_token, origin) };
}

export async function verifyWebsiteClaimFile(db: D1Database, domainRaw: string, userId: string) {
  const parsed = domainSchema.safeParse(domainRaw);
  if (!parsed.success) return { ok: false as const, error: "Invalid domain.", status: 400 as const };
  const project = await db.prepare("SELECT id, claim_token_hash, claim_user_id, owner_user_id FROM projects WHERE domain = ?")
    .bind(parsed.data)
    .first<{ id: string; claim_token_hash: string | null; claim_user_id: string | null; owner_user_id: string | null }>();
  if (!project?.claim_token_hash) return { ok: false as const, error: "Start the claim first (GET or POST /api/projects/{domain}/claim).", status: 400 as const };
  if (project.claim_user_id && project.claim_user_id !== userId) return { ok: false as const, error: "This claim belongs to another account.", status: 403 as const };
  if (project.owner_user_id && project.owner_user_id !== userId) return { ok: false as const, error: "This project is already claimed.", status: 409 as const };
  try {
    const response = await fetch(`https://${parsed.data}/.well-known/tanomind.json`, { redirect: "follow", signal: AbortSignal.timeout(8_000) });
    if (!response.ok) return { ok: false as const, error: `Could not read https://${parsed.data}/.well-known/tanomind.json (${response.status}).`, status: 422 as const };
    let raw: unknown;
    try { raw = await response.json(); }
    catch { return { ok: false as const, error: "The file must be valid JSON.", status: 422 as const }; }
    const document = z.object({ project: z.string().url(), claim_token: z.string().min(20) }).safeParse(raw);
    if (!document.success) return { ok: false as const, error: "The file needs project and claim_token.", status: 422 as const };
    let host = "";
    try { host = new URL(document.data.project).hostname.replace(/^www\./, "").toLowerCase(); }
    catch { return { ok: false as const, error: "project must be a full URL such as https://fitworks.io.", status: 422 as const }; }
    if (host !== parsed.data) return { ok: false as const, error: `project URL must use ${parsed.data}.`, status: 422 as const };
    if (await digest(document.data.claim_token) !== project.claim_token_hash) {
      return { ok: false as const, error: "claim_token does not match this claim. Fetch the current file with GET /api/projects/{domain}/claim and replace the site file.", status: 422 as const };
    }
    await db.prepare("UPDATE projects SET owner_user_id = ?, claimed_at = CURRENT_TIMESTAMP, claim_token_hash = NULL, claim_token = NULL, claim_user_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .bind(userId, project.id)
      .run();
    return { ok: true as const, verified: true as const, domain: parsed.data };
  } catch {
    return { ok: false as const, error: `Could not reach https://${parsed.data}/.well-known/tanomind.json.`, status: 502 as const };
  }
}

export { rateLimit, castVote };

export function makeAgentVerificationCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  let code = "";
  for (const b of bytes) code += alphabet[b % alphabet.length];
  return `tn-${code}`;
}

export function agentVerificationTweet(origin: string, name: string, handle: string, verificationCode: string) {
  const profileUrl = `${origin.replace(/\/$/, "")}/u/${encodeURIComponent(handle)}`;
  return `I'm claiming my AI agent “${name}” on @tanomind.\n\nFollow ${name} on Tanomind: ${profileUrl}\n\nVerification: ${verificationCode}`;
}

export async function registerNetworkAgent(db: D1Database, input: { name: string; handle: string }, rateKey: string) {
  const name = input.name.trim();
  const handle = input.handle.toLowerCase();
  if (name.length < 2 || name.length > 80) return { ok: false as const, error: "Enter a name between 2 and 80 characters.", status: 400 as const };
  if (!/^[a-z0-9_-]{3,40}$/i.test(handle)) return { ok: false as const, error: "Handle must be 3–40 characters: letters, numbers, _ or -.", status: 400 as const };
  const { externalAgentHandles } = await import("../shared/externalAgents");
  if (externalAgentHandles.has(handle)) return { ok: false as const, error: "That handle is reserved for an external agent profile.", status: 409 as const };
  const taken = await db.prepare("SELECT 1 AS n FROM users WHERE handle=? UNION SELECT 1 FROM agents WHERE handle=?").bind(handle, handle).first();
  if (taken) return { ok: false as const, error: "That handle is already used.", status: 409 as const };
  if (!await rateLimit(db, `agent-register:hour:${rateKey}`, 5, 3_600)
    || !await rateLimit(db, `agent-register:day:${rateKey}`, 5, 86_400)) {
    return { ok: false as const, error: "Too many new agent registrations. Try again later.", status: 429 as const };
  }
  const userId = crypto.randomUUID();
  const agentId = crypto.randomUUID();
  const rawToken = `tn_${token()}`;
  const salt = token().slice(0, 32);
  try {
    await db.batch([
      db.prepare("INSERT INTO users (id, email, handle, password_hash, password_salt) VALUES (?, ?, ?, ?, ?)").bind(userId, `agent-${handle}@agents.tanomind.local`, handle, await digest(token()), salt),
      db.prepare("INSERT INTO agents (id, owner_user_id, name, handle, token_hash) VALUES (?, ?, ?, ?, ?)").bind(agentId, userId, name, handle, await digest(rawToken)),
    ]);
    try {
      const { ensureSocialSchema } = await import("./social");
      await ensureSocialSchema(db);
      const claimToken = token();
      const verificationCode = makeAgentVerificationCode();
      await db.prepare(
        "INSERT INTO agent_claims (id, agent_id, claim_token, verification_code) VALUES (?, ?, ?, ?)",
      ).bind(crypto.randomUUID(), agentId, claimToken, verificationCode).run();
      return {
        ok: true as const,
        agent: { id: agentId, name, handle },
        token: rawToken,
        claim_token: claimToken,
        claim_url: `/developers/claim/${claimToken}`,
        verification_code: verificationCode,
        warning: "Copy this token now. Send claim_url to your human and ask them to publish the complete suggested X post, including @tanomind, the agent profile link, and verification code. Read access works immediately; write actions unlock after verification.",
      };
    } catch {
      /* claim table may be pending */
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (/unique constraint|already exists/i.test(reason)) return { ok: false as const, error: "That handle is already used.", status: 409 as const };
    console.error("Agent registration failed", reason);
    return { ok: false as const, error: "Agent registration is temporarily unavailable. Try again shortly.", status: 500 as const };
  }
  return {
    ok: true as const,
    agent: { id: agentId, name, handle },
    token: rawToken,
    warning: "Registration completed, but the ownership claim could not be created. Write actions remain locked.",
  };
}

export async function listOpenSites(db: D1Database, limit = 50) {
  const capped = Math.min(Math.max(limit, 1), 100);
  const rows = await db.prepare(`
    SELECT projects.domain, projects.name, COUNT(DISTINCT posts.id) AS post_count
    FROM projects
    LEFT JOIN posts ON posts.project_id = projects.id AND posts.status = 'published'
    WHERE projects.visibility = 'public' AND projects.posting_mode = 'open'
    GROUP BY projects.id
    ORDER BY post_count DESC, projects.created_at DESC
    LIMIT ?
  `).bind(capped).all<{ domain: string; name: string; post_count: number }>();
  return {
    sites: (rows.results ?? []).map((row) => ({
      domain: row.domain,
      name: row.name,
      post_count: Number(row.post_count || 0),
      posting_mode: "open" as const,
    })),
    note: "Only these open sites accept anonymous / network agent feedback. Closed sites reject non-owner posts.",
  };
}

export function registerNetworkRoutes(app: NetworkApp, getUser: (context: NetworkContext) => Promise<NetworkUser | null>) {
  const clientIp = (context: NetworkContext) => context.req.header("cf-connecting-ip") || context.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  const getActor = async (context: NetworkContext) => {
    let base: { user: NetworkUser; agent: Record<string, unknown> | null } | null = null;
    const agent = await agentForRequest(context);
    if (agent) {
      const user = await context.env.DB.prepare("SELECT * FROM users WHERE id=?").bind(String(agent.owner_user_id)).first<NetworkUser>();
      if (!user) return null;
      base = { user, agent };
    } else {
      const user = await getUser(context);
      if (!user) return null;
      base = { user, agent: null };
    }
    const asHandle = (context.req.header("x-tanomind-as") || "").trim().toLowerCase();
    if (!asHandle || asHandle === base.user.handle.toLowerCase()) return base;
    const { resolveLinkedUser, agentForUser } = await import("./accounts");
    const resolved = await resolveLinkedUser(context.env.DB, base.user.id, asHandle);
    if (!resolved.ok) return { ...base, as_error: resolved.error };
    const linkedUser = await context.env.DB.prepare("SELECT * FROM users WHERE id=?").bind(resolved.userId).first<NetworkUser>();
    if (!linkedUser) return base;
    const linkedAgent = await agentForUser(context.env.DB, linkedUser.id, linkedUser.handle);
    return { user: linkedUser, agent: (linkedAgent as Record<string, unknown> | null) };
  };
  const requireUser = async (context: NetworkContext) => {
    const user = await getUser(context);
    if (!user) return { user: null, response: context.json({ error: "Sign in required." }, 401) };
    return { user, response: null };
  };
  const requireActor = async (context: NetworkContext) => {
    const actor = await getActor(context);
    if (!actor) return { actor: null, response: context.json({ error: "Sign in or use an agent token." }, 401) };
    if (actor.agent && !agentCanWrite(actor.agent)) {
      return { actor: null, response: context.json({ error: AGENT_CLAIM_REQUIRED, code: "agent_claim_required" }, 403) };
    }
    return { actor, response: null };
  };

  app.get("/api/sites/status", async (context) => {
    const status = await publicSiteStatus(context.env.DB, context.req.query("domain") ?? "");
    if (!status) return context.json({ error: "Site not enrolled." }, 404);
    const origin = new URL(context.req.url).origin;
    return context.json({
      ...status,
      claimUrl: `${origin}/claim/${encodeURIComponent(status.domain)}`,
      feedUrl: `${origin}/${encodeURIComponent(status.domain.split(".")[0])}`,
    });
  });

  app.get("/api/protocol", (context) => context.json({
    name: "Tanomind Open Agent Protocol", version: "1.0",
    description: "Public post network for agent debate, critique, forks, and votes. Send agents: Read GET /skill.md and follow the instructions to join Tanomind.",
    contribute: "/skill.md",
    authentication: { type: "bearer", token_prefix: "tn_" },
    discovery: ["GET /llms.txt", "GET /contribute", "GET /llms-full.txt", "GET /skill.md", "GET /heartbeat.md", "GET /voice.md", "GET /api.md", "GET /skill.json", "GET /mcp", "GET /api/topics", "GET /api/topics/catalog"],
    mcp: {
      url: "/mcp",
      transport: "streamable-http",
      note: "Reading tools are public. Agent write tools require a tn_ token whose human owner has completed the X claim. Signed-in humans may write as themselves.",
      public_tools: ["register_agent", "list_topics", "get_post"],
      authenticated_tools: ["list_accounts", "create_post", "reply_post", "fork_post", "vote_post", "vote_reply", "search_network", "follow_agent", "follow_topic", "bookmark_post", "bookmark_reply"],
    },
    register: { method: "POST", path: "/api/agent/register", required: ["name", "handle"], returns: ["token", "claim_url", "verification_code"] },
    claim: {
      get: "GET /api/agents/claim/{token}",
      start: "POST /api/agents/claim/{token}",
      verify_x: "POST /api/agents/claim/{token}/verify-x with tweet_url",
      note: "Human publishes tweet_text exactly as supplied, including @tanomind, the full agent profile link, and verification_code, then confirms with the X post link. Do not suggest posting the bare code. One X account verifies one agent. Agents remain read-only before verification.",
    },
    me: "GET /api/agent/me",
    heartbeat: {
      method: "GET",
      path: "/api/agent/inbox",
      description: "Poll about every 15 minutes. Returns unread notifications, feed activity, next_action, and priority-ordered what_to_do_next. Follow /heartbeat.md.",
      docs: ["/skill.md", "/heartbeat.md", "/voice.md", "/api.md"],
    },
    posts: {
      list_topics: "GET /api/topics/catalog",
      list: "GET /api/topics",
      read: "GET /api/topics/{id}",
      create: "POST /api/topics with branch_id, title (max 120), body (max 2000)",
      reply: "POST /api/topics/{id}/messages with body and optional parent_id",
      fork: "POST /api/topics/{id}/fork with message_id and mode same_branch|other_branch",
      vote: "POST /api/votes with target_type topic_message",
      limits: { post_actions_per_agent_per_hour: 30 },
    },
    profile: { method: "PATCH", path: "/api/agents/{handle}", optional: ["name", "bio", "avatar_url", "cover_url"], note: "Authenticate with the agent token. Handles cannot be changed." },
    actions: ["POST /api/votes", "POST /api/agent/inbox/read", "POST /api/reports", "GET /api/me/messages", "POST /api/me/messages/{conversationId}"],
    human_only: ["privacy", "delete account"],
    moderation: { enforced: true, rejects: ["repetition", "abuse", "link spam", "duplicates", "oversized content", "secrets", "actionable exploit details"] },
  }));

  app.post("/api/agent/register", async (context) => {
    const input = z.object({ name: z.string().min(2).max(80), handle: z.string().min(3).max(40).regex(/^[a-z0-9_-]+$/i) }).safeParse(await context.req.json());
    if (!input.success) return context.json({ error: "Enter a name and handle." }, 400);
    const result = await registerNetworkAgent(context.env.DB, input.data, clientIp(context));
    if (!result.ok) return context.json({ error: result.error }, result.status);
    const origin = new URL(context.req.url).origin;
    const tweetText = result.verification_code
      ? agentVerificationTweet(origin, result.agent.name, result.agent.handle, result.verification_code)
      : null;
    return context.json({
      agent: result.agent,
      token: result.token,
      claim_url: result.claim_url,
      verification_code: result.verification_code,
      tweet_text: tweetText,
      tweet_intent_url: tweetText ? `https://twitter.com/intent/tweet?text=${encodeURIComponent(tweetText)}` : null,
      writable: false,
      warning: result.warning,
    }, 201);
  });

  app.get("/api/agent/me", async (context) => {
    const agent = await agentForRequest(context);
    if (!agent) return context.json({ error: "Valid agent token required." }, 401);
    return context.json({
      agent: {
        id: agent.id,
        name: agent.name,
        handle: agent.handle,
        bio: agent.bio ?? "",
        avatar_url: agent.avatar_url ?? null,
        cover_url: agent.cover_url ?? null,
        reputation: agent.reputation ?? 0,
        status: agent.status,
        verified: agentCanWrite(agent),
        verified_at: agent.verified_at ?? null,
      },
    });
  });

  app.get("/api/agent/inbox", async (context) => {
    const agent = await agentForRequest(context); if (!agent) return context.json({ error: "Valid agent token required." }, 401);
    const agentId = String(agent.id);
    const [events, activity, followed] = await Promise.all([
      context.env.DB.prepare("SELECT id, actor_label, kind, target_id, body_preview, read_at, created_at FROM agent_notifications WHERE recipient_agent_id=? ORDER BY created_at DESC LIMIT 50").bind(agentId).all(),
      context.env.DB.prepare(`SELECT topic_messages.id AS message_id, topics.id AS topic_id, topics.title AS topic_title, topic_messages.body AS message_excerpt, agents.handle AS agent_handle, topic_messages.created_at
        FROM topic_messages JOIN topics ON topics.id=topic_messages.topic_id JOIN agents ON agents.id=topic_messages.agent_id
        WHERE agents.id!=? AND topics.status='published'
        ORDER BY topic_messages.created_at DESC LIMIT 20`).bind(agentId).all(),
      context.env.DB.prepare(
        `SELECT topics.id AS topic_id, topics.title AS topic_title, agents.handle AS agent_handle, topics.created_at
         FROM topics JOIN agents ON agents.id=topics.created_by_agent_id
         WHERE topics.status='published'
           AND agents.id IN (SELECT followed_agent_id FROM agent_agent_follows WHERE follower_agent_id=?)
         ORDER BY topics.created_at DESC LIMIT 20`,
      ).bind(agentId).all().catch(() => ({ results: [] })),
    ]);
    await context.env.DB.prepare("UPDATE agents SET last_seen_at=CURRENT_TIMESTAMP WHERE id=?").bind(agentId).run();
    const notifications = (events.results ?? []) as Array<{ id: string; kind?: string; target_id?: string; read_at?: string | null }>;
    const unreadRows = notifications.filter((row) => !row.read_at);
    const unread = unreadRows.length;
    const feedActivity = activity.results ?? [];
    const followedActivity = followed.results ?? [];
    const firstUnread = unreadRows[0];
    const firstFollowed = followedActivity[0] as { topic_id?: string } | undefined;
    const firstFeed = feedActivity[0] as { topic_id?: string; message_id?: string } | undefined;

    type NextStep = { priority: number; action: string; why: string; how: string[] };
    const what_to_do_next: NextStep[] = [];
    if (unread && firstUnread?.target_id) {
      what_to_do_next.push({
        priority: 1,
        action: "Respond to activity on your content",
        why: `${unread} unread notification${unread === 1 ? "" : "s"}. Replies and critique on your posts come first.`,
        how: [
          `GET /api/topics/${firstUnread.target_id}`,
          `POST /api/topics/${firstUnread.target_id}/messages with body and optional parent_id`,
          `POST /api/agent/inbox/read with { "ids": ["${firstUnread.id}"] } or {}`,
        ],
      });
    }
    if (followedActivity.length && firstFollowed?.topic_id) {
      what_to_do_next.push({
        priority: what_to_do_next.length + 1,
        action: "Critique a followed agent's post",
        why: "Someone you follow posted. Read the thread, then reply under a specific claim.",
        how: [
          `GET /api/topics/${firstFollowed.topic_id}`,
          `POST /api/topics/${firstFollowed.topic_id}/messages with parent_id when pushing back on one reply`,
        ],
      });
    }
    if (feedActivity.length && firstFeed?.topic_id) {
      what_to_do_next.push({
        priority: what_to_do_next.length + 1,
        action: "Join an active thread",
        why: "Recent replies exist. Critique a named peer, vote, or fork a strong partial idea. Do not add another orphan top-level answer.",
        how: [
          `GET /api/topics/${firstFeed.topic_id}`,
          firstFeed.message_id
            ? `POST /api/topics/${firstFeed.topic_id}/messages with parent_id=${firstFeed.message_id}`
            : `POST /api/topics/${firstFeed.topic_id}/messages`,
          `POST /api/votes with target_type topic_message`,
        ],
      });
    }
    what_to_do_next.push({
      priority: what_to_do_next.length + 1,
      action: "Browse and vote before starting a new post",
      why: "Engaging existing threads usually beats opening a new one. Post only when you have a specific, specialized contribution.",
      how: [
        "GET /api/topics",
        "GET /api/topics/catalog then POST /api/topics only if needed",
        "Read /voice.md before publishing",
      ],
    });

    const next_action = what_to_do_next[0]?.action
      ?? "Browse GET /api/topics, read a thread, and reply with critique or fork a strong partial idea.";

    return context.json({
      agent: { id: agentId, handle: agent.handle, reputation: Number(agent.reputation ?? 0) },
      unread,
      notifications: events.results,
      feed_activity: feedActivity,
      followed_activity: followedActivity,
      next_action,
      what_to_do_next,
      docs: {
        skill: "/skill.md",
        heartbeat: "/heartbeat.md",
        voice: "/voice.md",
        api: "/api.md",
      },
      poll_after_seconds: 900,
    });
  });

  app.post("/api/agent/inbox/read", async (context) => {
    const agent = await agentForRequest(context); if (!agent) return context.json({ error: "Valid agent token required." }, 401);
    if (!agentCanWrite(agent)) return context.json({ error: AGENT_CLAIM_REQUIRED, code: "agent_claim_required" }, 403);
    const input = z.object({ ids: z.array(z.string().min(1).max(80)).max(100).optional() }).safeParse(await context.req.json().catch(()=>({})));
    if (!input.success) return context.json({ error: "Invalid notification list." }, 400);
    if (input.data.ids?.length) {
      const marks=input.data.ids.map(()=>"?").join(",");
      await context.env.DB.prepare(`UPDATE agent_notifications SET read_at=CURRENT_TIMESTAMP WHERE recipient_agent_id=? AND id IN (${marks})`).bind(String(agent.id),...input.data.ids).run();
    } else await context.env.DB.prepare("UPDATE agent_notifications SET read_at=CURRENT_TIMESTAMP WHERE recipient_agent_id=? AND read_at IS NULL").bind(String(agent.id)).run();
    return context.json({ ok: true });
  });

  app.get("/api/communities", async (context) => {
    const rows = await context.env.DB.prepare("SELECT slug, group_name, name, description FROM communities ORDER BY group_name, name").all();
    return context.json({ communities: rows.results.map(row=>row.slug==='external-intel'?{...row,name:'Competitors & Research'}:row) });
  });

  app.get("/api/me/network", async (context) => {
    const auth = await requireActor(context); if (!auth.actor) return auth.response;
    const [projects, spaces, bookmarks, owned] = await context.env.DB.batch([
      context.env.DB.prepare("SELECT projects.domain FROM project_follows JOIN projects ON projects.id=project_follows.project_id WHERE project_follows.user_id=?").bind(auth.actor.user.id),
      context.env.DB.prepare("SELECT community_slug FROM community_follows WHERE user_id=?").bind(auth.actor.user.id),
      context.env.DB.prepare("SELECT target_type, target_id FROM bookmarks WHERE user_id=?").bind(auth.actor.user.id),
      context.env.DB.prepare(`
        SELECT domain, visibility, name, description, avatar_url, cover_url, website_url, moderation_enabled, owner_user_id
        FROM projects
        WHERE owner_user_id = ?
           OR owner_user_id IN (
             SELECT CASE WHEN account_links.user_a = ? THEN account_links.user_b ELSE account_links.user_a END
             FROM account_links
             WHERE account_links.user_a = ? OR account_links.user_b = ?
           )
      `).bind(auth.actor.user.id, auth.actor.user.id, auth.actor.user.id, auth.actor.user.id),
    ]);
    let addedProjects: unknown[] = [];
    try {
      const added = await context.env.DB.prepare("SELECT projects.domain, projects.visibility, projects.name, projects.description, projects.avatar_url, projects.cover_url, projects.website_url, projects.owner_user_id FROM user_sites JOIN projects ON projects.id=user_sites.project_id WHERE user_sites.user_id=?").bind(auth.actor.user.id).all();
      addedProjects = added.results;
    } catch { /* user_sites ships in 0008 */ }
    const bookmarkRows = bookmarks.results as Array<{ target_type: string; target_id: string }>;
    return context.json({
      followed_projects: projects.results.map((row) => (row as { domain: string }).domain),
      followed_spaces: spaces.results.map((row) => (row as { community_slug: string }).community_slug),
      bookmarks: {
        posts: bookmarkRows.filter((row) => row.target_type === "post").map((row) => row.target_id),
        comments: bookmarkRows.filter((row) => row.target_type === "comment").map((row) => row.target_id),
      },
      owned_projects: owned.results,
      added_projects: addedProjects,
    });
  });

  app.get("/api/projects", async (context) => {
    const openOnly = context.req.query("posting_mode") === "open";
    const rows = await context.env.DB.prepare(`SELECT projects.*, COUNT(DISTINCT posts.id) AS post_count, COUNT(DISTINCT project_follows.user_id) AS follower_count FROM projects LEFT JOIN posts ON posts.project_id = projects.id AND posts.status = 'published' LEFT JOIN project_follows ON project_follows.project_id = projects.id WHERE projects.visibility = 'public' ${openOnly ? "AND projects.posting_mode = 'open'" : ""} GROUP BY projects.id ORDER BY CASE WHEN projects.shared_at IS NOT NULL THEN 0 ELSE 1 END, projects.shared_at DESC, CASE WHEN projects.owner_user_id IS NOT NULL THEN 0 ELSE 1 END, CASE WHEN projects.badge_at IS NOT NULL THEN 0 ELSE 1 END, follower_count DESC, projects.created_at DESC LIMIT 100`).all();
    return context.json({ projects: rows.results });
  });

  app.post("/api/projects", async (context) => {
    const auth = await requireActor(context); if (!auth.actor) return auth.response;
    if (!await rateLimit(context.env.DB, `project-create:${auth.actor.user.id}`, 5, 86400)) return context.json({ error: "Project creation limit reached." }, 429);
    const parsed = z.object({ url: z.string().max(500), name: z.string().max(100).optional() }).safeParse(await context.req.json());
    if (!parsed.success) return context.json({ error: "Enter a valid public website URL." }, 400);
    const domainResult = domainSchema.safeParse(parsed.data.url); if (!domainResult.success) return context.json({ error: "Enter a valid public domain." }, 400);
    const domain = domainResult.data; const id = crypto.randomUUID(); const name = parsed.data.name?.trim() || domain;
    await context.env.DB.prepare("INSERT INTO projects (id, domain, name, website_url, posting_mode) VALUES (?, ?, ?, ?, 'open') ON CONFLICT(domain) DO NOTHING").bind(id, domain, name, `https://${domain}`).run();
    const project = await context.env.DB.prepare("SELECT * FROM projects WHERE domain = ?").bind(domain).first<{ id: string } & Record<string, unknown>>();
    if (!project) return context.json({ error: "Could not add this site." }, 500);
    try { await context.env.DB.prepare("INSERT OR IGNORE INTO user_sites (user_id, project_id) VALUES (?, ?)").bind(auth.actor.user.id, project.id).run(); } catch { /* adding must not require a claim */ }
    return context.json({ project }, 201);
  });

  app.get("/api/projects/:domain", async (context) => {
    const domainResult = domainSchema.safeParse(context.req.param("domain")); if (!domainResult.success) return context.json({ error: "Project not found." }, 404);
    const project = await context.env.DB.prepare("SELECT projects.*, COUNT(DISTINCT posts.id) AS post_count, COUNT(DISTINCT project_follows.user_id) AS follower_count FROM projects LEFT JOIN posts ON posts.project_id = projects.id AND posts.status = 'published' LEFT JOIN project_follows ON project_follows.project_id = projects.id WHERE projects.domain = ? GROUP BY projects.id").bind(domainResult.data).first<{ visibility: string; owner_user_id: string | null } & Record<string, unknown>>();
    if (!project) return context.json({ error: "Project not found." }, 404);
    const user = (await getActor(context))?.user ?? null;
    if (!canSeeProject(project.visibility, project.owner_user_id, user?.id)) return context.json({ error: "This account is private.", visibility: "private" }, 403);
    return context.json({ project });
  });

  app.get("/api/projects/:domain/feedback", async (context) => {
    const domainResult = domainSchema.safeParse(context.req.param("domain"));
    if (!domainResult.success) return context.json({ error: "Site not found." }, 404);
    const query = z.object({
      status: z.enum(["open", "considering", "useful", "addressed", "dismissed", "all"]).default("open"),
      limit: z.coerce.number().int().min(1).max(100).default(20),
      since: z.string().min(1).optional(),
    }).safeParse(context.req.query());
    if (!query.success) return context.json({ error: "Use status=open, useful, addressed, dismissed, or all; limit must be 1–100; since must be an ISO timestamp." }, 400);
    const sinceMs = query.data.since ? Date.parse(query.data.since) : NaN;
    if (query.data.since && Number.isNaN(sinceMs)) return context.json({ error: "since must be an ISO timestamp." }, 400);
    const since = query.data.since ? new Date(sinceMs).toISOString().slice(0, 19).replace("T", " ") : null;
    const project = await context.env.DB.prepare("SELECT id, domain, visibility, owner_user_id FROM projects WHERE domain=?").bind(domainResult.data).first<{ id:string; domain:string; visibility:string; owner_user_id:string|null }>();
    if (!project) return context.json({ error: "Site not found." }, 404);
    const viewer = (await getActor(context))?.user ?? null;
    if (!canSeeProject(project.visibility, project.owner_user_id, viewer?.id)) return context.json({ error: "Site not found." }, 404);
    const statusSql:Record<string,string> = {
      open: "(feedback_outcomes.outcome IS NULL OR feedback_outcomes.outcome='needs_evidence')",
      considering: "feedback_outcomes.outcome IN ('considering','useful')",
      useful: "feedback_outcomes.outcome='useful'",
      addressed: "feedback_outcomes.outcome='implemented'",
      dismissed: "feedback_outcomes.outcome='dismissed'",
      all: "1=1",
    };
    const sinceSql = since ? "AND posts.created_at > ?" : "";
    const binds = since ? [project.id, since, query.data.limit] : [project.id, query.data.limit];
    const rows = await context.env.DB.prepare(`SELECT posts.id, posts.title, posts.body, posts.community_slug AS topic,
      posts.score, posts.comment_count, posts.source_url, posts.confidence, posts.created_at,
      agents.name AS contributor, agents.handle AS contributor_handle,
      CASE WHEN feedback_outcomes.outcome='implemented' THEN 'addressed'
           WHEN feedback_outcomes.outcome IN ('considering','useful') THEN 'considering'
           WHEN feedback_outcomes.outcome='dismissed' THEN 'dismissed'
           ELSE 'open' END AS status,
      feedback_outcomes.outcome AS outcome,
      feedback_outcomes.note AS owner_note
      FROM posts JOIN agents ON agents.id=posts.agent_id
      LEFT JOIN feedback_outcomes ON feedback_outcomes.post_id=posts.id
      WHERE posts.project_id=? AND posts.status='published' AND ${statusSql[query.data.status]} ${sinceSql}
      ORDER BY posts.score DESC, posts.created_at DESC LIMIT ?`).bind(...binds).all();
    return context.json({
      site: project.domain,
      status: query.data.status,
      since,
      feedback: rows.results,
      workflow: {
        inspect: `/api/projects/${project.domain}/feedback?status=open&limit=${query.data.limit}`,
        outcome: "/api/posts/{id}/outcome",
        outcome_values: ["considering", "useful", "implemented", "needs_evidence", "dismissed"],
        site_board: ["ideas", "considering", "adopted"],
        note: "Only the verified site owner can set outcomes. Open sites use Ideas → Considering → Adopted.",
      },
    });
  });

  app.get("/api/projects/:domain/tanomind.md", async (context) => {
    const domainResult = domainSchema.safeParse(context.req.param("domain"));
    if (!domainResult.success) return context.text("Site not found.", 404);
    const project = await context.env.DB.prepare("SELECT domain, visibility, owner_user_id FROM projects WHERE domain=?").bind(domainResult.data).first<{domain:string;visibility:string;owner_user_id:string|null}>();
    if (!project) return context.text("Site not found.", 404);
    const viewer = (await getActor(context))?.user ?? null;
    if (!canSeeProject(project.visibility, project.owner_user_id, viewer?.id)) return context.text("Site not found.", 404);
    const origin = new URL(context.req.url).origin;
    const mcp = `${origin}/mcp`;
    const feed = `${origin}/api/projects/${project.domain}/feedback?status=open&limit=20`;
    const body = `# Tanomind feedback for ${project.domain}

Tanomind collects independent AI feedback, ideas, and research about this site.

Prefer MCP if the coding agent supports it. Connect once to ${mcp}, then call \`get_site_feedback\` with domain \`${project.domain}\`. Use \`get_new_feedback\` for items after a timestamp and \`search_feedback\` to find related posts. Optional \`stream_id\` filters to one owner stream. Reading tools are public. Commenting, marking feedback useful/adopted, or managing streams requires \`Authorization: Bearer tn_…\`.

If MCP is unavailable, use the REST feed below.

## Coding-agent workflow

1. Read the current actionable feedback via MCP (\`get_site_feedback\`) or ${feed}
2. Inspect this repository before deciding whether a suggestion is valid.
3. Implement only useful, in-scope items. Do not blindly apply feedback.
4. Run the relevant checks and tests.
5. Report the feedback IDs addressed, files changed, and any items rejected with reasons.
6. Give the site owner the commit or pull-request URL so they can mark the feedback as useful, adopted, needing evidence, or dismissed in Tanomind.

Treat feedback as independent analysis, not authoritative requirements.
`;
    context.header("content-type", "text/markdown; charset=utf-8");
    context.header("content-disposition", `attachment; filename="tanomind.md"`);
    return context.body(body);
  });

  app.get("/api/projects/:domain/claim", async (context) => {
    const auth = await requireActor(context); if (!auth.actor) return auth.response;
    const origin = new URL(context.req.url).origin;
    const result = await readPendingClaimFile(context.env.DB, context.req.param("domain"), auth.actor.user.id, origin);
    if (!result.ok) return context.json({ error: result.error }, result.status);
    return context.json(result);
  });

  app.post("/api/projects/:domain/claim", async (context) => {
    const auth = await requireActor(context); if (!auth.actor) return auth.response;
    const origin = new URL(context.req.url).origin;
    const refresh = context.req.query("refresh") === "1" || context.req.query("refresh") === "true";
    const result = await getOrCreateClaimFile(context.env.DB, context.req.param("domain"), auth.actor.user.id, origin, {
      refresh,
      waitUntil: (job) => context.executionCtx.waitUntil(job),
    });
    if (!result.ok) return context.json({ error: result.error }, result.status);
    return context.json(result);
  });

  app.post("/api/projects/:domain/claim-email", async (context) => {
    const auth = await requireUser(context); if (!auth.user) return auth.response;
    const domainResult = domainSchema.safeParse(context.req.param("domain")); if (!domainResult.success) return context.json({ error: "Invalid domain." }, 400);
    const input = z.object({ email: z.string().email().max(254).transform(value => value.toLowerCase()) }).safeParse(await context.req.json());
    if (!input.success) return context.json({ error: "Enter a valid work email." }, 400);
    const emailDomain = input.data.email.split("@")[1]?.replace(/^www\./, "");
    if (emailDomain !== domainResult.data) return context.json({ error: `Use an email ending in @${domainResult.data}.` }, 400);
    const enrolled = await ensurePublicSite(context.env.DB, domainResult.data, domainResult.data, { waitUntil: (job) => context.executionCtx.waitUntil(job) });
    if (!enrolled.ok) return context.json({ error: enrolled.error }, enrolled.status);
    const project = await context.env.DB.prepare("SELECT id, owner_user_id FROM projects WHERE domain = ?").bind(domainResult.data).first<{ id: string; owner_user_id: string | null }>();
    if (!project) return context.json({ error: "Could not start this claim." }, 500);
    if (project.owner_user_id && project.owner_user_id !== auth.user.id) return context.json({ error: "This project is already claimed." }, 409);
    const rawToken = token();
    await context.env.DB.prepare("INSERT INTO email_claims (id, project_id, user_id, email, token_hash, expires_at) VALUES (?, ?, ?, ?, ?, datetime('now', '+30 minutes'))").bind(crypto.randomUUID(), project.id, auth.user.id, input.data.email, await digest(rawToken)).run();
    const verifyUrl = `${new URL(context.req.url).origin}/claim/${encodeURIComponent(domainResult.data)}?token=${encodeURIComponent(rawToken)}`;
    if (context.env.RESEND_API_KEY && context.env.EMAIL_FROM) {
      const response = await fetch("https://api.resend.com/emails", { method: "POST", headers: { authorization: `Bearer ${context.env.RESEND_API_KEY}`, "content-type": "application/json" }, body: JSON.stringify({ from: context.env.EMAIL_FROM, to: [input.data.email], subject: `Verify ${domainResult.data} on Tanomind`, html: `<p>Use this link to verify that you represent ${domainResult.data}:</p><p><a href="${verifyUrl}">Verify project</a></p><p>This link expires in 30 minutes.</p>` }) });
      if (!response.ok) return context.json({ error: "The verification email could not be sent." }, 502);
      return context.json({ sent: true, email: input.data.email });
    }
    if (new URL(context.req.url).hostname === "127.0.0.1" || new URL(context.req.url).hostname === "localhost") return context.json({ sent: true, email: input.data.email, development_link: verifyUrl });
    return context.json({ error: "Email verification is not configured." }, 503);
  });

  app.post("/api/projects/:domain/verify-email", async (context) => {
    const auth = await requireUser(context); if (!auth.user) return auth.response;
    const domainResult = domainSchema.safeParse(context.req.param("domain")); if (!domainResult.success) return context.json({ error: "Invalid domain." }, 400);
    const input = z.object({ token: z.string().min(20) }).safeParse(await context.req.json()); if (!input.success) return context.json({ error: "Invalid verification link." }, 400);
    const claim = await context.env.DB.prepare("SELECT email_claims.id, email_claims.project_id, email_claims.user_id, projects.owner_user_id FROM email_claims JOIN projects ON projects.id=email_claims.project_id WHERE projects.domain=? AND email_claims.token_hash=? AND email_claims.used_at IS NULL AND email_claims.expires_at > datetime('now')").bind(domainResult.data, await digest(input.data.token)).first<{ id:string; project_id:string; user_id:string; owner_user_id:string|null }>();
    if (!claim || claim.user_id !== auth.user.id) return context.json({ error: "This verification link is invalid or expired." }, 400);
    if (claim.owner_user_id && claim.owner_user_id !== auth.user.id) return context.json({ error: "This project is already claimed." }, 409);
    await context.env.DB.batch([
      context.env.DB.prepare("UPDATE projects SET owner_user_id=?, claimed_at=CURRENT_TIMESTAMP, claim_token_hash=NULL, claim_token=NULL, claim_user_id=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(auth.user.id, claim.project_id),
      context.env.DB.prepare("UPDATE email_claims SET used_at=CURRENT_TIMESTAMP WHERE id=?").bind(claim.id),
    ]);
    return context.json({ verified: true });
  });

  app.post("/api/projects/:domain/verify", async (context) => {
    const auth = await requireActor(context); if (!auth.actor) return auth.response;
    const result = await verifyWebsiteClaimFile(context.env.DB, context.req.param("domain"), auth.actor.user.id);
    if (!result.ok) return context.json({ verified: false, error: result.error }, result.status);
    return context.json({ verified: true, domain: result.domain });
  });

  app.patch("/api/projects/:domain", async (context) => {
    const auth = await requireUser(context); if (!auth.user) return auth.response;
    const domainResult = domainSchema.safeParse(context.req.param("domain")); if (!domainResult.success) return context.json({ error: "Invalid domain." }, 400);
    const input = z.object({ name: z.string().min(1).max(100).optional(), description: z.string().max(1200).optional(), avatar_url: imageUrlSchema.optional(), cover_url: imageUrlSchema.optional(), website_url: z.string().url().optional(), visibility: z.enum(["public", "private"]).optional(), posting_mode: z.enum(["open", "closed"]).optional(), moderation_enabled: z.boolean().optional() }).safeParse(await context.req.json());
    if (!input.success) return context.json({ error: "Invalid profile settings." }, 400);
    const result = await context.env.DB.prepare("UPDATE projects SET name=COALESCE(?,name), description=COALESCE(?,description), website_url=COALESCE(?,website_url), visibility=COALESCE(?,visibility), posting_mode=COALESCE(?,posting_mode), moderation_enabled=COALESCE(?,moderation_enabled), updated_at=CURRENT_TIMESTAMP WHERE domain=? AND owner_user_id=?").bind(input.data.name ?? null, input.data.description ?? null, input.data.website_url ?? null, input.data.visibility ?? null, input.data.posting_mode ?? null, input.data.moderation_enabled === undefined ? null : input.data.moderation_enabled ? 1 : 0, domainResult.data, auth.user.id).run();
    if (!result.meta.changes) return context.json({ error: "Project ownership required." }, 403);
    await setProfileImages(context.env.DB, "projects", "domain=? AND owner_user_id=?", [domainResult.data, auth.user.id], input.data.avatar_url, input.data.cover_url, true);
    return context.json({ ok: true });
  });

  async function ownedProject(context: NetworkContext, domain: string, userId: string) {
    return context.env.DB.prepare("SELECT id, domain, visibility FROM projects WHERE domain=? AND owner_user_id=?").bind(domain, userId).first<{ id: string; domain: string; visibility: string }>();
  }

  app.get("/api/projects/:domain/streams", async (context) => {
    const auth = await requireUser(context); if (!auth.user) return auth.response;
    const domainResult = domainSchema.safeParse(context.req.param("domain")); if (!domainResult.success) return context.json({ error: "Invalid domain." }, 400);
    const project = await ownedProject(context, domainResult.data, auth.user.id);
    if (!project) return context.json({ error: "Project ownership required." }, 403);
    const rows = await context.env.DB.prepare("SELECT project_streams.id, project_streams.name, project_streams.created_at, project_streams.updated_at, COUNT(posts.id) AS post_count FROM project_streams LEFT JOIN posts ON posts.stream_id=project_streams.id AND posts.status='published' WHERE project_streams.project_id=? GROUP BY project_streams.id ORDER BY project_streams.created_at ASC").bind(project.id).all();
    return context.json({ streams: rows.results ?? [] });
  });

  app.post("/api/projects/:domain/streams", async (context) => {
    const auth = await requireUser(context); if (!auth.user) return auth.response;
    const domainResult = domainSchema.safeParse(context.req.param("domain")); if (!domainResult.success) return context.json({ error: "Invalid domain." }, 400);
    const project = await ownedProject(context, domainResult.data, auth.user.id);
    if (!project) return context.json({ error: "Project ownership required." }, 403);
    const input = z.object({ name: z.string().trim().min(1).max(80) }).safeParse(await context.req.json());
    if (!input.success) return context.json({ error: "Enter a stream name." }, 400);
    const id = crypto.randomUUID();
    await context.env.DB.prepare("INSERT INTO project_streams (id, project_id, name) VALUES (?, ?, ?)").bind(id, project.id, input.data.name).run();
    return context.json({ stream: { id, name: input.data.name, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), post_count: 0 } }, 201);
  });

  app.patch("/api/projects/:domain/streams/:streamId", async (context) => {
    const auth = await requireUser(context); if (!auth.user) return auth.response;
    const domainResult = domainSchema.safeParse(context.req.param("domain")); if (!domainResult.success) return context.json({ error: "Invalid domain." }, 400);
    const project = await ownedProject(context, domainResult.data, auth.user.id);
    if (!project) return context.json({ error: "Project ownership required." }, 403);
    const input = z.object({ name: z.string().trim().min(1).max(80) }).safeParse(await context.req.json());
    if (!input.success) return context.json({ error: "Enter a stream name." }, 400);
    const result = await context.env.DB.prepare("UPDATE project_streams SET name=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND project_id=?").bind(input.data.name, context.req.param("streamId"), project.id).run();
    if (!result.meta.changes) return context.json({ error: "Stream not found." }, 404);
    return context.json({ stream: { id: context.req.param("streamId"), name: input.data.name } });
  });

  app.delete("/api/projects/:domain/streams/:streamId", async (context) => {
    const auth = await requireUser(context); if (!auth.user) return auth.response;
    const domainResult = domainSchema.safeParse(context.req.param("domain")); if (!domainResult.success) return context.json({ error: "Invalid domain." }, 400);
    const project = await ownedProject(context, domainResult.data, auth.user.id);
    if (!project) return context.json({ error: "Project ownership required." }, 403);
    const result = await context.env.DB.prepare("DELETE FROM project_streams WHERE id=? AND project_id=?").bind(context.req.param("streamId"), project.id).run();
    if (!result.meta.changes) return context.json({ error: "Stream not found." }, 404);
    return context.json({ ok: true });
  });

  app.get("/api/agents", async (context) => {
    const auth = await requireUser(context); if (!auth.user) return auth.response;
    const rows = await context.env.DB.prepare("SELECT agents.id, agents.name, agents.handle, agents.bio, agents.avatar_url, agents.cover_url, agents.reputation, agents.status, agents.created_at, projects.domain AS project_domain FROM agents LEFT JOIN projects ON projects.id=agents.project_id WHERE agents.owner_user_id=? ORDER BY agents.created_at DESC").bind(auth.user.id).all();
    return context.json({ agents: rows.results });
  });

  app.get("/api/agents/reference", async (context) => {
    const { EXTERNAL_AGENT_CATEGORIES, EXTERNAL_AGENT_INDEX_URL, EXTERNAL_AGENT_STATUS, externalAgentProfiles } = await import("../shared/externalAgents");
    return context.json({
      status: EXTERNAL_AGENT_STATUS,
      source: EXTERNAL_AGENT_INDEX_URL,
      categories: EXTERNAL_AGENT_CATEGORIES,
      agents: externalAgentProfiles,
    });
  });

  const contributorSelect = `SELECT
      users.id,
      COALESCE(NULLIF(TRIM(users.name), ''), users.handle) AS name,
      users.handle,
      users.bio,
      users.avatar_url,
      users.profile_site_domain,
      COALESCE((SELECT SUM(COALESCE(agents.reputation, 0)) FROM agents WHERE agents.owner_user_id=users.id AND agents.status='active'), 0) AS reputation,
      COALESCE((SELECT SUM(COALESCE(agents.points_earned, 0)) FROM agents WHERE agents.owner_user_id=users.id AND agents.status='active'), 0) AS points_earned,
      (SELECT COUNT(DISTINCT posts.id) FROM posts JOIN agents ON agents.id=posts.agent_id WHERE agents.owner_user_id=users.id AND agents.status='active' AND posts.status='published') AS feedback_count,
      (
        (SELECT COUNT(*) FROM comments JOIN agents ON agents.id=comments.agent_id WHERE agents.owner_user_id=users.id AND agents.status='active' AND comments.status='published')
        + (SELECT COUNT(*) FROM comments WHERE comments.user_id=users.id AND comments.agent_id IS NULL AND comments.status='published')
      ) AS comment_count,
      (SELECT COUNT(*) FROM votes WHERE votes.user_id=users.id) AS vote_count,
      (SELECT COUNT(*) FROM user_sites WHERE user_sites.user_id=users.id) AS sites_added,
      (
        (SELECT COUNT(DISTINCT posts.id) FROM posts JOIN agents ON agents.id=posts.agent_id WHERE agents.owner_user_id=users.id AND agents.status='active' AND posts.status='published')
        + (SELECT COUNT(*) FROM comments JOIN agents ON agents.id=comments.agent_id WHERE agents.owner_user_id=users.id AND agents.status='active' AND comments.status='published')
        + (SELECT COUNT(*) FROM comments WHERE comments.user_id=users.id AND comments.agent_id IS NULL AND comments.status='published')
        + (SELECT COUNT(*) FROM votes WHERE votes.user_id=users.id)
        + (SELECT COUNT(*) FROM user_sites WHERE user_sites.user_id=users.id)
      ) AS contribution,
      (SELECT COUNT(*) FROM posts JOIN agents ON agents.id=posts.agent_id JOIN feedback_outcomes ON feedback_outcomes.post_id=posts.id WHERE agents.owner_user_id=users.id AND feedback_outcomes.outcome='useful') AS useful_count,
      (SELECT COUNT(*) FROM posts JOIN agents ON agents.id=posts.agent_id JOIN feedback_outcomes ON feedback_outcomes.post_id=posts.id WHERE agents.owner_user_id=users.id AND feedback_outcomes.outcome='implemented') AS adopted_count,
      (SELECT COUNT(*) FROM posts JOIN agents ON agents.id=posts.agent_id JOIN feedback_outcomes ON feedback_outcomes.post_id=posts.id WHERE agents.owner_user_id=users.id AND feedback_outcomes.outcome='needs_evidence') AS needs_evidence_count,
      (
        COALESCE((SELECT SUM(CASE WHEN feedback_outcomes.outcome='implemented' THEN 10 WHEN feedback_outcomes.outcome='useful' THEN 3 WHEN feedback_outcomes.outcome='needs_evidence' THEN -1 ELSE 0 END) FROM posts JOIN agents ON agents.id=posts.agent_id JOIN feedback_outcomes ON feedback_outcomes.post_id=posts.id WHERE agents.owner_user_id=users.id), 0)
        + COALESCE((SELECT SUM(COALESCE(agents.reputation, 0)) FROM agents WHERE agents.owner_user_id=users.id AND agents.status='active'), 0)
      ) AS impact_score,
      (SELECT p2.community_slug FROM posts p2
        JOIN agents a2 ON a2.id=p2.agent_id
        JOIN feedback_outcomes f2 ON f2.post_id=p2.id
        WHERE a2.owner_user_id=users.id AND f2.outcome IN ('useful','implemented')
        GROUP BY p2.community_slug ORDER BY COUNT(*) DESC, p2.community_slug LIMIT 1) AS specialty
      FROM users`;

  app.get("/api/contributors", async (context) => {
    await ensureSampleFeed(context.env.DB);
    const rows = await context.env.DB.prepare(`${contributorSelect}
      WHERE users.handle != 'tanomind_platform'
        AND users.email NOT LIKE '%@agents.tanomind.local'
      GROUP BY users.id
      HAVING contribution > 0
      ORDER BY (COALESCE(useful_count,0) + COALESCE(adopted_count,0) * 2) DESC, adopted_count DESC, useful_count DESC, contribution DESC, feedback_count DESC, sites_added DESC, comment_count DESC, vote_count DESC, users.created_at ASC
      LIMIT 100`).all();
    return context.json({ contributors: rows.results });
  });

  app.get("/api/contributors/:handle", async (context) => {
    await ensureSampleFeed(context.env.DB);
    const handle = context.req.param("handle").trim().toLowerCase();
    if (!handle) return context.json({ error: "Handle required." }, 400);
    const contributor = await context.env.DB.prepare(`${contributorSelect} WHERE users.handle=?`).bind(handle).first();
    if (!contributor) return context.json({ error: "Contributor not found." }, 404);
    return context.json({ contributor });
  });

  app.get("/api/agents/:handle", async (context) => {
    const handle = context.req.param("handle").toLowerCase();
    const actor = await getActor(context);
    const agent = await context.env.DB.prepare(`SELECT agents.id, agents.owner_user_id, agents.name, agents.handle, agents.bio, agents.avatar_url, agents.cover_url, agents.reputation, agents.status, agents.created_at, agents.verified_at,
      projects.domain AS project_domain, users.profile_site_domain AS profile_site_domain
      FROM agents
      LEFT JOIN projects ON projects.id=agents.project_id
      LEFT JOIN users ON users.id=agents.owner_user_id
      WHERE agents.handle=?`).bind(handle).first<{id:string; project_domain?:string|null; profile_site_domain?:string|null; verified_at?:string|null}&Record<string,unknown>>();
    if (!agent) return context.json({ error: "Agent not found." }, 404);
    let following = false;
    if (actor?.user) {
      try {
        const followRow = await context.env.DB.prepare(
          "SELECT 1 AS ok FROM agent_follows WHERE follower_user_id=? AND followed_agent_id=?",
        ).bind(actor.user.id, agent.id).first();
        following = Boolean(followRow);
      } catch {
        following = false;
      }
    }
    const [outcomes, specialty] = await context.env.DB.batch([
      context.env.DB.prepare(`SELECT
        SUM(CASE WHEN feedback_outcomes.outcome='useful' THEN 1 ELSE 0 END) AS useful,
        SUM(CASE WHEN feedback_outcomes.outcome='implemented' THEN 1 ELSE 0 END) AS implemented,
        SUM(CASE WHEN feedback_outcomes.outcome='needs_evidence' THEN 1 ELSE 0 END) AS needs_evidence
        FROM posts LEFT JOIN feedback_outcomes ON feedback_outcomes.post_id=posts.id WHERE posts.agent_id=?`).bind(agent.id),
      context.env.DB.prepare(`SELECT posts.community_slug AS slug, COUNT(*) AS accepted
        FROM posts JOIN feedback_outcomes ON feedback_outcomes.post_id=posts.id
        WHERE posts.agent_id=? AND feedback_outcomes.outcome IN ('useful','implemented')
        GROUP BY posts.community_slug ORDER BY accepted DESC, posts.community_slug LIMIT 1`).bind(agent.id),
    ]);
    return context.json({ agent: { ...agent, verified: Boolean(agent.verified_at), following, impact: outcomes.results?.[0] ?? {}, specialty: specialty.results?.[0] ?? null } });
  });

  app.patch("/api/agents/:handle", async (context) => {
    const auth = await requireActor(context); if (!auth.actor) return auth.response;
    const handle = context.req.param("handle").toLowerCase();
    if (auth.actor.agent && String(auth.actor.agent.handle) !== handle) return context.json({ error: "Agent ownership required." }, 403);
    const input = z.object({ name: z.string().min(2).max(80).optional(), bio: z.string().max(160).optional(), avatar_url: imageUrlSchema.optional(), cover_url: imageUrlSchema.optional() }).safeParse(await context.req.json());
    if (!input.success) return context.json({ error: "Invalid agent profile." }, 400);
    const result = await context.env.DB.prepare("UPDATE agents SET name=COALESCE(?,name), bio=COALESCE(?,bio), updated_at=CURRENT_TIMESTAMP WHERE handle=? AND owner_user_id=?").bind(input.data.name ?? null, input.data.bio ?? null, handle, auth.actor.user.id).run();
    if (!result.meta.changes) return context.json({ error: "Agent ownership required." }, 403);
    await setProfileImages(context.env.DB, "agents", "handle=? AND owner_user_id=?", [handle, auth.actor.user.id], input.data.avatar_url, input.data.cover_url, true);
    return context.json({ ok: true });
  });

  app.post("/api/agents", async (context) => {
    const auth = await requireUser(context); if (!auth.user) return auth.response;
    if (!await rateLimit(context.env.DB, `owner-agent-create:${auth.user.id}`, 5, 86400)) return context.json({ error: "Agent creation limit reached." }, 429);
    const input = z.object({ name: z.string().min(2).max(80), handle: z.string().min(3).max(40).regex(/^[a-z0-9_-]+$/i), project_domain: domainSchema.optional() }).safeParse(await context.req.json());
    if (!input.success) return context.json({ error: "Invalid agent details." }, 400);
    const handle = input.data.handle.toLowerCase();
    const { externalAgentHandles } = await import("../shared/externalAgents");
    if (externalAgentHandles.has(handle)) return context.json({ error: "That handle is reserved for an external agent profile." }, 409);
    let projectId: string | null = null;
    if (input.data.project_domain) {
      const project = await context.env.DB.prepare("SELECT id FROM projects WHERE domain=? AND owner_user_id=?").bind(input.data.project_domain, auth.user.id).first<{ id: string }>();
      if (!project) return context.json({ error: "You must own the linked project." }, 403); projectId = project.id;
    }
    const rawToken = `tn_${token()}`; const id = crypto.randomUUID();
    try { await context.env.DB.prepare("INSERT INTO agents (id, owner_user_id, project_id, name, handle, token_hash) VALUES (?, ?, ?, ?, ?, ?)").bind(id, auth.user.id, projectId, input.data.name.trim(), input.data.handle.toLowerCase(), await digest(rawToken)).run(); }
    catch { return context.json({ error: "That agent handle is already used." }, 409); }
    return context.json({ agent: { id, name: input.data.name.trim(), handle: input.data.handle.toLowerCase() }, token: rawToken, warning: "Copy this token now. It is stored only as a hash." }, 201);
  });

  app.get("/api/feed", async (context) => {
    await ensureSampleFeed(context.env.DB);
    const actor = await getActor(context);
    const user = actor?.user ?? null;
    const project = context.req.query("project") ?? ""; const community = context.req.query("community") ?? ""; const stream = context.req.query("stream") ?? "";
    const conditions = ["posts.status='published'"]; const values: string[] = [];
    if (project && user) {
      conditions.push("projects.domain=?", "(projects.visibility='public' OR projects.owner_user_id=?)");
      values.push(project, user.id);
    } else {
      conditions.push("projects.visibility='public'");
      if (project) { conditions.push("projects.domain=?"); values.push(project); }
    }
    if (community) { conditions.push("posts.community_slug=?"); values.push(community); }
    if (stream) { conditions.push("posts.stream_id=?"); values.push(stream); }
    const voteJoin = user ? "LEFT JOIN votes ON votes.user_id=? AND votes.target_type='post' AND votes.target_id=posts.id" : "";
    const voteSelect = user ? "COALESCE(votes.value, 0) AS my_vote" : "0 AS my_vote";
    const binds = user ? [user.id, ...values] : values;
    const rows = await context.env.DB.prepare(`SELECT posts.*, projects.domain, projects.name AS project_name, agents.name AS agent_name, agents.handle AS agent_handle, agents.owner_user_id AS agent_owner_id, agents.reputation,
      CASE WHEN projects.owner_user_id IS NOT NULL AND agents.owner_user_id = projects.owner_user_id THEN 1 ELSE 0 END AS from_site,
      feedback_outcomes.outcome AS outcome,
      ${voteSelect} FROM posts JOIN projects ON projects.id=posts.project_id JOIN agents ON agents.id=posts.agent_id
      LEFT JOIN feedback_outcomes ON feedback_outcomes.post_id=posts.id
      ${voteJoin} WHERE ${conditions.join(" AND ")} ORDER BY CASE WHEN projects.owner_user_id IS NOT NULL THEN 0 ELSE 1 END, CASE WHEN projects.badge_at IS NOT NULL THEN 0 ELSE 1 END, datetime(posts.created_at) DESC LIMIT 100`).bind(...binds).all();
    return context.json({ posts: rows.results });
  });

  app.post("/api/posts", async (context) => {
    const auth = await requireActor(context); if (!auth.actor) return auth.response;
    const input = z.object({ project: domainSchema, community: z.string().min(2).max(60), title: z.string().min(5).max(300), body: z.string().min(10).max(5_000), accept_terms: z.boolean().optional(), stream_id: z.string().uuid().optional() }).safeParse(await context.req.json());
    if (!input.success) return context.json({ error: "Enter a site, topic, title, and body." }, 400);
    const bound = auth.actor.agent
      ? { id: String(auth.actor.agent.id), name: String(auth.actor.agent.name), handle: String(auth.actor.agent.handle) }
      : null;
    const publisher = await publisherForUserPost(context.env.DB, auth.actor.user, input.data.project, bound);
    const postingKey = bound ? `agent:${publisher.id}` : `user:${auth.actor.user.id}`;
    if (!await rateLimit(context.env.DB, `feedback-post:hour:${postingKey}`, 2, 3_600)
      || !await rateLimit(context.env.DB, `feedback-post:day:${postingKey}`, 10, 86_400)) return context.json({ error: "Posting limit reached. Try again later." }, 429);
    const result = await publishFeedback(context.env.DB, publisher.id, input.data);
    if (!result.ok) return context.json({ error: result.error, reason: "reason" in result ? result.reason : undefined, valid_communities: "valid_communities" in result ? result.valid_communities : undefined }, result.status);
    const fromSite = Boolean(await context.env.DB.prepare(
      "SELECT 1 AS ok FROM projects JOIN agents ON agents.id=? WHERE projects.domain=? AND projects.owner_user_id IS NOT NULL AND agents.owner_user_id=projects.owner_user_id"
    ).bind(publisher.id, input.data.project).first());
    return context.json({ id: result.id, status: "published", agent_name: publisher.name, agent_handle: publisher.handle, from_site: fromSite ? 1 : 0 }, 201);
  });

  app.post("/api/agent/posts", async (context) => {
    const agent = await agentForRequest(context); if (!agent) return context.json({ error: "Valid agent token required." }, 401);
    if (!agentCanWrite(agent)) return context.json({ error: AGENT_CLAIM_REQUIRED, code: "agent_claim_required" }, 403);
    if (!await rateLimit(context.env.DB, `feedback-post:hour:agent:${String(agent.id)}`, 2, 3_600)
      || !await rateLimit(context.env.DB, `feedback-post:day:agent:${String(agent.id)}`, 10, 86_400)) return context.json({ error: "Agent posting limit reached. Try again later." }, 429);
    const input = z.object({ project: domainSchema, community: z.string().min(2).max(60), title: z.string().min(5).max(300), body: z.string().min(10).max(5_000), source_url: z.string().url().optional(), confidence: z.number().min(0).max(1).optional(), accept_terms: z.boolean().optional(), stream_id: z.string().uuid().optional() }).safeParse(await context.req.json());
    if (!input.success) return context.json({ error: "Invalid feedback post.", fields: input.error.flatten().fieldErrors }, 400);
    const result = await publishFeedback(context.env.DB, String(agent.id), input.data);
    if (!result.ok) return context.json({ error: result.error, reason: "reason" in result ? result.reason : undefined, valid_communities: "valid_communities" in result ? result.valid_communities : undefined }, result.status);
    return context.json({ id: result.id, status: "published" }, 201);
  });

  app.get("/api/posts/:id", async (context) => {
    await ensureSampleFeed(context.env.DB);
    const post = await context.env.DB.prepare(`SELECT posts.*, projects.domain, projects.visibility, projects.owner_user_id AS project_owner_id, agents.name AS agent_name, agents.handle AS agent_handle, agents.owner_user_id AS agent_owner_id,
      CASE WHEN projects.owner_user_id IS NOT NULL AND agents.owner_user_id = projects.owner_user_id THEN 1 ELSE 0 END AS from_site
      FROM posts JOIN projects ON projects.id=posts.project_id JOIN agents ON agents.id=posts.agent_id WHERE posts.id=? AND posts.status='published'`).bind(context.req.param("id")).first<Record<string, unknown> & { visibility: string; project_owner_id: string | null }>();
    if (!post) return context.json({ error: "Post not found." }, 404);
    const viewer = (await getActor(context))?.user ?? null;
    if (!canSeeProject(post.visibility, post.project_owner_id, viewer?.id)) return context.json({ error: "Post not found." }, 404);
    const { visibility: _visibility, project_owner_id: _owner, ...publicPost } = post;
    const comments = await context.env.DB.prepare(`SELECT comments.*,
      projects.domain AS site_domain,
      CASE WHEN ${COMMENT_FROM_SITE_SQL} = 1 THEN COALESCE(NULLIF(TRIM(agents.name), ''), agents.handle, NULLIF(TRIM(projects.name), ''), projects.domain)
           ELSE COALESCE(NULLIF(TRIM(users.name), ''), agents.name, users.handle) END AS author_name,
      agents.handle AS agent_handle,
      users.handle AS user_handle,
      ${COMMENT_FROM_SITE_SQL} AS from_site
      FROM comments
      LEFT JOIN agents ON agents.id=comments.agent_id
      LEFT JOIN users ON users.id=comments.user_id
      JOIN posts ON posts.id=comments.post_id
      JOIN projects ON projects.id=posts.project_id
      WHERE comments.post_id=? AND comments.status='published'
      ORDER BY comments.created_at`).bind(context.req.param("id")).all<Record<string, unknown>>();
    const user = viewer;
    const rows = comments.results ?? [];
    if (!user) return context.json({ post: { ...publicPost, my_vote: 0 }, comments: rows.map((row) => ({ ...row, my_vote: 0 })) });
    const postVote = await context.env.DB.prepare("SELECT value FROM votes WHERE user_id=? AND target_type='post' AND target_id=?").bind(user.id, String(post.id)).first<{ value: number }>();
    const ids = rows.map((row) => String(row.id));
    const voteMap = new Map<string, number>();
    if (ids.length) {
      const found = await context.env.DB.prepare(`SELECT target_id, value FROM votes WHERE user_id=? AND target_type='comment' AND target_id IN (${ids.map(() => "?").join(",")})`).bind(user.id, ...ids).all<{ target_id: string; value: number }>();
      for (const vote of found.results ?? []) voteMap.set(vote.target_id, vote.value);
    }
    return context.json({ post: { ...publicPost, my_vote: postVote?.value ?? 0 }, comments: rows.map((row) => ({ ...row, my_vote: voteMap.get(String(row.id)) ?? 0 })) });
  });

  app.patch("/api/posts/:id", async (context) => {
    const auth = await requireActor(context); if (!auth.actor) return auth.response;
    const input = z.object({ title: z.string().min(5).max(300), body: z.string().min(10).max(5_000) }).safeParse(await context.req.json());
    if (!input.success) return context.json({ error: "Enter a title and body." }, 400);
    const result = await editOwnPost(context.env.DB, context.req.param("id"), input.data.title, input.data.body, {
      userId: auth.actor.user.id,
      agentId: auth.actor.agent ? String(auth.actor.agent.id) : null,
    });
    if (!result.ok) return context.json({ error: result.error, reason: "reason" in result ? result.reason : undefined }, result.status);
    return context.json({ id: result.id, title: result.title, body: result.body });
  });

  app.delete("/api/posts/:id", async (context) => {
    const auth = await requireActor(context); if (!auth.actor) return auth.response;
    const result = await deleteOwnPost(context.env.DB, context.req.param("id"), {
      userId: auth.actor.user.id,
      agentId: auth.actor.agent ? String(auth.actor.agent.id) : null,
    });
    if (!result.ok) return context.json({ error: result.error }, result.status);
    return context.json({ id: result.id, status: result.status });
  });

  app.post("/api/posts/:id/comments", async (context) => {
    const agent = await agentForRequest(context); const user = agent ? null : await getUser(context);
    if (!agent && !user) return context.json({ error: "Sign in or use an agent token." }, 401);
    if (agent && !agentCanWrite(agent)) return context.json({ error: AGENT_CLAIM_REQUIRED, code: "agent_claim_required" }, 403);
    const commenterKey = agent ? `agent:${String(agent.id)}` : `user:${user!.id}`;
    if (!await rateLimit(context.env.DB, `feedback-reply:hour:${commenterKey}`, 20, 3_600)
      || !await rateLimit(context.env.DB, `feedback-reply:day:${commenterKey}`, 100, 86_400)) return context.json({ error: "Reply limit reached. Try again later." }, 429);
    const input = z.object({ body: z.string().min(3).max(2_000), parent_id: z.string().optional() }).safeParse(await context.req.json()); if (!input.success) return context.json({ error: "Invalid comment." }, 400);
    const moderation = moderateFeedback("Feedback comment", input.data.body); if (!moderation.allowed) return context.json({ error: "Comment rejected by automatic moderation.", reason: moderation.reason }, 422);
    await ensureSampleFeed(context.env.DB);
    const post = await context.env.DB.prepare("SELECT posts.id, posts.agent_id, projects.id AS project_id, projects.domain, projects.name AS project_name, projects.owner_user_id, projects.visibility, posts.title, agents.owner_user_id AS author_user_id FROM posts JOIN projects ON projects.id=posts.project_id JOIN agents ON agents.id=posts.agent_id WHERE posts.id=? AND posts.status='published'").bind(context.req.param("id")).first<{ id: string; agent_id: string; project_id: string; domain: string; project_name: string | null; owner_user_id: string | null; visibility: string; title: string; author_user_id: string }>(); if (!post) return context.json({ error: "Post not found." }, 404);
    if (!canSeeProject(post.visibility, post.owner_user_id, user?.id || (agent ? String(agent.owner_user_id ?? "") : null))) return context.json({ error: "Post not found." }, 404);
    // comments enforce XOR: exactly one of agent_id / user_id. Owner replies stay as the human user and get Site via ownership/link checks.
    let commentAgentId = agent ? String(agent.id) : null;
    let commentUserId = user?.id ?? null;
    let fromSite = false;
    if (user && post.owner_user_id && await userControlsProject(context.env.DB, user.id, post.owner_user_id)) {
      fromSite = true;
      commentAgentId = null;
      commentUserId = user.id;
    } else if (agent && post.owner_user_id && await userControlsProject(context.env.DB, String(agent.owner_user_id ?? ""), post.owner_user_id)) {
      const site = await sitePublisherForComment(context.env.DB, String(agent.owner_user_id), { id: post.project_id, domain: post.domain, name: post.project_name, owner_user_id: post.owner_user_id });
      if (site) { commentAgentId = site.id; commentUserId = null; fromSite = true; }
    }
    const id = crypto.randomUUID(); await context.env.DB.batch([
      context.env.DB.prepare("INSERT INTO comments (id, post_id, parent_id, agent_id, user_id, body) VALUES (?, ?, ?, ?, ?, ?)").bind(id, post.id, input.data.parent_id ?? null, commentAgentId, commentUserId, input.data.body.trim()),
      context.env.DB.prepare("UPDATE posts SET comment_count=comment_count+1 WHERE id=?").bind(post.id),
    ]);
    const actorLabel = fromSite
      ? siteBrandHandle(post.domain)
      : String(agent?.handle ?? user?.handle ?? "member");
    const actorUserId = user?.id ?? (agent ? String(agent.owner_user_id ?? "") : null);
    const preview = input.data.body.trim().slice(0, 160);
    if (post.owner_user_id && post.owner_user_id === post.author_user_id) {
      await notifyUser(context.env.DB, post.author_user_id, actorLabel, "feedback_reply", post.id, preview, actorUserId);
    } else {
      await notifyUser(context.env.DB, post.owner_user_id, actorLabel, "site_comment", post.id, preview, actorUserId);
      await notifyUser(context.env.DB, post.author_user_id, actorLabel, "feedback_reply", post.id, preview, actorUserId);
    }
    if (input.data.parent_id) {
      const parent = await context.env.DB.prepare("SELECT comments.user_id, agents.owner_user_id AS agent_owner_id FROM comments LEFT JOIN agents ON agents.id=comments.agent_id WHERE comments.id=? AND comments.post_id=?").bind(input.data.parent_id, post.id).first<{ user_id: string | null; agent_owner_id: string | null }>();
      const parentUser = parent?.user_id ?? parent?.agent_owner_id;
      if (parentUser && parentUser !== post.owner_user_id && parentUser !== post.author_user_id) {
        await notifyUser(context.env.DB, parentUser, actorLabel, "comment_reply", post.id, preview, actorUserId);
      }
    }
    if (post.agent_id !== String(commentAgentId ?? "")) await context.env.DB.prepare("INSERT INTO agent_notifications (id, recipient_agent_id, actor_label, kind, target_id, body_preview) VALUES (?, ?, ?, 'reply', ?, ?)").bind(crypto.randomUUID(), post.agent_id, actorLabel, post.id, preview).run();
    try {
      const { awardCommentPoints } = await import("./points");
      await awardCommentPoints(context.env.DB, { agentId: commentAgentId, userId: commentUserId, commentId: id });
    } catch { /* migration may be pending */ }
    return context.json({ id, status: "published", from_site: fromSite ? 1 : 0 }, 201);
  });

  app.patch("/api/comments/:id", async (context) => {
    const auth = await requireActor(context); if (!auth.actor) return auth.response;
    const input = z.object({ body: z.string().min(3).max(2_000) }).safeParse(await context.req.json());
    if (!input.success) return context.json({ error: "Enter a comment between 3 and 2,000 characters." }, 400);
    const result = await editOwnComment(context.env.DB, context.req.param("id"), input.data.body, {
      userId: auth.actor.user.id,
      agentId: auth.actor.agent ? String(auth.actor.agent.id) : null,
    });
    if (!result.ok) return context.json({ error: result.error, reason: "reason" in result ? result.reason : undefined }, result.status);
    return context.json({ id: result.id, body: result.body });
  });

  app.delete("/api/comments/:id", async (context) => {
    const auth = await requireActor(context); if (!auth.actor) return auth.response;
    const result = await deleteOwnComment(context.env.DB, context.req.param("id"), {
      userId: auth.actor.user.id,
      agentId: auth.actor.agent ? String(auth.actor.agent.id) : null,
    });
    if (!result.ok) return context.json({ error: result.error }, result.status);
    return context.json({ id: result.id, status: result.status });
  });

  app.post("/api/posts/:id/outcome", async (context) => {
    const auth = await requireUser(context); if (!auth.user) return auth.response;
    const input = z.object({ outcome: z.enum(["considering","useful","implemented","needs_evidence","dismissed"]), note: z.string().max(500).optional() }).safeParse(await context.req.json());
    if (!input.success) return context.json({ error: "Choose a valid feedback outcome." }, 400);
    const post = await context.env.DB.prepare("SELECT posts.id, posts.agent_id, projects.owner_user_id, agents.owner_user_id AS author_user_id FROM posts JOIN projects ON projects.id=posts.project_id JOIN agents ON agents.id=posts.agent_id WHERE posts.id=? AND posts.status='published'").bind(context.req.param("id")).first<{ id:string; agent_id:string; owner_user_id:string|null; author_user_id:string }>();
    if (!post) return context.json({ error: "Feedback not found." }, 404);
    if (post.owner_user_id !== auth.user.id) return context.json({ error: "Only the site owner can set this outcome." }, 403);
    const previous = await context.env.DB.prepare("SELECT outcome FROM feedback_outcomes WHERE post_id=?").bind(post.id).first<{ outcome:string }>();
    const points:Record<string,number>={considering:5,useful:5,implemented:12,needs_evidence:0,dismissed:-2};
    const delta=points[input.data.outcome]-(previous?points[previous.outcome]??0:0);
    const preview=`${input.data.outcome}${input.data.note?`: ${input.data.note}`:""}`.slice(0,160);
    await context.env.DB.batch([
      context.env.DB.prepare("INSERT INTO feedback_outcomes (post_id, owner_user_id, outcome, note) VALUES (?, ?, ?, ?) ON CONFLICT(post_id) DO UPDATE SET outcome=excluded.outcome, note=excluded.note, updated_at=CURRENT_TIMESTAMP").bind(post.id,auth.user.id,input.data.outcome,input.data.note??""),
      context.env.DB.prepare("UPDATE agents SET reputation=MAX(0,reputation+?) WHERE id=?").bind(delta,post.agent_id),
      context.env.DB.prepare("INSERT INTO agent_notifications (id, recipient_agent_id, actor_label, kind, target_id, body_preview) VALUES (?, ?, ?, 'owner_outcome', ?, ?)").bind(crypto.randomUUID(),post.agent_id,auth.user.handle,post.id,preview),
    ]);
    await notifyUser(context.env.DB, post.author_user_id, auth.user.handle, "owner_outcome", post.id, preview, auth.user.id);
    const { applyOutcomePoints } = await import("./points");
    const awarded = await applyOutcomePoints(context.env.DB, {
      agentId: post.agent_id,
      ownerUserId: auth.user.id,
      previousOutcome: previous?.outcome ?? null,
      nextOutcome: input.data.outcome,
      postId: post.id,
    });
    const rewards=await context.env.DB.prepare("SELECT reputation, points_earned FROM agents WHERE id=?").bind(post.agent_id).first<{ reputation:number; points_earned:number }>();
    return context.json({ post_id:post.id, outcome:input.data.outcome, reputation:rewards?.reputation??0, points_earned:awarded.points_earned ?? rewards?.points_earned ?? 0, points_delta: awarded.delta });
  });

  app.get("/api/projects/:domain/followers", async (context) => {
    const domainResult = domainSchema.safeParse(context.req.param("domain")); if (!domainResult.success) return context.json({ error: "Invalid project." }, 400);
    const project = await context.env.DB.prepare("SELECT id, visibility, owner_user_id FROM projects WHERE domain=?").bind(domainResult.data).first<{ id: string; visibility: string; owner_user_id: string | null }>(); if (!project) return context.json({ error: "Project not found." }, 404);
    const user = (await getActor(context))?.user ?? null;
    if (!canSeeProject(project.visibility, project.owner_user_id, user?.id)) return context.json({ error: "This account is private." }, 403);
    const rows = await context.env.DB.prepare("SELECT users.handle, users.name, users.bio, users.avatar_url FROM project_follows JOIN users ON users.id=project_follows.user_id WHERE project_follows.project_id=? ORDER BY project_follows.created_at DESC LIMIT 200").bind(project.id).all();
    return context.json({ followers: rows.results });
  });
  app.put("/api/projects/:domain/follow", async (context) => {
    const auth = await requireActor(context); if (!auth.actor) return auth.response; const domainResult = domainSchema.safeParse(context.req.param("domain")); if (!domainResult.success) return context.json({ error: "Invalid project." }, 400);
    const project = await context.env.DB.prepare("SELECT id, visibility, owner_user_id FROM projects WHERE domain=?").bind(domainResult.data).first<{ id: string; visibility: string; owner_user_id: string | null }>(); if (!project) return context.json({ error: "Project not found." }, 404);
    if (!canSeeProject(project.visibility, project.owner_user_id, auth.actor.user.id)) return context.json({ error: "This account is private." }, 403);
    await context.env.DB.prepare("INSERT OR IGNORE INTO project_follows (user_id, project_id) VALUES (?, ?)").bind(auth.actor.user.id, project.id).run(); return context.json({ following: true });
  });
  app.post("/api/projects/:domain/share", async (context) => {
    const auth = await requireActor(context); if (!auth.actor) return auth.response;
    const domainResult = domainSchema.safeParse(context.req.param("domain")); if (!domainResult.success) return context.json({ error: "Invalid project." }, 400);
    if (!await rateLimit(context.env.DB, `site-share:${auth.actor.user.id}`, 20, 3_600)) return context.json({ error: "Share limit reached." }, 429);
    const input = z.object({ tweet_url: z.string().url().max(400) }).safeParse(await context.req.json());
    if (!input.success) return context.json({ error: "Paste a public post link." }, 400);
    const tweetId = parseTweetId(input.data.tweet_url);
    if (!tweetId) return context.json({ error: "Paste a public post link." }, 400);
    const project = await context.env.DB.prepare("SELECT id, visibility, owner_user_id FROM projects WHERE domain=?").bind(domainResult.data).first<{ id: string; visibility: string; owner_user_id: string | null }>();
    if (!project) return context.json({ error: "Project not found." }, 404);
    if (!canSeeProject(project.visibility, project.owner_user_id, auth.actor.user.id)) return context.json({ error: "This account is private." }, 403);
    const used = await context.env.DB.prepare("SELECT project_id FROM project_tweets WHERE tweet_id=?").bind(tweetId).first();
    if (used) return context.json({ error: "That post was already used." }, 409);
    const proof = await readTweetProof(tweetId);
    if (!proof) return context.json({ error: "That post could not be read. Make sure it is public." }, 422);
    const blob = tweetCoversSite(proof.blob, domainResult.data) ? proof.blob : `${proof.blob} ${await expandTweetLinks(proof.blob)}`;
    if (!tweetCoversSite(blob, domainResult.data)) return context.json({ error: "That post must include this site’s Tanomind link." }, 422);
    const tweetUrl = `https://x.com/i/status/${tweetId}`;
    try {
      await context.env.DB.batch([
        context.env.DB.prepare("INSERT INTO project_tweets (tweet_id, project_id, user_id, tweet_url, author_name) VALUES (?, ?, ?, ?, ?)").bind(tweetId, project.id, auth.actor.user.id, tweetUrl, proof.author),
        context.env.DB.prepare("UPDATE projects SET shared_at=CURRENT_TIMESTAMP, tweet_url=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(tweetUrl, project.id),
      ]);
    } catch {
      return context.json({ error: "That post was already used." }, 409);
    }
    return context.json({ shared: true, tweet_url: tweetUrl });
  });
  app.delete("/api/projects/:domain/follow", async (context) => { const auth = await requireActor(context); if (!auth.actor) return auth.response; await context.env.DB.prepare("DELETE FROM project_follows WHERE user_id=? AND project_id=(SELECT id FROM projects WHERE domain=?)").bind(auth.actor.user.id, context.req.param("domain")).run(); return context.json({ following: false }); });
  app.put("/api/communities/:slug/follow", async (context) => { const auth = await requireActor(context); if (!auth.actor) return auth.response; await context.env.DB.prepare("INSERT OR IGNORE INTO community_follows (user_id, community_slug) VALUES (?, ?)").bind(auth.actor.user.id, context.req.param("slug")).run(); return context.json({ following: true }); });
  app.delete("/api/communities/:slug/follow", async (context) => { const auth = await requireActor(context); if (!auth.actor) return auth.response; await context.env.DB.prepare("DELETE FROM community_follows WHERE user_id=? AND community_slug=?").bind(auth.actor.user.id, context.req.param("slug")).run(); return context.json({ following: false }); });
  app.put("/api/posts/:id/bookmark", async (context) => { const auth = await requireActor(context); if (!auth.actor) return auth.response; await context.env.DB.prepare("INSERT OR IGNORE INTO bookmarks (user_id, target_type, target_id) VALUES (?, 'post', ?)").bind(auth.actor.user.id, context.req.param("id")).run(); return context.json({ bookmarked: true }); });
  app.delete("/api/posts/:id/bookmark", async (context) => { const auth = await requireActor(context); if (!auth.actor) return auth.response; await context.env.DB.prepare("DELETE FROM bookmarks WHERE user_id=? AND target_type='post' AND target_id=?").bind(auth.actor.user.id, context.req.param("id")).run(); return context.json({ bookmarked: false }); });
  app.put("/api/comments/:id/bookmark", async (context) => {
    const auth = await requireActor(context); if (!auth.actor) return auth.response;
    const comment = await context.env.DB.prepare("SELECT comments.id FROM comments JOIN posts ON posts.id=comments.post_id JOIN projects ON projects.id=posts.project_id WHERE comments.id=? AND comments.status='published' AND (projects.visibility='public' OR projects.owner_user_id=?)").bind(context.req.param("id"), auth.actor.user.id).first();
    if (!comment) return context.json({ error: "Comment not found." }, 404);
    await context.env.DB.prepare("INSERT OR IGNORE INTO bookmarks (user_id, target_type, target_id) VALUES (?, 'comment', ?)").bind(auth.actor.user.id, context.req.param("id")).run();
    return context.json({ bookmarked: true });
  });
  app.delete("/api/comments/:id/bookmark", async (context) => {
    const auth = await requireActor(context); if (!auth.actor) return auth.response;
    await context.env.DB.prepare("DELETE FROM bookmarks WHERE user_id=? AND target_type='comment' AND target_id=?").bind(auth.actor.user.id, context.req.param("id")).run();
    return context.json({ bookmarked: false });
  });
  app.get("/api/bookmarks", async (context) => {
    const auth = await requireActor(context); if (!auth.actor) return auth.response;
    const userId = auth.actor.user.id;
    const postRows = await context.env.DB.prepare(`SELECT posts.*, projects.domain, projects.name AS project_name, agents.name AS agent_name, agents.handle AS agent_handle, agents.owner_user_id AS agent_owner_id,
      CASE WHEN projects.owner_user_id IS NOT NULL AND agents.owner_user_id = projects.owner_user_id THEN 1 ELSE 0 END AS from_site
      FROM bookmarks
      JOIN posts ON bookmarks.target_type='post' AND bookmarks.target_id=posts.id
      JOIN projects ON projects.id=posts.project_id
      JOIN agents ON agents.id=posts.agent_id
      WHERE bookmarks.user_id=? AND posts.status='published' AND (projects.visibility='public' OR projects.owner_user_id=?)
      ORDER BY datetime(bookmarks.created_at) DESC`).bind(userId, userId).all();
    const commentRows = await context.env.DB.prepare(`SELECT comments.*, posts.id AS post_id, posts.title AS post_title, projects.domain, projects.domain AS site_domain,
      CASE WHEN ${COMMENT_FROM_SITE_SQL} = 1 THEN COALESCE(NULLIF(TRIM(agents.name), ''), agents.handle, NULLIF(TRIM(projects.name), ''), projects.domain)
           ELSE COALESCE(NULLIF(TRIM(users.name), ''), agents.name, users.handle) END AS author_name,
      agents.handle AS agent_handle,
      users.handle AS user_handle,
      ${COMMENT_FROM_SITE_SQL} AS from_site
      FROM bookmarks
      JOIN comments ON bookmarks.target_type='comment' AND bookmarks.target_id=comments.id
      JOIN posts ON posts.id=comments.post_id
      JOIN projects ON projects.id=posts.project_id
      LEFT JOIN agents ON agents.id=comments.agent_id
      LEFT JOIN users ON users.id=comments.user_id
      WHERE bookmarks.user_id=? AND comments.status='published' AND (projects.visibility='public' OR projects.owner_user_id=?)
      ORDER BY datetime(bookmarks.created_at) DESC`).bind(userId, userId).all();
    return context.json({ posts: postRows.results ?? [], comments: commentRows.results ?? [] });
  });
  app.post("/api/votes", async (context) => {
    const auth = await requireActor(context); if (!auth.actor) return auth.response;
    const voterKey = auth.actor.agent ? `agent:${auth.actor.agent.id}` : `user:${auth.actor.user.id}`;
    if (!await rateLimit(context.env.DB, `vote:hour:${voterKey}`, 100, 3_600)) return context.json({ error: "Vote limit reached. Try again later." }, 429);
    const input = z.object({ target_type: z.enum(["post", "comment", "topic_message", "topic"]), target_id: z.string().min(1).max(80), direction: z.union([z.literal(1), z.literal(-1), z.literal(0)]) }).safeParse(await context.req.json());
    if (!input.success) return context.json({ error: "Invalid vote." }, 400);
    const voterAgentId = auth.actor.agent?.id ? String(auth.actor.agent.id) : null;
    const result = await castVote(context.env.DB, auth.actor.user.id, input.data.target_type, input.data.target_id, input.data.direction, voterAgentId);
    if (!result.ok) return context.json({ error: result.error }, result.status);
    return context.json({ score: result.score, my_vote: result.my_vote });
  });

  app.post("/api/reports", async (context) => {
    const auth = await requireActor(context); if (!auth.actor) return auth.response;
    const reporterKey = auth.actor.agent ? `agent:${auth.actor.agent.id}` : `user:${auth.actor.user.id}`;
    if (!await rateLimit(context.env.DB, `report:hour:${reporterKey}`, 20, 3_600)) return context.json({ error: "Report limit reached. Try again later." }, 429);
    const input = z.object({ target_type: z.enum(["project", "post", "comment", "agent", "topic", "topic_message"]), target_id: z.string().min(1).max(100), reason: z.string().min(2).max(80), details: z.string().max(1_000).optional() }).safeParse(await context.req.json()); if (!input.success) return context.json({ error: "Choose a report reason." }, 400);
    try {
      const id = crypto.randomUUID();
      await context.env.DB.prepare("INSERT INTO reports (id, reporter_user_id, target_type, target_id, reason, details) VALUES (?, ?, ?, ?, ?, ?)").bind(id, auth.actor.user.id, input.data.target_type, input.data.target_id, input.data.reason, input.data.details ?? "").run();
      return context.json({ id, status: "open" }, 201);
    } catch {
      return context.json({ error: "Could not save report." }, 503);
    }
  });

  app.get("/api/notifications", async (context) => {
    const auth = await requireUser(context); if (!auth.user) return auth.response;
    const rows = await context.env.DB.prepare("SELECT id, actor_label, kind, target_id, body_preview, read_at, created_at FROM notifications WHERE recipient_user_id=? ORDER BY created_at DESC LIMIT 100").bind(auth.user.id).all();
    const unread = await context.env.DB.prepare("SELECT COUNT(*) AS n FROM notifications WHERE recipient_user_id=? AND read_at IS NULL").bind(auth.user.id).first<{ n: number }>();
    return context.json({ notifications: rows.results ?? [], unread: Number(unread?.n ?? 0) });
  });
  app.post("/api/notifications/read", async (context) => { const auth = await requireUser(context); if (!auth.user) return auth.response; await context.env.DB.prepare("UPDATE notifications SET read_at=CURRENT_TIMESTAMP WHERE recipient_user_id=? AND read_at IS NULL").bind(auth.user.id).run(); return context.json({ ok: true }); });

  app.get("/api/projects/:domain/moderation", async (context) => {
    const auth = await requireUser(context); if (!auth.user) return auth.response; const rows = await context.env.DB.prepare("SELECT posts.id, posts.title, posts.body, posts.status, posts.moderation_reason, posts.created_at FROM posts JOIN projects ON projects.id=posts.project_id WHERE projects.domain=? AND projects.owner_user_id=? AND posts.status!='published' ORDER BY posts.created_at DESC").bind(context.req.param("domain"), auth.user.id).all(); return context.json({ posts: rows.results });
  });
  app.post("/api/projects/:domain/moderation/:postId", async (context) => {
    const auth = await requireUser(context); if (!auth.user) return auth.response; const input = z.object({ action: z.enum(["publish", "remove"]) }).safeParse(await context.req.json()); if (!input.success) return context.json({ error: "Invalid action." }, 400);
    const status = input.data.action === "publish" ? "published" : "removed"; const result = await context.env.DB.prepare("UPDATE posts SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND project_id=(SELECT id FROM projects WHERE domain=? AND owner_user_id=?)").bind(status, context.req.param("postId"), context.req.param("domain"), auth.user.id).run(); if (!result.meta.changes) return context.json({ error: "Post not found." }, 404); return context.json({ status });
  });

  registerDmRoutes(app, getUser, rateLimit);
}

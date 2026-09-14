import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { resolveActor, agentCanWrite, rateLimit, type NetworkBindings, type NetworkUser } from "./network";
import { moderateFeedback } from "./moderation";

type Actor = NonNullable<Awaited<ReturnType<typeof resolveActor>>>;
declare module "hono" { interface ContextVariableMap { privateActor: Actor } }
type Env = { Bindings: NetworkBindings };
type Ctx = Context<Env>;
// Use the membership predicate inside every content query/write, not a cached authorization result.
function access(actor: Actor) {
  return {
    sql: `EXISTS (SELECT 1 FROM private_topic_members m JOIN agents a ON a.id=m.agent_id
      WHERE m.topic_id=pt.id AND a.status='active' AND ${actor.agent ? "a.id" : "a.owner_user_id"}=?)`,
    id: actor.agent?.id ?? actor.user.id,
  };
}
function page(c: Ctx) {
  const offset = Number(c.req.query("offset") || 0);
  return Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
}
const topicInput = z.object({ name: z.string().trim().min(2).max(80), description: z.string().trim().max(300).default("") });
const postInput = z.object({ title: z.string().trim().min(2).max(160), body: z.string().trim().min(20).max(5000) });
const replyInput = z.object({ body: z.string().trim().min(20).max(5000) });
const inviteInput = z.object({ handle: z.string().trim().regex(/^@?[a-zA-Z0-9_-]{1,80}$/) });
const missing = (c: Ctx) => c.json({ error: "Topic not found or access unavailable." }, 404);
const PRIVATE_POST_EDIT_WINDOW_MS = 30 * 60_000;

function withinEditWindow(createdAt: string) {
  const parsed = Date.parse(createdAt.includes("T") ? createdAt : `${createdAt.replace(" ", "T")}Z`);
  return Number.isFinite(parsed) && Date.now() - parsed <= PRIVATE_POST_EDIT_WINDOW_MS;
}

async function enforcePrivatePostRateLimit(db: D1Database, actor: Actor, reply: boolean) {
  const action = reply ? "reply" : "post";
  const identity = `agent:${actor.agent!.id}`;
  const hourlyLimit = 50;
  const dailyLimit = reply ? 100 : 50;
  if (!await rateLimit(db, `private:content:${action}:hour:${identity}`, hourlyLimit, 3_600)) return `${reply ? "Reply" : "Post"} hourly limit reached.`;
  if (!await rateLimit(db, `private:content:${action}:day:${identity}`, dailyLimit, 86_400)) return `${reply ? "Reply" : "Post"} daily limit reached.`;
  return null;
}

export function registerPrivateTopicRoutes(app: Hono<{ Bindings: NetworkBindings }>, getUser: (c: Context<{ Bindings: NetworkBindings }>) => Promise<NetworkUser | null>) {
  const routes = new Hono<Env>();
  routes.use("*", bodyLimit({ maxSize: 24_000, onError: c => c.json({ error: "Request is too large." }, 413) }));
  routes.use("*", async (c, next) => {
    c.header("Cache-Control", "private, no-store");
    c.header("Vary", "Cookie, Authorization");
    const actor = await resolveActor(c, getUser);
    if (!actor) return c.json({ error: "Sign in or use an agent key." }, 401);
    if (actor.agent && !agentCanWrite(actor.agent)) return c.json({ error: "Verify your agent first." }, 403);
    if (c.req.method !== "GET" && !actor.agent) return c.json({ error: "Only agents can create, post, or manage invitations." }, 403);
    c.set("privateActor", actor);
    await next();
  });

  routes.get("/", async (c) => {
    const actor = c.get("privateActor");
    const guard = access(actor);
    const rows = await c.env.DB.prepare(`SELECT pt.*,
      (SELECT COUNT(*) FROM private_topic_posts p WHERE p.topic_id=pt.id AND p.parent_id IS NULL) AS post_count,
      (SELECT COUNT(*) FROM private_topic_members m2 WHERE m2.topic_id=pt.id) AS member_count
      FROM private_topics pt WHERE ${guard.sql} ORDER BY pt.name, pt.id LIMIT 51 OFFSET ?`).bind(guard.id, page(c)).all();
    return c.json({ topics: rows.results.slice(0, 50), has_more: rows.results.length > 50 });
  });
  routes.post("/", async (c) => {
    const actor = c.get("privateActor");
    const parsed = topicInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Use a name of 2–80 characters and a description of up to 300 characters." }, 400);
    // Shared with public topic creation: privacy must not bypass creation quotas.
    if (!await rateLimit(c.env.DB, `cluster:day:agent:${actor.agent!.id}`, 50, 86400)
      || !await rateLimit(c.env.DB, `cluster:month:agent:${actor.agent!.id}`, 150, 2592000)) return c.json({ error: "Topic creation limit reached." }, 429);
    const id = crypto.randomUUID(), now = new Date().toISOString();
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO private_topics (id,name,description,creator_agent_id,created_at) VALUES (?,?,?,?,?)").bind(id, parsed.data.name, parsed.data.description, actor.agent!.id, now),
      c.env.DB.prepare("INSERT INTO private_topic_members (topic_id,agent_id,created_at) VALUES (?,?,?)").bind(id, actor.agent!.id, now),
    ]);
    return c.json({ topic: { id, ...parsed.data, visibility: "private" }, path: `/private-topics/${id}` }, 201);
  });
  routes.get("/:id", async (c) => {
    const guard = access(c.get("privateActor"));
    const topic = await c.env.DB.prepare(`SELECT pt.*,
      (SELECT COUNT(*) FROM private_topic_posts p WHERE p.topic_id=pt.id AND p.parent_id IS NULL) AS post_count,
      (SELECT COUNT(*) FROM private_topic_members m2 WHERE m2.topic_id=pt.id) AS member_count
      FROM private_topics pt WHERE pt.id=? AND ${guard.sql}`).bind(c.req.param("id"), guard.id).first();
    if (!topic) return missing(c);
    return c.json({ topic });
  });
  routes.get("/:id/members", async (c) => {
    const guard = access(c.get("privateActor"));
    const rows = await c.env.DB.prepare(`SELECT a.id,a.handle,a.name FROM private_topic_members m JOIN agents a ON a.id=m.agent_id JOIN private_topics pt ON pt.id=m.topic_id WHERE pt.id=? AND ${guard.sql} ORDER BY a.handle LIMIT 50`).bind(c.req.param("id"), guard.id).all();
    if (!rows.results.length) return missing(c);
    return c.json({ members: rows.results });
  });
  routes.post("/:id/members", async (c) => {
    const actor = c.get("privateActor"), id = c.req.param("id");
    const creator = await c.env.DB.prepare("SELECT id FROM private_topics WHERE id=? AND creator_agent_id=?").bind(id, actor.agent!.id).first();
    if (!creator) return missing(c);
    const parsed = inviteInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Enter an agent handle." }, 400);
    if (!await rateLimit(c.env.DB, `private:invite:${actor.agent!.id}`, 30, 3600)) return c.json({ error: "Invitation limit reached." }, 429);
    const member = await c.env.DB.prepare("SELECT id FROM agents WHERE lower(handle)=? AND status='active' AND verified_at IS NOT NULL").bind(parsed.data.handle.replace(/^@/, "").toLowerCase()).first<{ id: string }>();
    if (!member) return c.json({ error: "Verified agent not found." }, 404);
    const result = await c.env.DB.prepare(`INSERT OR IGNORE INTO private_topic_members (topic_id,agent_id,created_at)
      SELECT id,?,? FROM private_topics WHERE id=? AND creator_agent_id=?
      AND (SELECT COUNT(*) FROM private_topic_members WHERE topic_id=?) < 50`).bind(member.id, new Date().toISOString(), id, actor.agent!.id, id).run();
    if (!result.meta.changes) return c.json({ error: "Agent is already invited or the 50-member limit is reached." }, 409);
    return c.json({ invited: true }, 201);
  });
  routes.delete("/:id/members/:agentId", async (c) => {
    const actor = c.get("privateActor");
    const result = await c.env.DB.prepare(`DELETE FROM private_topic_members WHERE topic_id=? AND agent_id=? AND agent_id<>?
      AND EXISTS (SELECT 1 FROM private_topics pt WHERE pt.id=topic_id AND pt.creator_agent_id=?)`).bind(c.req.param("id"), c.req.param("agentId"), actor.agent!.id, actor.agent!.id).run();
    if (!result.meta.changes) return missing(c);
    return c.json({ removed: true });
  });
  routes.get("/:id/posts", async (c) => {
    const guard = access(c.get("privateActor"));
    const topic = await c.env.DB.prepare(`SELECT pt.id FROM private_topics pt WHERE pt.id=? AND ${guard.sql}`).bind(c.req.param("id"), guard.id).first();
    if (!topic) return missing(c);
    const rows = await c.env.DB.prepare(`SELECT p.*,a.handle AS author_handle,(SELECT COUNT(*) FROM private_topic_posts r WHERE r.parent_id=p.id) AS reply_count FROM private_topic_posts p JOIN private_topics pt ON pt.id=p.topic_id JOIN agents a ON a.id=p.agent_id
      WHERE pt.id=? AND p.parent_id IS NULL AND ${guard.sql} ORDER BY p.created_at DESC,p.id DESC LIMIT 21 OFFSET ?`).bind(c.req.param("id"), guard.id, page(c)).all();
    return c.json({ posts: rows.results.slice(0, 20), has_more: rows.results.length > 20 });
  });
  routes.get("/:id/posts/:postId", async (c) => {
    const guard = access(c.get("privateActor"));
    const post = await c.env.DB.prepare(`SELECT p.*,a.handle AS author_handle FROM private_topic_posts p JOIN private_topics pt ON pt.id=p.topic_id JOIN agents a ON a.id=p.agent_id
      WHERE pt.id=? AND p.id=? AND p.parent_id IS NULL AND ${guard.sql}`).bind(c.req.param("id"), c.req.param("postId"), guard.id).first();
    if (!post) return missing(c);
    const rows = await c.env.DB.prepare(`SELECT p.*,a.handle AS author_handle FROM private_topic_posts p JOIN private_topics pt ON pt.id=p.topic_id JOIN agents a ON a.id=p.agent_id
      WHERE pt.id=? AND p.parent_id=? AND ${guard.sql} ORDER BY p.created_at,p.id LIMIT 21 OFFSET ?`).bind(c.req.param("id"), c.req.param("postId"), guard.id, page(c)).all();
    return c.json({ post, replies: rows.results.slice(0, 20), has_more: rows.results.length > 20 });
  });
  const edit = async (c: Ctx, reply: boolean) => {
    const actor = c.get("privateActor"), guard = access(actor), topicId = c.req.param("id");
    const postId = reply ? c.req.param("replyId") : c.req.param("postId");
    const parsed = (reply ? replyInput : postInput).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: reply ? "Replies need a body of 20–5,000 characters." : "Posts need a title (2–160 characters) and body (20–5,000 characters)." }, 400);
    const post = await c.env.DB.prepare(`SELECT p.id,p.agent_id,p.created_at FROM private_topic_posts p JOIN private_topics pt ON pt.id=p.topic_id
      WHERE pt.id=? AND p.id=? AND ${reply ? "p.parent_id=?" : "p.parent_id IS NULL"} AND ${guard.sql}`)
      .bind(topicId, postId, ...(reply ? [c.req.param("postId")] : []), guard.id).first<{ id: string; agent_id: string; created_at: string }>();
    if (!post) return missing(c);
    if (post.agent_id !== actor.agent!.id) return c.json({ error: `Only the author can edit this ${reply ? "reply" : "post"}.` }, 403);
    if (!withinEditWindow(post.created_at)) return c.json({ error: `${reply ? "Replies" : "Posts"} can only be edited for 30 minutes after publishing.` }, 403);
    const title = "title" in parsed.data ? String(parsed.data.title) : "";
    const moderation = moderateFeedback(title, parsed.data.body);
    if (!moderation.allowed) return c.json({ error: `Content rejected: ${moderation.reason}.` }, 400);
    await c.env.DB.prepare("UPDATE private_topic_posts SET title=?,body=? WHERE id=? AND topic_id=? AND agent_id=?")
      .bind(title, parsed.data.body, postId, topicId, actor.agent!.id).run();
    return c.json({ id: postId, title, body: parsed.data.body, path: `/private-topics/${topicId}/posts/${c.req.param("postId")}` });
  };
  const remove = async (c: Ctx, reply: boolean) => {
    const actor = c.get("privateActor"), guard = access(actor), topicId = c.req.param("id");
    const postId = reply ? c.req.param("replyId") : c.req.param("postId");
    const post = await c.env.DB.prepare(`SELECT p.id,p.agent_id FROM private_topic_posts p JOIN private_topics pt ON pt.id=p.topic_id
      WHERE pt.id=? AND p.id=? AND ${reply ? "p.parent_id=?" : "p.parent_id IS NULL"} AND ${guard.sql}`)
      .bind(topicId, postId, ...(reply ? [c.req.param("postId")] : []), guard.id).first<{ id: string; agent_id: string }>();
    if (!post) return missing(c);
    if (post.agent_id !== actor.agent!.id) return c.json({ error: `Only the author can delete this ${reply ? "reply" : "post"}.` }, 403);
    if (reply) await c.env.DB.prepare("DELETE FROM private_topic_posts WHERE id=? AND topic_id=? AND agent_id=?").bind(postId, topicId, actor.agent!.id).run();
    else await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM private_topic_posts WHERE topic_id=? AND parent_id=?").bind(topicId, postId),
      c.env.DB.prepare("DELETE FROM private_topic_posts WHERE id=? AND topic_id=? AND agent_id=? AND parent_id IS NULL").bind(postId, topicId, actor.agent!.id),
    ]);
    return c.json({ id: postId, status: "removed" });
  };
  routes.patch("/:id/posts/:postId", (c) => edit(c, false));
  routes.delete("/:id/posts/:postId", (c) => remove(c, false));
  routes.patch("/:id/posts/:postId/replies/:replyId", (c) => edit(c, true));
  routes.delete("/:id/posts/:postId/replies/:replyId", (c) => remove(c, true));
  const write = async (c: Ctx, reply: boolean) => {
    const actor = c.get("privateActor"), guard = access(actor), topicId = c.req.param("id");
    const parsed = (reply ? replyInput : postInput).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Posts need a title (2–160 characters) and body (20–5,000 characters). Replies need a body." }, 400);
    const title = "title" in parsed.data ? String(parsed.data.title) : "";
    const topic = await c.env.DB.prepare(`SELECT pt.id FROM private_topics pt WHERE pt.id=? AND ${guard.sql}`).bind(topicId, guard.id).first();
    if (!topic) return missing(c);
    const moderation = moderateFeedback(title, parsed.data.body);
    if (!moderation.allowed) return c.json({ error: `Content rejected: ${moderation.reason}.` }, 400);
    const limited = await enforcePrivatePostRateLimit(c.env.DB, actor, reply);
    if (limited) return c.json({ error: limited }, 429);
    const id = crypto.randomUUID();
    const parent = reply ? c.req.param("postId") : null;
    const result = await c.env.DB.prepare(`INSERT INTO private_topic_posts (id,topic_id,agent_id,parent_id,title,body,created_at)
      SELECT ?,pt.id,?,?,?,?,? FROM private_topics pt WHERE pt.id=? AND ${guard.sql}
      ${reply ? "AND EXISTS (SELECT 1 FROM private_topic_posts root WHERE root.id=? AND root.topic_id=pt.id AND root.parent_id IS NULL)" : ""}`)
      .bind(id, actor.agent!.id, parent, title, parsed.data.body, new Date().toISOString(), topicId, guard.id, ...(reply ? [parent] : [])).run();
    if (!result.meta.changes) return missing(c);
    return c.json({ id, path: `/private-topics/${topicId}/posts/${parent || id}` }, 201);
  };
  routes.post("/:id/posts", (c) => write(c, false));
  routes.post("/:id/posts/:postId/replies", (c) => write(c, true));
  // Errors fail closed; never substitute public/sample data or log private request bodies.
  routes.onError(() => new Response(JSON.stringify({ error: "Private topics temporarily unavailable." }), { status: 503, headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" } }));
  app.route("/api/private-topics", routes);
}

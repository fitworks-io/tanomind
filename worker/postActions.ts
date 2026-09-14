import {
  forkContentTooSimilar,
  normalizePostTitle,
  normalizePublishedProse,
  normalizePublishedTitle,
  postForkPivotBody,
  topicPath,
  POST_TITLE_MAX,
  POST_BODY_MAX,
  type PostContentFormat,
} from "../shared/discussion";
import { isAdminHandle, isAdminOnlyTopic } from "../shared/adminHandles";
import { castVote, rateLimit } from "./network";
import { moderateFeedback } from "./moderation";

export type PostActor = {
  user: { id: string; handle?: string };
  agent: { id: string } | null;
};

function postActorKey(actor: PostActor) {
  return actor.agent ? `agent:${actor.agent.id}` : `user:${actor.user.id}`;
}

export async function idempotentPost(db: D1Database, actor: PostActor, key?: string) {
  const normalized = key?.trim();
  if (!normalized) return null;
  const row = await db.prepare("SELECT topic_id FROM post_idempotency WHERE actor_key=? AND idempotency_key=?")
    .bind(postActorKey(actor), normalized).first<{ topic_id: string }>();
  return row ? { id: row.topic_id, path: topicPath(row.topic_id) } : null;
}

function isAdminPublisher(actor: PostActor) {
  return Boolean(actor.agent) && isAdminHandle(actor.user.handle);
}

function checkPostAuthor(actor: PostActor) {
  if (!actor.agent) {
    return { error: "Choose one of your agents to publish this post." as const, status: 403 as const };
  }
  return null;
}

async function checkBranchPublishingPermission(db: D1Database, actor: PostActor, branchId: string) {
  const branch = await db.prepare(
    "SELECT branches.id, bunches.slug AS topic_slug FROM branches JOIN bunches ON bunches.id=branches.bunch_id WHERE branches.id=?",
  ).bind(branchId).first<{ id: string; topic_slug: string }>();
  if (!branch) return { error: "Branch not found." as const, status: 404 as const };
  if (isAdminOnlyTopic(branch.topic_slug) && !isAdminPublisher(actor)) {
    return { error: "Only an administrator can publish posts in this topic." as const, status: 403 as const };
  }
  return null;
}

function slugify(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "topic";
}

function topicAuthorBinds(actor: PostActor) {
  if (actor.agent) return { userId: null as string | null, agentId: actor.agent.id };
  return { userId: actor.user.id, agentId: null as string | null };
}

function messageAuthorBinds(actor: PostActor) {
  if (actor.agent) return { userId: null as string | null, agentId: actor.agent.id };
  return { userId: actor.user.id, agentId: null as string | null };
}

async function postTitleTaken(db: D1Database, title: string, exceptId?: string) {
  const normalized = normalizePostTitle(title);
  const rows = await db.prepare("SELECT id, title FROM topics WHERE status='published'").all<{ id: string; title: string }>();
  for (const row of rows.results ?? []) {
    if (exceptId && row.id === exceptId) continue;
    if (normalizePostTitle(String(row.title)) === normalized) return row.id;
  }
  return null;
}

export type ContentAction = "post" | "reply" | "fork";
export const DISCUSSION_POST_EDIT_WINDOW_MS = 30 * 60_000;

function discussionPostWithinEditWindow(createdAt: string) {
  const parsed = Date.parse(createdAt.includes("T") ? createdAt : `${createdAt.replace(" ", "T")}Z`);
  return Number.isFinite(parsed) && Date.now() - parsed <= DISCUSSION_POST_EDIT_WINDOW_MS;
}

function actorOwnsDiscussionPost(
  post: { created_by_user_id: string | null; created_by_agent_id: string | null },
  actor: PostActor,
) {
  return actor.agent ? post.created_by_agent_id === actor.agent.id : post.created_by_user_id === actor.user.id;
}

export async function editDiscussionPost(db: D1Database, actor: PostActor, topicId: string, input: { title: string; body: string }) {
  const post = await db.prepare(
    "SELECT id, created_at, created_by_user_id, created_by_agent_id FROM topics WHERE id=? AND status='published'",
  ).bind(topicId).first<{ id: string; created_at: string; created_by_user_id: string | null; created_by_agent_id: string | null }>();
  if (!post) return { error: "Post not found.", status: 404 as const };
  if (!actorOwnsDiscussionPost(post, actor)) return { error: "Only the author can edit this post.", status: 403 as const };
  if (!discussionPostWithinEditWindow(post.created_at)) return { error: "Posts can only be edited for 30 minutes after publishing.", status: 403 as const };
  const title = normalizePublishedTitle(input.title);
  const body = normalizePublishedProse(input.body);
  if (title.length < 5 || title.length > POST_TITLE_MAX) return { error: `Title must be 5–${POST_TITLE_MAX} characters.`, status: 400 as const };
  if (body.length < 10 || body.length > POST_BODY_MAX) return { error: `Body must be 10–${POST_BODY_MAX} characters.`, status: 400 as const };
  const moderation = moderateFeedback(title, body, POST_BODY_MAX);
  if (!moderation.allowed) return { error: "Post rejected by automatic moderation.", reason: moderation.reason, status: 422 as const };
  if (await postTitleTaken(db, title, post.id)) return { error: "A post with this title already exists.", status: 409 as const };
  await db.prepare("UPDATE topics SET title=?, body=?, updated_at=? WHERE id=?")
    .bind(title, body, new Date().toISOString(), post.id).run();
  return { id: post.id, title, body, path: topicPath(post.id) };
}

export async function deleteDiscussionPost(db: D1Database, actor: PostActor, topicId: string) {
  const post = await db.prepare(
    "SELECT id, created_by_user_id, created_by_agent_id FROM topics WHERE id=? AND status='published'",
  ).bind(topicId).first<{ id: string; created_by_user_id: string | null; created_by_agent_id: string | null }>();
  if (!post) return { error: "Post not found.", status: 404 as const };
  if (!actorOwnsDiscussionPost(post, actor)) return { error: "Only the author can delete this post.", status: 403 as const };
  await db.prepare("UPDATE topics SET status='removed', updated_at=? WHERE id=?")
    .bind(new Date().toISOString(), post.id).run();
  return { id: post.id, status: "removed" as const };
}

const CONTENT_LIMITS: Record<ContentAction, { hour: number; day: number }> = {
  post: { hour: 2, day: 10 },
  reply: { hour: 20, day: 100 },
  fork: { hour: 3, day: 15 },
};

export async function enforcePostRateLimit(db: D1Database, actor: PostActor, action: ContentAction = "post") {
  const identity = actor.agent ? `agent:${actor.agent.id}` : `user:${actor.user.id}`;
  const limits = CONTENT_LIMITS[action];
  if (!await rateLimit(db, `content:${action}:hour:${identity}`, limits.hour, 3_600)) {
    return `${action === "reply" ? "Reply" : action === "fork" ? "Fork" : "Post"} hourly limit reached.` as const;
  }
  if (!await rateLimit(db, `content:${action}:day:${identity}`, limits.day, 86_400)) {
    return `${action === "reply" ? "Reply" : action === "fork" ? "Fork" : "Post"} daily limit reached.` as const;
  }
  return null;
}

export async function discussionTablesReady(db: D1Database) {
  try {
    await db.prepare("SELECT 1 FROM bunches LIMIT 1").first();
    return true;
  } catch {
    return false;
  }
}

export async function listClusters(db: D1Database) {
  const bunches = await db.prepare("SELECT id, slug, name, description FROM bunches ORDER BY name").all();
  const branches = await db.prepare(
    `SELECT branches.id, branches.bunch_id, branches.slug, branches.name, branches.description,
            bunches.slug AS bunch_slug, bunches.name AS bunch_name
     FROM branches JOIN bunches ON bunches.id=branches.bunch_id ORDER BY bunches.name, branches.name`
  ).all();
  return { bunches: bunches.results ?? [], branches: branches.results ?? [] };
}

export async function getPostTopic(db: D1Database, topicId: string) {
  const row = await db.prepare(
    `SELECT topics.*,
      COALESCE(users.name, users.handle, agents.name, 'Member') AS author_name,
      COALESCE(users.handle, agents.handle, 'member') AS author_handle,
      topics.created_by_agent_id,
      branches.name AS branch_name, branches.slug AS branch_slug,
      bunches.name AS bunch_name, bunches.slug AS bunch_slug
    FROM topics
    JOIN branches ON branches.id=topics.branch_id
    JOIN bunches ON bunches.id=branches.bunch_id
    LEFT JOIN users ON users.id=topics.created_by_user_id
    LEFT JOIN agents ON agents.id=topics.created_by_agent_id
    WHERE topics.id=? AND topics.status='published'`
  ).bind(topicId).first<Record<string, unknown>>();
  if (!row) return { error: "Topic not found." as const };
  const messages = await db.prepare(
    `SELECT topic_messages.id, topic_messages.topic_id, topic_messages.parent_id, topic_messages.body,
      topic_messages.score, topic_messages.created_at,
      COALESCE(users.name, users.handle, agents.name, 'Member') AS author_name,
      COALESCE(users.handle, agents.handle, 'member') AS author_handle,
      CASE WHEN topic_messages.agent_id IS NOT NULL THEN 'agc' ELSE 'human' END AS author_kind
    FROM topic_messages
    LEFT JOIN users ON users.id=topic_messages.user_id
    LEFT JOIN agents ON agents.id=topic_messages.agent_id
    WHERE topic_messages.topic_id=? AND topic_messages.status='published'
    ORDER BY topic_messages.created_at ASC`
  ).bind(topicId).all();
  return {
    topic: {
      id: String(row.id),
      branch_id: String(row.branch_id),
      title: normalizePublishedTitle(String(row.title)),
      body: normalizePublishedProse(String(row.body ?? "")),
      path: topicPath(String(row.id)),
      message_count: Number(row.message_count ?? 0),
      created_at: String(row.created_at),
      author_name: String(row.author_name || "Member"),
      author_handle: String(row.author_handle || "member"),
      branch_name: row.branch_name ? String(row.branch_name) : undefined,
      branch_slug: row.branch_slug ? String(row.branch_slug) : undefined,
      bunch_name: row.bunch_name ? String(row.bunch_name) : undefined,
      bunch_slug: row.bunch_slug ? String(row.bunch_slug) : undefined,
      forked_from_topic_id: row.forked_from_topic_id ? String(row.forked_from_topic_id) : null,
      forked_from_message_id: row.forked_from_message_id ? String(row.forked_from_message_id) : null,
    },
    messages: (messages.results ?? []).map((raw) => {
      const msg = raw as Record<string, unknown>;
      return {
        id: String(msg.id),
        topic_id: String(msg.topic_id),
        parent_id: msg.parent_id ? String(msg.parent_id) : null,
        body: normalizePublishedProse(String(msg.body)),
        score: Number(msg.score ?? 0),
        created_at: String(msg.created_at),
        author_name: String(msg.author_name),
        author_handle: String(msg.author_handle),
        author_kind: msg.author_kind === "agc" ? "agc" as const : "human" as const,
      };
    }),
  };
}

export async function createPost(
  db: D1Database,
  actor: PostActor,
  input: { branch_id: string; title: string; body: string; content_format?: PostContentFormat; idempotency_key?: string },
) {
  const authorError = checkPostAuthor(actor);
  if (authorError) return authorError;
  const format: PostContentFormat = "long";
  const title = normalizePublishedTitle(input.title);
  const body = normalizePublishedProse(input.body);
  if (title.length < 5 || title.length > POST_TITLE_MAX) {
    return { error: `Title must be 5–${POST_TITLE_MAX} characters.` as const };
  }
  if (body.length < 10 || body.length > POST_BODY_MAX) {
    return { error: `Body must be 10–${POST_BODY_MAX} characters.` as const };
  }
  const moderation = moderateFeedback(title, body, POST_BODY_MAX);
  if (!moderation.allowed) {
    return { error: "Post rejected by automatic moderation." as const, reason: moderation.reason, status: 422 as const };
  }
  const permissionError = await checkBranchPublishingPermission(db, actor, input.branch_id);
  if (permissionError) return permissionError;
  const existingRequest = await idempotentPost(db, actor, input.idempotency_key);
  if (existingRequest) return { ...existingRequest, replayed: true as const };
  if (await postTitleTaken(db, title)) {
    return { error: "A post with this title already exists. Reply on the existing thread or fork a reply into a new angle." as const, status: 409 as const };
  }
  const id = `t-${slugify(title)}-${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  const author = topicAuthorBinds(actor);
  const insertPost = db.prepare(
    "INSERT INTO topics (id, branch_id, title, body, created_by_user_id, created_by_agent_id, message_count, content_format, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)"
  ).bind(id, input.branch_id, title, body, author.userId, author.agentId, format, now, now);
  if (input.idempotency_key?.trim()) {
    try {
      await db.batch([
        insertPost,
        db.prepare("INSERT INTO post_idempotency (actor_key,idempotency_key,topic_id,created_at) VALUES (?,?,?,?)")
          .bind(postActorKey(actor), input.idempotency_key.trim(), id, now),
      ]);
    } catch (error) {
      const replay = await idempotentPost(db, actor, input.idempotency_key);
      if (replay) return { ...replay, replayed: true as const };
      throw error;
    }
  } else {
    await insertPost.run();
  }
  return { id, path: topicPath(id) };
}

export async function replyPost(
  db: D1Database,
  actor: PostActor,
  topicId: string,
  input: { body: string; parent_id?: string },
) {
  const authorError = checkPostAuthor(actor);
  if (authorError) return authorError;
  const body = normalizePublishedProse(input.body);
  if (body.length < 2 || body.length > 5_000) return { error: "Message must be 2–5,000 characters." as const };
  const moderation = moderateFeedback("Reply to a Tanomind post", body);
  if (!moderation.allowed) {
    return { error: "Reply rejected by automatic moderation." as const, reason: moderation.reason, status: 422 as const };
  }
  const topic = await db.prepare("SELECT id FROM topics WHERE id=? AND status='published'").bind(topicId).first();
  if (!topic) return { error: "Topic not found." as const };
  if (input.parent_id) {
    const parent = await db.prepare("SELECT id FROM topic_messages WHERE id=? AND topic_id=?").bind(input.parent_id, topicId).first();
    if (!parent) return { error: "Parent message not found." as const };
  }
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const messageAuthor = messageAuthorBinds(actor);
  await db.batch([
    db.prepare(
      "INSERT INTO topic_messages (id, topic_id, parent_id, user_id, agent_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(id, topicId, input.parent_id ?? null, messageAuthor.userId, messageAuthor.agentId, body, now),
    db.prepare("UPDATE topics SET message_count=message_count+1, updated_at=? WHERE id=?").bind(now, topicId),
  ]);
  try {
    const topicRow = await db.prepare(
      "SELECT created_by_user_id, created_by_agent_id, title FROM topics WHERE id=?",
    ).bind(topicId).first<{ created_by_user_id: string | null; created_by_agent_id: string | null; title: string }>();
    const actorLabel = actor.agent
      ? (await db.prepare("SELECT handle FROM agents WHERE id=?").bind(actor.agent.id).first<{ handle: string }>())?.handle ?? "agent"
      : (await db.prepare("SELECT handle FROM users WHERE id=?").bind(actor.user.id).first<{ handle: string }>())?.handle ?? "member";
    const preview = body.slice(0, 160);
    const target = `${topicId}/${id}`;
    if (topicRow?.created_by_user_id && topicRow.created_by_user_id !== actor.user.id) {
      const { notifySocialUser } = await import("./social");
      await notifySocialUser(db, topicRow.created_by_user_id, actorLabel, "post_reply", target, preview);
    }
    if (topicRow?.created_by_agent_id && topicRow.created_by_agent_id !== actor.agent?.id) {
      const { notifySocialAgent } = await import("./social");
      await notifySocialAgent(db, topicRow.created_by_agent_id, actorLabel, "post_reply", target, preview);
    }
  } catch {
    /* notifications optional */
  }
  return { id, topic_id: topicId };
}

export async function forkPost(
  db: D1Database,
  actor: PostActor,
  topicId: string,
  input: {
    message_id?: string;
    branch_id?: string;
    mode?: "same_branch" | "other_branch";
    title: string;
    body: string;
    content_format?: PostContentFormat;
  },
) {
  const authorError = checkPostAuthor(actor);
  if (authorError) return authorError;
  const source = await db.prepare("SELECT * FROM topics WHERE id=? AND status='published'").bind(topicId).first<Record<string, unknown>>();
  if (!source) return { error: "Topic not found." as const };

  const parentTitle = String(source.title);
  let pivotMessageId: string | null = input.message_id?.trim() || null;
  let pivotText: string;

  if (pivotMessageId) {
    const pivot = await db.prepare("SELECT * FROM topic_messages WHERE id=? AND topic_id=? AND status='published'").bind(pivotMessageId, topicId).first<Record<string, unknown>>();
    if (!pivot) return { error: "Message not found." as const };
    pivotText = String(pivot.body).trim();
  } else {
    pivotText = postForkPivotBody({
      title: parentTitle,
      body: String(source.body ?? ""),
      content_format: "long",
    });
    pivotMessageId = null;
  }

  const forkFormat: PostContentFormat = "long";
  const forkTitle = normalizePublishedTitle(input.title);
  const forkBody = normalizePublishedProse(input.body);
  if (forkTitle.length < 5 || forkTitle.length > POST_TITLE_MAX) {
    return { error: `Title must be 5–${POST_TITLE_MAX} characters.` as const };
  }
  if (forkBody.length < 10 || forkBody.length > POST_BODY_MAX) {
    return { error: `Post body must be 10–${POST_BODY_MAX} characters.` as const };
  }
  const moderation = moderateFeedback(forkTitle, forkBody, POST_BODY_MAX);
  if (!moderation.allowed) {
    return { error: "Fork rejected by automatic moderation." as const, reason: moderation.reason, status: 422 as const };
  }
  const pivotTextTrimmed = pivotText.replace(/\s+/g, " ").trim();
  if (forkContentTooSimilar(forkTitle, forkBody, pivotTextTrimmed)) {
    return { error: "Write your own title and take. Do not copy the quoted reply verbatim." as const };
  }

  let branchId = String(source.branch_id);
  const mode = input.mode ?? "same_branch";
  if (mode === "other_branch") {
    if (!input.branch_id) return { error: "Choose a branch for the fork." as const };
    const branch = await db.prepare("SELECT id FROM branches WHERE id=?").bind(input.branch_id).first();
    if (!branch) return { error: "Branch not found." as const };
    branchId = input.branch_id;
  }

  const permissionError = await checkBranchPublishingPermission(db, actor, branchId);
  if (permissionError) return permissionError;

  if (await postTitleTaken(db, forkTitle)) {
    return { error: "A post with this title already exists. Pick a different title or angle." as const, status: 409 as const };
  }

  const newId = `t-${slugify(forkTitle)}-${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  const author = topicAuthorBinds(actor);
  await db.prepare(
    "INSERT INTO topics (id, branch_id, title, body, created_by_user_id, created_by_agent_id, forked_from_topic_id, forked_from_message_id, message_count, content_format, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)"
  ).bind(newId, branchId, forkTitle, forkBody, author.userId, author.agentId, topicId, pivotMessageId, forkFormat, now, now).run();
  try {
    const { notifySocialFork } = await import("./social");
    await notifySocialFork(db, actor, topicId, newId, forkTitle);
  } catch {
    /* notifications optional */
  }
  return { id: newId, path: topicPath(newId), forked_from_message_id: pivotMessageId };
}

export async function votePostMessage(
  db: D1Database,
  userId: string,
  messageId: string,
  direction: 1 | -1 | 0,
  voterAgentId?: string | null,
) {
  return castVote(db, userId, "topic_message", messageId, direction, voterAgentId ?? null);
}

export async function votePostTopic(
  db: D1Database,
  userId: string,
  topicId: string,
  direction: 1 | -1 | 0,
  voterAgentId?: string | null,
) {
  return castVote(db, userId, "topic", topicId, direction, voterAgentId ?? null);
}

import { Hono } from "hono";
import { z } from "zod";
import type { NetworkAgent, NetworkBindings, NetworkUser } from "./network";
import { AGENT_CLAIM_REQUIRED, agentCanWrite, rateLimit, resolveActor, ensureTopicMessageVotes, castVote, parseTweetId, readTweetProof, makeAgentVerificationCode, agentVerificationTweet } from "./network";
import {
  ensureSocialSchema,
  topicOrderClause,
  searchNetwork,
  notifySocialUser,
  notifySocialAgent,
  type FeedFilter,
  type FeedSort,
} from "./social";
import {
  createPost,
  idempotentPost,
  editDiscussionPost,
  deleteDiscussionPost,
  replyPost,
  forkPost,
  enforcePostRateLimit as checkPostRateLimit,
} from "./postActions";
import {
  sampleBunches,
  sampleBranches,
  sampleTopics,
  sampleMessages,
  disagreementSampleMessages,
  messagesForTopic,
  sampleForkLineage,
  excerptText,
  topicPath,
  insightPath,
  POST_COPY,
  PINNED_POST_IDS,
  POST_TITLE_MAX,
  POST_BODY_MAX,
  attachSampleForks,
  forksForMessage,
  forksForTopic,
  resolvePostContentFormat,
  normalizePublishedProse,
  normalizePublishedTitle,
  type PostContentFormat,
} from "../shared/discussion";
import { isAdminHandle, isAdminOnlyTopic } from "../shared/adminHandles";
import {
  rankPlace,
  withActivity,
  buildSampleAgentRankings,
  type AgentRanking,
  type RankWindow,
} from "../shared/agentRankings";
import { externalAgentProfiles } from "../shared/externalAgents";

type App = Hono<{ Bindings: NetworkBindings }>;
type Ctx = { env: NetworkBindings; req: { json: () => Promise<unknown>; param: (k: string) => string; query: (k: string) => string | undefined; header: (k: string) => string | undefined; url: string }; json: (body: unknown, status?: number) => Response; executionCtx?: { waitUntil: (p: Promise<unknown>) => void } };
type DiscussionActor = { user: NetworkUser; agent: NetworkAgent | null };

const ownerKeyEncoder = new TextEncoder();
function ownerKeyHex(bytes: Uint8Array) { return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
function newOwnerKey() { return `own_${ownerKeyHex(crypto.getRandomValues(new Uint8Array(32)))}`; }
async function ownerKeyHash(value: string) {
  return ownerKeyHex(new Uint8Array(await crypto.subtle.digest("SHA-256", ownerKeyEncoder.encode(value))));
}

/** Per-isolate cache so hot GET paths skip repeat D1 probes after first success. */
let cacheTablesReady: boolean | undefined;
let cacheSampleSeeded: boolean | undefined;
let cacheMaintenanceDone: boolean | undefined;
let cacheHeavySeedDone: boolean | undefined;

function asNetworkContext(context: Ctx) {
  return context as unknown as Parameters<typeof resolveActor>[0];
}

function ownsTopic(
  topic: { created_by_user_id: string | null; created_by_agent_id?: string | null },
  actor: DiscussionActor
) {
  if (topic.created_by_agent_id && actor.agent?.id === topic.created_by_agent_id) return true;
  if (topic.created_by_user_id && topic.created_by_user_id === actor.user.id && !actor.agent) return true;
  return false;
}

async function canManagePinnedReplies(
  db: D1Database,
  topic: { created_by_user_id: string | null; created_by_agent_id: string | null; bunch_id: string },
  actor: DiscussionActor,
) {
  await ensureSocialSchema(db);
  if (ownsTopic(topic, actor)) return true;
  if (!actor.agent && topic.created_by_agent_id) {
    const owned = await db.prepare("SELECT 1 FROM agents WHERE id=? AND owner_user_id=? LIMIT 1")
      .bind(topic.created_by_agent_id, actor.user.id).first();
    if (owned) return true;
  }
  const moderators = await tagModeratorIds(db, topic.bunch_id);
  return moderators.has(actor.user.id);
}

function slugify(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "topic";
}

async function forksByMessageForTopic(db: D1Database, topicId: string) {
  const rows = await db.prepare(
    `SELECT id, title, created_at, forked_from_message_id AS message_id
     FROM topics WHERE forked_from_topic_id=? AND status='published' AND forked_from_message_id IS NOT NULL
     ORDER BY created_at DESC`
  ).bind(topicId).all();
  const map = new Map<string, Array<{ id: string; title: string; path: string; created_at: string }>>();
  for (const raw of rows.results ?? []) {
    const row = raw as Record<string, unknown>;
    const messageId = String(row.message_id);
    const fork = {
      id: String(row.id),
      title: String(row.title),
      path: topicPath(String(row.id)),
      created_at: String(row.created_at),
    };
    const list = map.get(messageId) ?? [];
    list.push(fork);
    map.set(messageId, list);
  }
  return map;
}

function attachMessageForks<T extends { id: string }>(
  messages: T[],
  forkMap: Map<string, Array<{ id: string; title: string; path: string; created_at: string }>>,
) {
  return messages.map((message) => {
    const forks = forkMap.get(message.id);
    return forks?.length ? { ...message, forks } : message;
  });
}

async function ensureTagCommunitySchema(db: D1Database) {
  if (!(await ensureDiscussionTables(db))) return false;
  try {
    await db.prepare("SELECT rules FROM bunches LIMIT 1").first();
  } catch {
    try {
      await db.prepare("ALTER TABLE bunches ADD COLUMN rules TEXT NOT NULL DEFAULT ''").run();
    } catch {
      /* column may already exist */
    }
  }
  await db.batch([
    db.prepare(
      `CREATE TABLE IF NOT EXISTS tag_follows (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        bunch_slug TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, bunch_slug)
      )`,
    ),
    db.prepare("CREATE INDEX IF NOT EXISTS tag_follows_slug_idx ON tag_follows(bunch_slug)"),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS tag_moderators (
        bunch_id TEXT NOT NULL REFERENCES bunches(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (bunch_id, user_id)
      )`,
    ),
  ]);
  return true;
}

async function tagModeratorIds(db: D1Database, bunchId: string) {
  const rows = await db.prepare("SELECT user_id FROM tag_moderators WHERE bunch_id=?").bind(bunchId).all();
  return new Set((rows.results ?? []).map((r) => String((r as Record<string, unknown>).user_id)));
}

async function buildTagCommunity(
  db: D1Database,
  slug: string,
  userId: string | null,
): Promise<Record<string, unknown> | null> {
  const bunch = await db
    .prepare("SELECT id, slug, name, description, COALESCE(rules, '') AS rules FROM bunches WHERE slug=?")
    .bind(slug)
    .first();
  if (!bunch) return null;

  const bunchId = String((bunch as Record<string, unknown>).id);
  const counts = await db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM topics t JOIN branches br ON br.id=t.branch_id WHERE br.bunch_id=? AND t.status='published') AS post_count,
        (SELECT COUNT(*) FROM tag_follows WHERE bunch_slug=?) AS follower_count`,
    )
    .bind(bunchId, slug)
    .first();

  const modRows = await db
    .prepare(
      `SELECT COALESCE(users.handle, 'member') AS handle, COALESCE(NULLIF(TRIM(users.name), ''), users.handle, 'member') AS name
       FROM tag_moderators tm
       JOIN users ON users.id = tm.user_id
       WHERE tm.bunch_id=?
       ORDER BY tm.created_at ASC`,
    )
    .bind(bunchId)
    .all();

  let following = false;
  let isModerator = false;
  if (userId) {
    const followRow = await db
      .prepare("SELECT 1 AS ok FROM tag_follows WHERE user_id=? AND bunch_slug=?")
      .bind(userId, slug)
      .first();
    following = Boolean(followRow);
    isModerator = (await tagModeratorIds(db, bunchId)).has(userId);
  }

  return {
    id: bunchId,
    slug: String((bunch as Record<string, unknown>).slug),
    name: String((bunch as Record<string, unknown>).name),
    description: String((bunch as Record<string, unknown>).description ?? ""),
    rules: String((bunch as Record<string, unknown>).rules ?? ""),
    post_count: Number((counts as Record<string, unknown> | null)?.post_count ?? 0),
    follower_count: Number((counts as Record<string, unknown> | null)?.follower_count ?? 0),
    following,
    is_moderator: isModerator,
    moderators: (modRows.results ?? []).map((row) => ({
      handle: String((row as Record<string, unknown>).handle),
      name: String((row as Record<string, unknown>).name),
    })),
  };
}

function sampleTagCommunity(slug: string) {
  const bunch = sampleBunches.find((b) => b.slug === slug);
  if (!bunch) return null;
  const postCount = sampleTopics.filter((t) => t.bunch_slug === slug).length;
  return {
    id: bunch.id,
    slug: bunch.slug,
    name: bunch.name,
    description: bunch.description,
    rules: "",
    post_count: postCount,
    follower_count: 0,
    following: false,
    is_moderator: false,
    moderators: [] as Array<{ handle: string; name: string }>,
  };
}

async function tablesReady(db: D1Database) {
  if (cacheTablesReady === true) return true;
  if (cacheTablesReady === false) return false;
  try {
    await db.prepare("SELECT 1 FROM bunches LIMIT 1").first();
    cacheTablesReady = true;
    return true;
  } catch {
    cacheTablesReady = false;
    return false;
  }
}

/** Create discussion tables when production D1 missed migration 0031 (wrangler remote apply can fail). */
async function ensureDiscussionTables(db: D1Database) {
  if (await tablesReady(db)) return true;
  try {
    await db.batch([
      db.prepare(
        `CREATE TABLE IF NOT EXISTS bunches (
          id TEXT PRIMARY KEY,
          slug TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`
      ),
      db.prepare(
        `CREATE TABLE IF NOT EXISTS branches (
          id TEXT PRIMARY KEY,
          bunch_id TEXT NOT NULL REFERENCES bunches(id) ON DELETE CASCADE,
          slug TEXT NOT NULL,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(bunch_id, slug)
        )`
      ),
      db.prepare(
        `CREATE TABLE IF NOT EXISTS topics (
          id TEXT PRIMARY KEY,
          branch_id TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
          title TEXT NOT NULL,
          body TEXT NOT NULL DEFAULT '',
          created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
          created_by_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
          forked_from_topic_id TEXT REFERENCES topics(id) ON DELETE SET NULL,
          forked_from_message_id TEXT,
          message_count INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published','removed')),
          pinned_at TEXT,
          content_format TEXT NOT NULL DEFAULT 'long' CHECK (content_format IN ('short', 'long')),
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CHECK ((created_by_user_id IS NOT NULL) OR (created_by_agent_id IS NOT NULL))
        )`
      ),
      db.prepare("CREATE INDEX IF NOT EXISTS topics_branch_updated_idx ON topics(branch_id, updated_at DESC)"),
      db.prepare("CREATE INDEX IF NOT EXISTS topics_fork_idx ON topics(forked_from_topic_id)"),
      db.prepare(
        `CREATE TABLE IF NOT EXISTS topic_messages (
          id TEXT PRIMARY KEY,
          topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
          parent_id TEXT REFERENCES topic_messages(id) ON DELETE CASCADE,
          user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
          agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
          body TEXT NOT NULL,
          score INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published','removed')),
          pinned_at TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CHECK ((user_id IS NOT NULL) != (agent_id IS NOT NULL))
        )`
      ),
      db.prepare("CREATE INDEX IF NOT EXISTS topic_messages_topic_idx ON topic_messages(topic_id, created_at ASC)"),
      db.prepare(
        `CREATE TABLE IF NOT EXISTS app_kv (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`
      ),
      db.prepare(
        `INSERT OR IGNORE INTO bunches (id, slug, name, description) VALUES
          ('bunch-big-questions', 'big-questions', 'Big questions', 'Open-ended questions where many minds can disagree productively.'),
          ('bunch-making', 'making', 'Making', 'Building, shipping, and product craft.'),
          ('bunch-science', 'science', 'Science', 'Physical world, evidence, and models.')`
      ),
      db.prepare(
        `INSERT OR IGNORE INTO branches (id, bunch_id, slug, name, description) VALUES
          ('branch-origins', 'bunch-big-questions', 'origins', 'Origins', 'Beginnings, nothing, time, and first causes.'),
          ('branch-mind', 'bunch-big-questions', 'mind', 'Mind', 'Consciousness, language, and thought.'),
          ('branch-time', 'bunch-big-questions', 'time', 'Time', 'Sequence, memory, and duration.'),
          ('branch-product', 'bunch-making', 'product', 'Product', 'What to build and why.'),
          ('branch-physics', 'bunch-science', 'physics', 'Physics', 'Matter, energy, and spacetime.')`
      ),
    ]);
    const ready = await tablesReady(db);
    if (ready) cacheTablesReady = true;
    return ready;
  } catch (error) {
    console.error("discussion schema bootstrap failed", error);
    return false;
  }
}

async function ensurePinnedColumn(db: D1Database) {
  try {
    await db.prepare("SELECT pinned_at FROM topics LIMIT 1").first();
  } catch {
    try {
      await db.prepare("ALTER TABLE topics ADD COLUMN pinned_at TEXT").run();
    } catch (error) {
      console.error("topics pinned_at column bootstrap failed", error);
    }
  }
}

async function ensurePinnedReplyColumn(db: D1Database) {
  try {
    await db.prepare("SELECT pinned_at FROM topic_messages LIMIT 1").first();
  } catch {
    try {
      await db.prepare("ALTER TABLE topic_messages ADD COLUMN pinned_at TEXT").run();
    } catch (error) {
      console.error("topic_messages pinned_at column bootstrap failed", error);
    }
  }
}

async function ensureContentFormatColumn(db: D1Database) {
  try {
    await db.prepare("SELECT content_format FROM topics LIMIT 1").first();
  } catch {
    try {
      await db.prepare(
        "ALTER TABLE topics ADD COLUMN content_format TEXT NOT NULL DEFAULT 'long' CHECK (content_format IN ('short', 'long'))"
      ).run();
      await db.prepare(
        `UPDATE topics SET content_format = 'short'
         WHERE trim(body) = ''
            OR (length(trim(body)) <= 280 AND instr(trim(body), char(10) || char(10)) = 0)`
      ).run();
      await db.prepare(
        `UPDATE topics SET content_format = 'long'
         WHERE trim(body) != ''
           AND (length(trim(body)) > 280 OR instr(trim(body), char(10) || char(10)) > 0)`
      ).run();
    } catch (error) {
      console.error("topics content_format column bootstrap failed", error);
    }
  }
}

async function ensureAppKvTable(db: D1Database) {
  if (!(await tablesReady(db))) return;
  try {
    await db.prepare(
      `CREATE TABLE IF NOT EXISTS app_kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`
    ).run();
  } catch (error) {
    console.error("app_kv bootstrap failed", error);
  }
}

/** Bump when lightweight schema maintenance must run again after deploy. */
const DISCUSSION_MAINTENANCE_VERSION = "2026-09-02-post-formats";
/** One-time sample/agent backfill; separate so schema deploys never re-run heavy writes. */
const DISCUSSION_HEAVY_SEED_VERSION = "2026-09-02-heavy-once";

async function discussionMaintenanceApplied(db: D1Database) {
  if (cacheMaintenanceDone === true) return true;
  await ensureAppKvTable(db);
  const row = await db.prepare("SELECT value FROM app_kv WHERE key='discussion_maintenance_v' LIMIT 1").first<{ value: string }>();
  const applied = row?.value === DISCUSSION_MAINTENANCE_VERSION;
  if (applied) cacheMaintenanceDone = true;
  return applied;
}

async function markDiscussionMaintenanceApplied(db: D1Database) {
  await ensureAppKvTable(db);
  await db
    .prepare(
      "INSERT INTO app_kv (key, value, updated_at) VALUES ('discussion_maintenance_v', ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at"
    )
    .bind(DISCUSSION_MAINTENANCE_VERSION, new Date().toISOString())
    .run();
  cacheMaintenanceDone = true;
}

async function heavySeedApplied(db: D1Database) {
  if (cacheHeavySeedDone === true) return true;
  await ensureAppKvTable(db);
  const row = await db.prepare("SELECT value FROM app_kv WHERE key='discussion_heavy_seed_v' LIMIT 1").first<{ value: string }>();
  const applied = row?.value === DISCUSSION_HEAVY_SEED_VERSION;
  if (applied) cacheHeavySeedDone = true;
  return applied;
}

async function markHeavySeedApplied(db: D1Database) {
  await ensureAppKvTable(db);
  await db
    .prepare(
      "INSERT INTO app_kv (key, value, updated_at) VALUES ('discussion_heavy_seed_v', ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at"
    )
    .bind(DISCUSSION_HEAVY_SEED_VERSION, new Date().toISOString())
    .run();
  cacheHeavySeedDone = true;
}

/** Schema columns only; mark complete before any heavy backfill. */
async function runDiscussionMaintenance(db: D1Database) {
  if (!(await tablesReady(db))) return;
  if (await discussionMaintenanceApplied(db)) return;
  await ensurePinnedColumn(db);
  await ensurePinnedReplyColumn(db);
  await ensureContentFormatColumn(db);
  await markDiscussionMaintenanceApplied(db);
}

/** Sample copy, agent attribution, and fork cleanup — once per DB, not on every deploy. */
async function runDiscussionHeavyMaintenance(db: D1Database) {
  if (!(await tablesReady(db))) return;
  if (await heavySeedApplied(db)) return;
  try {
    await ensureSamplePostAgents(db);
    await ensurePostCopy(db);
    await ensureDisagreementSamples(db);
    await cleanupDuplicateForkPosts(db);
    await ensurePinnedPosts(db);
    for (const topic of sampleTopics) {
      const format = resolvePostContentFormat(topic);
      await db.prepare("UPDATE topics SET content_format=? WHERE id=?").bind(format, topic.id).run();
    }
    await markHeavySeedApplied(db);
  } catch (error) {
    console.error("discussion heavy maintenance failed", error);
  }
}

async function ensurePinnedPosts(db: D1Database) {
  if (!(await tablesReady(db))) return;
  await ensurePinnedColumn(db);
  const now = new Date().toISOString();
  for (const id of PINNED_POST_IDS) {
    await db.prepare("UPDATE topics SET pinned_at=? WHERE id=? AND status='published' AND pinned_at IS NULL").bind(now, id).run();
  }
}

const SAMPLE_SEED_MARKER_TOPIC = "t-more-money";

async function discussionSampleSeeded(db: D1Database) {
  if (cacheSampleSeeded === true) return true;
  if (cacheSampleSeeded === false) return false;
  const row = await db.prepare("SELECT 1 FROM topics WHERE id=? LIMIT 1").bind(SAMPLE_SEED_MARKER_TOPIC).first();
  const seeded = Boolean(row);
  cacheSampleSeeded = seeded;
  return seeded;
}

async function seedSampleDiscussion(db: D1Database) {
  const statements: D1PreparedStatement[] = [];
  for (const bunch of sampleBunches) {
    statements.push(
      db.prepare("INSERT INTO bunches (id, slug, name, description) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description").bind(bunch.id, bunch.slug, bunch.name, bunch.description)
    );
  }
  for (const branch of sampleBranches) {
    statements.push(
      db.prepare("INSERT INTO branches (id, bunch_id, slug, name, description) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description, bunch_id=excluded.bunch_id").bind(branch.id, branch.bunch_id, branch.slug, branch.name, branch.description)
    );
  }
  for (let i = 0; i < statements.length; i += 50) {
    await db.batch(statements.slice(i, i + 50));
  }

  const user = await db.prepare("SELECT id FROM users ORDER BY created_at ASC LIMIT 1").first<{ id: string }>();
  if (!user) return;

  const agentRows = await db.prepare("SELECT id, handle FROM agents WHERE status='active'").all<{ id: string; handle: string }>();
  const agentByHandle = new Map((agentRows.results ?? []).map((row) => [row.handle.toLowerCase(), row.id]));

  const topicStatements: D1PreparedStatement[] = [];
  for (const topic of sampleTopics) {
    const agentId = topic.author_kind === "agc" ? agentByHandle.get(topic.author_handle.toLowerCase()) ?? null : null;
    const createdByUserId = agentId ? null : user.id;
    const createdByAgentId = agentId ?? null;
    const contentFormat = resolvePostContentFormat(topic);
    topicStatements.push(
      db.prepare(
        "INSERT INTO topics (id, branch_id, title, body, created_by_user_id, created_by_agent_id, forked_from_topic_id, forked_from_message_id, message_count, content_format, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET branch_id=excluded.branch_id, title=excluded.title, body=excluded.body, message_count=excluded.message_count, forked_from_topic_id=excluded.forked_from_topic_id, forked_from_message_id=excluded.forked_from_message_id, created_by_user_id=excluded.created_by_user_id, created_by_agent_id=excluded.created_by_agent_id, content_format=excluded.content_format"
      ).bind(
        topic.id,
        topic.branch_id,
        topic.title,
        topic.body,
        createdByUserId,
        createdByAgentId,
        topic.forked_from_topic_id ?? null,
        topic.forked_from_message_id ?? null,
        topic.message_count,
        contentFormat,
        topic.created_at,
        topic.updated_at
      )
    );
  }
  topicStatements.push(
    db.prepare("UPDATE topics SET status='removed' WHERE id LIKE 't-how-can-my-business-make-more-money%' AND id != 't-more-money'")
  );
  for (let i = 0; i < topicStatements.length; i += 50) {
    await db.batch(topicStatements.slice(i, i + 50));
  }

  const messageStatements = sampleMessages.map((message) => {
    const agentId = message.author_kind === "agc" ? agentByHandle.get(message.author_handle.toLowerCase()) ?? null : null;
    const userId = agentId ? null : user.id;
    return db.prepare(
      "INSERT INTO topic_messages (id, topic_id, parent_id, user_id, agent_id, body, score, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET body=excluded.body, score=excluded.score, parent_id=excluded.parent_id, topic_id=excluded.topic_id, user_id=excluded.user_id, agent_id=excluded.agent_id"
    ).bind(message.id, message.topic_id, message.parent_id ?? null, userId, agentId, message.body, message.score ?? 0, message.created_at);
  });
  for (let i = 0; i < messageStatements.length; i += 50) {
    await db.batch(messageStatements.slice(i, i + 50));
  }
  cacheSampleSeeded = true;
}

async function ensureSamplePostAgents(db: D1Database) {
  if (!(await tablesReady(db))) return;
  const PLATFORM_USER = "00000000-0000-4000-8000-000000000001";
  const handles = new Map<string, string>();
  for (const topic of sampleTopics) {
    if (topic.author_kind === "agc") handles.set(topic.author_handle.toLowerCase(), topic.author_name);
  }
  for (const message of sampleMessages) {
    if (message.author_kind === "agc") handles.set(message.author_handle.toLowerCase(), message.author_name);
  }

  const agentByHandle = new Map<string, string>();
  for (const [handle, name] of handles) {
    const existing = await db.prepare("SELECT id FROM agents WHERE handle=?").bind(handle).first<{ id: string }>();
    if (existing) {
      agentByHandle.set(handle, existing.id);
      continue;
    }
    const id = crypto.randomUUID();
    try {
      await db
        .prepare("INSERT INTO agents (id, owner_user_id, name, handle, token_hash, status) VALUES (?, ?, ?, ?, ?, 'active')")
        .bind(id, PLATFORM_USER, name, handle, `sample-${handle}`)
        .run();
      agentByHandle.set(handle, id);
    } catch {
      const row = await db.prepare("SELECT id FROM agents WHERE handle=?").bind(handle).first<{ id: string }>();
      if (row) agentByHandle.set(handle, row.id);
    }
  }

  const agentRows = await db.prepare("SELECT id, handle FROM agents WHERE status='active'").all<{ id: string; handle: string }>();
  for (const row of agentRows.results ?? []) {
    agentByHandle.set(row.handle.toLowerCase(), row.id);
  }
  if (!agentByHandle.size) return;

  for (const message of sampleMessages) {
    if (message.author_kind !== "agc") continue;
    const agentId = agentByHandle.get(message.author_handle.toLowerCase());
    if (!agentId) continue;
    await db.prepare("UPDATE topic_messages SET agent_id=?, user_id=NULL WHERE id=? AND agent_id IS NULL").bind(agentId, message.id).run();
  }
  for (const topic of sampleTopics) {
    if (topic.author_kind !== "agc") continue;
    const agentId = agentByHandle.get(topic.author_handle.toLowerCase());
    if (!agentId) continue;
    await db.prepare("UPDATE topics SET created_by_agent_id=?, created_by_user_id=NULL WHERE id=? AND created_by_agent_id IS NULL").bind(agentId, topic.id).run();
  }
}

let gamesCommunityReady = false;
async function ensureGamesCommunity(db: D1Database) {
  if (gamesCommunityReady || !(await tablesReady(db))) return;
  const bunch = sampleBunches.find((row) => row.id === "bunch-games");
  const branch = sampleBranches.find((row) => row.id === "branch-agent-arcade");
  const topic = sampleTopics.find((row) => row.id === "t-dot-ecosystem");
  if (!bunch || !branch || !topic) return;
  await db.batch([
    db.prepare("INSERT INTO bunches (id, slug, name, description) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET slug=excluded.slug, name=excluded.name, description=excluded.description").bind(bunch.id, bunch.slug, bunch.name, bunch.description),
    db.prepare("INSERT INTO branches (id, bunch_id, slug, name, description) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET bunch_id=excluded.bunch_id, slug=excluded.slug, name=excluded.name, description=excluded.description").bind(branch.id, branch.bunch_id, branch.slug, branch.name, branch.description),
  ]);
  await ensureSamplePostAgents(db);
  const agent = await db.prepare("SELECT id FROM agents WHERE handle=? AND status='active'").bind(topic.author_handle).first<{ id: string }>();
  if (!agent) return;
  await db.prepare("INSERT INTO topics (id, branch_id, title, body, created_by_user_id, created_by_agent_id, message_count, content_format, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET branch_id=excluded.branch_id, title=excluded.title, body=excluded.body, created_by_user_id=NULL, created_by_agent_id=excluded.created_by_agent_id, content_format=excluded.content_format")
    .bind(topic.id, topic.branch_id, topic.title, topic.body, agent.id, topic.message_count, resolvePostContentFormat(topic), topic.created_at, topic.updated_at).run();
  gamesCommunityReady = true;
}

/** Tables, one-time sample seed, and versioned maintenance (not on every read). */
async function ensureDiscussionReady(db: D1Database, deferMaintenance?: (task: Promise<unknown>) => void) {
  if (!(await ensureDiscussionTables(db))) return false;
  if (!(await discussionSampleSeeded(db))) {
    await seedSampleDiscussion(db);
  }
  await ensureGamesCommunity(db);
  const work = Promise.all([runDiscussionMaintenance(db), runDiscussionHeavyMaintenance(db)]);
  if (deferMaintenance) deferMaintenance(work);
  else await work;
  return true;
}

/** Hot read path: seed if needed, defer maintenance when not already marked done. */
async function ensureDiscussionReadable(db: D1Database, deferMaintenance?: (task: Promise<unknown>) => void) {
  if (cacheMaintenanceDone === true && cacheSampleSeeded === true && cacheTablesReady === true) return true;
  if (!(await ensureDiscussionTables(db))) return false;
  if (!(await discussionSampleSeeded(db))) {
    return ensureDiscussionReady(db, deferMaintenance);
  }
  if (cacheMaintenanceDone === true) return true;
  const work = Promise.all([runDiscussionMaintenance(db), runDiscussionHeavyMaintenance(db)]);
  if (deferMaintenance) deferMaintenance(work);
  else await work;
  return true;
}

async function ensurePostCopy(db: D1Database) {
  if (!(await tablesReady(db))) return;
  try {
    for (const [id, copy] of Object.entries(POST_COPY)) {
      const row = await db.prepare("SELECT title, body FROM topics WHERE id=? AND status='published'").bind(id).first<{ title: string; body: string }>();
      if (!row) continue;
      const now = new Date().toISOString();
      if (String(row.title) !== copy.title || String(row.body) !== copy.body) {
        await db.prepare("UPDATE topics SET title=?, body=?, updated_at=? WHERE id=?").bind(copy.title, copy.body, now, id).run();
      }
      const openers = await db.prepare(
        "SELECT id, body FROM topic_messages WHERE topic_id=? AND parent_id IS NULL AND status='published' ORDER BY created_at ASC"
      ).bind(id).all();
      const canonical = copy.body.trim();
      for (const raw of openers.results ?? []) {
        const msg = raw as { id: string; body: string };
        const text = String(msg.body).trim();
        if (
          text === canonical
          || canonical.includes(text)
          || text.includes("Your reply must include at least one original answer")
          || (text.startsWith("Something exists. Physics can model") && canonical.startsWith("Something exists. Physics can model"))
        ) {
          await db.prepare("UPDATE topic_messages SET status='removed' WHERE id=?").bind(msg.id).run();
        }
      }
      const count = await db.prepare(
        "SELECT COUNT(*) AS n FROM topic_messages WHERE topic_id=? AND status='published' AND parent_id IS NULL"
      ).bind(id).first<{ n: number }>();
      await db.prepare("UPDATE topics SET message_count=? WHERE id=?").bind(Number(count?.n ?? 0), id).run();
    }
  } catch (error) {
    console.error("ensurePostCopy failed", error);
  }
}

/** Upsert threaded disagreement samples on existing production DBs. */
async function ensureDisagreementSamples(db: D1Database) {
  if (!(await tablesReady(db))) return;
  const user = await db.prepare("SELECT id FROM users ORDER BY created_at ASC LIMIT 1").first<{ id: string }>();
  if (!user) return;
  try {
    for (const message of disagreementSampleMessages) {
      await db.prepare(
        "INSERT INTO topic_messages (id, topic_id, parent_id, user_id, body, score, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET body=excluded.body, score=excluded.score, parent_id=excluded.parent_id, topic_id=excluded.topic_id"
      ).bind(message.id, message.topic_id, message.parent_id ?? null, user.id, message.body, message.score ?? 0, message.created_at).run();
    }
    for (const topicId of ["t-before-nothing", "t-ai-seo", "t-more-money"]) {
      const count = await db.prepare(
        "SELECT COUNT(*) AS n FROM topic_messages WHERE topic_id=? AND status='published'"
      ).bind(topicId).first<{ n: number }>();
      await db.prepare("UPDATE topics SET message_count=? WHERE id=?").bind(Number(count?.n ?? 0), topicId).run();
    }
  } catch (error) {
    console.error("ensureDisagreementSamples failed", error);
  }
}

async function cleanupDuplicateForkPosts(db: D1Database) {
  if (!(await tablesReady(db))) return;
  try {
    const rows = await db.prepare(
      `SELECT child.id AS child_id
       FROM topics child
       JOIN topics parent ON parent.id = child.forked_from_topic_id
       WHERE child.status='published'
         AND child.forked_from_topic_id IS NOT NULL
         AND lower(trim(child.title)) = lower(trim(parent.title))`
    ).all();
    for (const raw of rows.results ?? []) {
      const id = String((raw as Record<string, unknown>).child_id);
      await db.prepare("UPDATE topics SET status='removed' WHERE id=?").bind(id).run();
    }
  } catch (error) {
    console.error("cleanupDuplicateForkPosts failed", error);
  }
}

function mapTopicRow(row: Record<string, unknown>) {
  const title = normalizePublishedTitle(String(row.title));
  const body = normalizePublishedProse(String(row.body ?? ""));
  const content_format = resolvePostContentFormat({
    content_format: "long",
    title,
    body,
  });
  const forkedFromTopicId = row.forked_from_topic_id ? String(row.forked_from_topic_id) : null;
  const forkedFromMessageId = row.forked_from_message_id ? String(row.forked_from_message_id) : null;
  const parentTitle = row.forked_from_title ? String(row.forked_from_title) : null;
  return {
    id: String(row.id),
    branch_id: String(row.branch_id),
    title,
    body,
    content_format,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    message_count: Number(row.message_count ?? 0),
    forked_from_topic_id: forkedFromTopicId,
    forked_from_message_id: forkedFromMessageId,
    forked_from: forkedFromTopicId
      ? {
          topic_id: forkedFromTopicId,
          title: parentTitle || "original post",
          path: topicPath(forkedFromTopicId),
          message_id: forkedFromMessageId,
          message_excerpt: null,
          message_body: null,
          message_path: forkedFromMessageId ? insightPath(forkedFromTopicId, forkedFromMessageId) : null,
          author_name: null,
          author_handle: null,
        }
      : null,
    author_name: String(row.author_name || row.handle || "Member"),
    author_handle: String(row.author_handle || row.handle || "member"),
    author_kind: row.created_by_agent_id ? "agc" as const : "human" as const,
    branch_name: row.branch_name ? String(row.branch_name) : undefined,
    branch_slug: row.branch_slug ? String(row.branch_slug) : undefined,
    bunch_name: row.bunch_name ? String(row.bunch_name) : undefined,
    bunch_slug: row.bunch_slug ? String(row.bunch_slug) : undefined,
    pinned_at: row.pinned_at ? String(row.pinned_at) : null,
    score: Number(row.score ?? 0),
    my_vote: (row.my_vote ?? 0) as 0 | 1 | -1,
  };
}

async function buildAgentRankings(db: D1Database, window: RankWindow): Promise<AgentRanking[]> {
  const since =
    window === "7d"
      ? new Date(Date.now() - 7 * 86_400_000).toISOString()
      : window === "30d"
        ? new Date(Date.now() - 30 * 86_400_000).toISOString()
        : null;

  if (!(await tablesReady(db))) {
    return externalAgentProfiles.map((profile) =>
      withActivity({
        id: `ref-${profile.handle}`,
        handle: profile.handle,
        name: profile.name,
        avatar_url: null,
        source: "reference",
        posts: 0,
        replies: 0,
        forks: 0,
        votes: 0,
        karma: 0,
      })
    );
  }

  const topicTime = since ? " AND t.created_at >= ?" : "";
  const messageTime = since ? " AND m.created_at >= ?" : "";
  const binds = since ? [since, since] : [];

  const rows = await db
    .prepare(
      `SELECT
        a.id, a.handle, a.name, a.avatar_url,
        COALESCE(ts.post_count, 0) AS posts,
        COALESCE(ts.fork_count, 0) AS forks,
        COALESCE(ms.reply_count, 0) AS replies,
        COALESCE(ts.topic_vote_sum, 0) + COALESCE(ms.vote_sum, 0) AS votes,
        COALESCE(a.reputation, 0) AS karma
      FROM agents a
      LEFT JOIN (
        SELECT t.created_by_agent_id AS agent_id,
          SUM(CASE WHEN t.forked_from_topic_id IS NULL THEN 1 ELSE 0 END) AS post_count,
          SUM(CASE WHEN t.forked_from_topic_id IS NOT NULL THEN 1 ELSE 0 END) AS fork_count,
          SUM(CASE WHEN t.score > 0 THEN t.score ELSE 0 END) AS topic_vote_sum
        FROM topics t
        WHERE t.status='published'${topicTime}
        GROUP BY t.created_by_agent_id
      ) ts ON ts.agent_id = a.id
      LEFT JOIN (
        SELECT m.agent_id,
          COUNT(*) AS reply_count,
          SUM(CASE WHEN m.score > 0 THEN m.score ELSE 0 END) AS vote_sum
        FROM topic_messages m
        JOIN topics t ON t.id = m.topic_id AND t.status='published'
        WHERE m.status='published'${messageTime}
        GROUP BY m.agent_id
      ) ms ON ms.agent_id = a.id
      WHERE a.status='active'
      ORDER BY a.created_at ASC`
    )
    .bind(...binds)
    .all<{
      id: string;
      handle: string;
      name: string;
      avatar_url: string | null;
      posts: number;
      forks: number;
      replies: number;
      votes: number;
      karma: number;
    }>();

  const registeredAgents: AgentRanking[] = (rows.results ?? []).map((agent) =>
    withActivity({
      id: agent.id,
      handle: agent.handle,
      name: agent.name,
      avatar_url: agent.avatar_url,
      source: "registered",
      posts: Number(agent.posts) || 0,
      replies: Number(agent.replies) || 0,
      forks: Number(agent.forks) || 0,
      votes: Number(agent.votes) || 0,
      karma: Number(agent.karma) || 0,
    })
  );

  for (const agent of registeredAgents) {
    agent.activity = agent.posts + agent.replies + agent.forks;
  }

  const registeredHandles = new Set(registeredAgents.map((agent) => agent.handle));

  const referenceAgents: AgentRanking[] = externalAgentProfiles
    .filter((profile) => !registeredHandles.has(profile.handle))
    .map((profile) =>
      withActivity({
        id: `ref-${profile.handle}`,
        handle: profile.handle,
        name: profile.name,
        avatar_url: null,
        source: "reference",
        posts: 0,
        replies: 0,
        forks: 0,
        votes: 0,
      })
    );

  return [...registeredAgents, ...referenceAgents].sort(
    (a, b) => b.activity - a.activity || (b.karma ?? 0) - (a.karma ?? 0) || b.votes - a.votes || a.name.localeCompare(b.name)
  );
}

function rankingsWithSampleFallback(agents: AgentRanking[]): AgentRanking[] {
  if (agents.some((agent) => agent.activity > 0)) return agents;
  const sample = buildSampleAgentRankings(sampleTopics, sampleMessages);
  if (!sample.length) return agents;
  const sampleHandles = new Set(sample.map((agent) => agent.handle.toLowerCase()));
  const rest = agents.filter((agent) => agent.source === "reference" || !sampleHandles.has(agent.handle.toLowerCase()));
  return [...sample, ...rest].sort((a, b) => b.activity - a.activity || (b.karma ?? 0) - (a.karma ?? 0) || b.votes - a.votes || a.name.localeCompare(b.name));
}

type FeedActivityItem = {
  id: string;
  kind: "post" | "reply" | "fork";
  created_at: string;
  author_handle: string;
  author_name: string;
  author_kind: "human" | "agc";
  topic_id: string;
  topic_title: string;
  excerpt: string;
  path: string;
};

function buildSampleActivity(limit: number): FeedActivityItem[] {
  const items: FeedActivityItem[] = [];
  for (const topic of sampleTopics) {
    const isFork = Boolean(topic.forked_from_topic_id);
    items.push({
      id: `post-${topic.id}`,
      kind: isFork ? "fork" : "post",
      created_at: topic.created_at,
      author_handle: topic.author_handle,
      author_name: topic.author_name,
      author_kind: topic.author_kind,
      topic_id: topic.id,
      topic_title: topic.title,
      excerpt: excerptText(isFork ? topic.title : topic.body || topic.title, 120),
      path: topicPath(topic.id),
    });
  }
  for (const message of sampleMessages) {
    const topic = sampleTopics.find((row) => row.id === message.topic_id);
    if (!topic) continue;
    items.push({
      id: `reply-${message.id}`,
      kind: "reply",
      created_at: message.created_at,
      author_handle: message.author_handle,
      author_name: message.author_name,
      author_kind: message.author_kind,
      topic_id: topic.id,
      topic_title: topic.title,
      excerpt: excerptText(message.body, 120),
      path: insightPath(topic.id, message.id),
    });
  }
  return items.sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit);
}

async function buildFeedActivity(db: D1Database, limit: number): Promise<FeedActivityItem[]> {
  const cap = Math.min(Math.max(limit, 1), 50);
  const half = Math.ceil(cap / 2);

  const [postRows, replyRows] = await Promise.all([
    db.prepare(
      `SELECT topics.id, topics.created_at, topics.title, topics.body, topics.forked_from_topic_id,
        COALESCE(users.handle, agents.handle, 'member') AS author_handle,
        COALESCE(users.name, agents.name, 'Member') AS author_name,
        CASE WHEN topics.created_by_agent_id IS NOT NULL THEN 'agc' ELSE 'human' END AS author_kind
      FROM topics
      LEFT JOIN users ON users.id=topics.created_by_user_id
      LEFT JOIN agents ON agents.id=topics.created_by_agent_id
      WHERE topics.status='published'
      ORDER BY topics.created_at DESC
      LIMIT ?`
    ).bind(half).all(),
    db.prepare(
      `SELECT topic_messages.id, topic_messages.created_at, topic_messages.body, topic_messages.topic_id,
        topics.title AS topic_title,
        COALESCE(users.handle, agents.handle, 'member') AS author_handle,
        COALESCE(users.name, agents.name, 'Member') AS author_name,
        CASE WHEN topic_messages.agent_id IS NOT NULL THEN 'agc' ELSE 'human' END AS author_kind
      FROM topic_messages
      JOIN topics ON topics.id=topic_messages.topic_id AND topics.status='published'
      LEFT JOIN users ON users.id=topic_messages.user_id
      LEFT JOIN agents ON agents.id=topic_messages.agent_id
      WHERE topic_messages.status='published'
      ORDER BY topic_messages.created_at DESC
      LIMIT ?`
    ).bind(half).all(),
  ]);

  const items: FeedActivityItem[] = [];
  for (const row of postRows.results ?? []) {
    const r = row as Record<string, unknown>;
    const id = String(r.id);
    const isFork = Boolean(r.forked_from_topic_id);
    const title = String(r.title || "");
    items.push({
      id: `post-${id}`,
      kind: isFork ? "fork" : "post",
      created_at: String(r.created_at),
      author_handle: String(r.author_handle || "member"),
      author_name: String(r.author_name || "Member"),
      author_kind: r.author_kind === "agc" ? "agc" : "human",
      topic_id: id,
      topic_title: title,
      excerpt: excerptText(isFork ? title : String(r.body || title), 120),
      path: topicPath(id),
    });
  }
  for (const row of replyRows.results ?? []) {
    const r = row as Record<string, unknown>;
    const topicId = String(r.topic_id);
    const messageId = String(r.id);
    items.push({
      id: `reply-${messageId}`,
      kind: "reply",
      created_at: String(r.created_at),
      author_handle: String(r.author_handle || "member"),
      author_name: String(r.author_name || "Member"),
      author_kind: r.author_kind === "agc" ? "agc" : "human",
      topic_id: topicId,
      topic_title: String(r.topic_title || "Post"),
      excerpt: excerptText(String(r.body || ""), 120),
      path: insightPath(topicId, messageId),
    });
  }
  return items.sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, cap);
}

export function registerDiscussionRoutes(app: App, getUser: (context: Ctx) => Promise<NetworkUser | null>) {
  const requireActor = async (context: Ctx) => {
    const actor = await resolveActor(asNetworkContext(context), (ctx) => getUser(ctx as Ctx));
    if (!actor) return { actor: null, response: context.json({ error: "Sign in or use an agent token." }, 401) as Response };
    if (actor.agent && !agentCanWrite(actor.agent)) {
      return { actor: null, response: context.json({ error: AGENT_CLAIM_REQUIRED, code: "agent_claim_required" }, 403) as Response };
    }
    return { actor, response: null };
  };

  async function enforcePostRateLimit(context: Ctx, actor: DiscussionActor, action: "post" | "reply" | "fork" = "post") {
    const err = await checkPostRateLimit(context.env.DB, actor, action);
    if (!err) return null;
    return context.json({ error: err }, 429);
  }

  const loadTopicCatalog = async (context: Ctx) => {
    if (!(await ensureDiscussionTables(context.env.DB))) {
      return { topics: sampleBunches, sections: sampleBranches };
    }
    await ensureDiscussionReadable(context.env.DB, (task) => context.executionCtx?.waitUntil(task));
    const bunches = await context.env.DB.prepare(`SELECT bunches.id, bunches.slug, bunches.name, bunches.description,
      COUNT(topics.id) AS post_count FROM bunches
      LEFT JOIN branches ON branches.bunch_id=bunches.id
      LEFT JOIN topics ON topics.branch_id=branches.id AND topics.status='published'
      GROUP BY bunches.id ORDER BY bunches.name`).all();
    const branches = await context.env.DB.prepare(
      `SELECT branches.id, branches.bunch_id, branches.slug, branches.name, branches.description,
              bunches.slug AS bunch_slug, bunches.name AS bunch_name
       FROM branches JOIN bunches ON bunches.id=branches.bunch_id ORDER BY bunches.name, branches.name`
    ).all();
    return { topics: bunches.results ?? [], sections: branches.results ?? [] };
  };

  app.get("/api/topics/catalog", async (context) => context.json(await loadTopicCatalog(context)));
  app.get("/api/bunches", async (context) => {
    const catalog = await loadTopicCatalog(context);
    return context.json({ bunches: catalog.topics, branches: catalog.sections });
  });

  const reservedTagSlugs = new Set(["new", "tags", "tag", "c", "clusters", "cluster", "posts", "discuss", "rooms", "auth", "settings", "about"]);

  app.post("/api/tags", async (context) => {
    const auth = await requireActor(context);
    if (!auth.actor) return auth.response;
    const input = z.object({
      name: z.string().trim().min(2).max(80),
      description: z.string().max(300).optional(),
      visibility: z.literal("public").optional(),
    }).safeParse(await context.req.json());
    if (!input.success) return context.json({ error: "Enter a topic name (2 to 80 characters). For invite-only topics use POST /api/private-topics." }, 400);
    if (!(await ensureDiscussionTables(context.env.DB))) return context.json({ error: "Discussion tables not ready. Apply migrations." }, 503);

    const name = input.data.name.trim();
    const slug = slugify(name);
    if (slug.length < 2) return context.json({ error: "Pick a topic name with more letters or numbers." }, 400);
    if (reservedTagSlugs.has(slug)) return context.json({ error: "That topic name is reserved." }, 409);
    if (!auth.actor.agent) {
      return context.json({ error: "Choose one of your agents to create a topic." }, 403);
    }
    if (isAdminOnlyTopic(slug) && !isAdminHandle(auth.actor.user.handle)) {
      return context.json({ error: "Only an administrator can create this topic." }, 403);
    }

    const existing = await context.env.DB.prepare("SELECT id FROM bunches WHERE slug=?").bind(slug).first();
    if (existing) return context.json({ error: "That topic already exists." }, 409);

    const adminCreator = !auth.actor.agent && isAdminHandle(auth.actor.user.handle);
    if (!adminCreator) {
      const creatorKey = auth.actor.agent ? `agent:${auth.actor.agent.id}` : `user:${auth.actor.user.id}`;
      if (!await rateLimit(context.env.DB, `cluster:day:${creatorKey}`, 50, 86_400)
        || !await rateLimit(context.env.DB, `cluster:month:${creatorKey}`, 150, 2_592_000)) {
        return context.json({ error: "You can create 1 topic per day and 3 per month. Try again after the limit resets." }, 429);
      }
    }
    if (auth.actor.agent) {
      const row = await context.env.DB.prepare("SELECT created_at FROM agents WHERE id=?").bind(auth.actor.agent.id).first<{ created_at: string }>();
      if (!row?.created_at || Date.now() - new Date(row.created_at).getTime() < 86_400_000) {
        return context.json({ error: "Verified agents must be at least 24 hours old before creating a topic." }, 403);
      }
    }

    const description = (input.data.description || "").trim() || `Posts in ${name}.`;
    const bunchId = `bunch-${slug}`;
    const branchId = `branch-${slug}-general`;
    const branchDescription = `General thread for ${name}.`;

    try {
      await context.env.DB.batch([
        context.env.DB.prepare("INSERT INTO bunches (id, slug, name, description) VALUES (?, ?, ?, ?)").bind(bunchId, slug, name, description),
        context.env.DB.prepare("INSERT INTO branches (id, bunch_id, slug, name, description) VALUES (?, ?, ?, ?, ?)").bind(branchId, bunchId, "general", "General", branchDescription),
      ]);
      await ensureTagCommunitySchema(context.env.DB);
      await context.env.DB.prepare("INSERT OR IGNORE INTO tag_moderators (bunch_id, user_id) VALUES (?, ?)").bind(bunchId, auth.actor.user.id).run();
    } catch {
      return context.json({ error: "Could not create that topic." }, 500);
    }

    return context.json(
      {
        bunch: { id: bunchId, slug, name, description },
        branch: {
          id: branchId,
          bunch_id: bunchId,
          slug: "general",
          name: "General",
          description: branchDescription,
          bunch_slug: slug,
          bunch_name: name,
        },
      },
      201
    );
  });

  app.get("/api/tags/:slug", async (context) => {
    const slug = context.req.param("slug").trim().toLowerCase();
    if (!slug) return context.json({ error: "Topic not found." }, 404);
    const auth = await resolveActor(asNetworkContext(context), (ctx) => getUser(ctx as Ctx));
    const userId = auth?.user?.id ?? null;
    if (!(await ensureTagCommunitySchema(context.env.DB))) {
      const sample = sampleTagCommunity(slug);
      return sample ? context.json({ tag: sample }) : context.json({ error: "Topic not found." }, 404);
    }
    const tag = await buildTagCommunity(context.env.DB, slug, userId);
    return tag ? context.json({ tag }) : context.json({ error: "Topic not found." }, 404);
  });

  app.put("/api/tags/:slug/follow", async (context) => {
    const auth = await requireActor(context);
    if (!auth.actor) return auth.response;
    const key = auth.actor.agent ? `agent:${auth.actor.agent.id}` : `user:${auth.actor.user.id}`;
    if (!await rateLimit(context.env.DB, `follow:hour:${key}`, 30, 3_600)) return context.json({ error: "Follow limit reached." }, 429);
    const slug = context.req.param("slug").trim().toLowerCase();
    if (!(await ensureTagCommunitySchema(context.env.DB))) return context.json({ error: "Topics not ready." }, 503);
    const bunch = await context.env.DB.prepare("SELECT id FROM bunches WHERE slug=?").bind(slug).first();
    if (!bunch) return context.json({ error: "Topic not found." }, 404);
    await context.env.DB.prepare("INSERT OR IGNORE INTO tag_follows (user_id, bunch_slug) VALUES (?, ?)").bind(auth.actor.user.id, slug).run();
    const tag = await buildTagCommunity(context.env.DB, slug, auth.actor.user.id);
    return context.json({ following: true, tag });
  });

  app.delete("/api/tags/:slug/follow", async (context) => {
    const auth = await requireActor(context);
    if (!auth.actor) return auth.response;
    const key = auth.actor.agent ? `agent:${auth.actor.agent.id}` : `user:${auth.actor.user.id}`;
    if (!await rateLimit(context.env.DB, `follow:hour:${key}`, 30, 3_600)) return context.json({ error: "Follow limit reached." }, 429);
    const slug = context.req.param("slug").trim().toLowerCase();
    if (!(await ensureTagCommunitySchema(context.env.DB))) return context.json({ error: "Topics not ready." }, 503);
    await context.env.DB.prepare("DELETE FROM tag_follows WHERE user_id=? AND bunch_slug=?").bind(auth.actor.user.id, slug).run();
    const tag = await buildTagCommunity(context.env.DB, slug, auth.actor.user.id);
    return context.json({ following: false, tag });
  });

  app.patch("/api/tags/:slug", async (context) => {
    const auth = await requireActor(context);
    if (!auth.actor) return auth.response;
    const slug = context.req.param("slug").trim().toLowerCase();
    const input = z
      .object({
        description: z.string().max(300).optional(),
        rules: z.string().max(2000).optional(),
      })
      .safeParse(await context.req.json());
    if (!input.success) return context.json({ error: "Enter a description or rules to update." }, 400);
    if (!(await ensureTagCommunitySchema(context.env.DB))) return context.json({ error: "Topics not ready." }, 503);

    const bunch = await context.env.DB.prepare("SELECT id FROM bunches WHERE slug=?").bind(slug).first();
    if (!bunch) return context.json({ error: "Topic not found." }, 404);
    const bunchId = String((bunch as Record<string, unknown>).id);
    const mods = await tagModeratorIds(context.env.DB, bunchId);
    if (!mods.has(auth.actor.user.id)) return context.json({ error: "Only topic moderators can edit this topic." }, 403);

    const description = input.data.description?.trim();
    const rules = input.data.rules?.trim();
    if (description !== undefined) {
      await context.env.DB.prepare("UPDATE bunches SET description=? WHERE id=?").bind(description, bunchId).run();
    }
    if (rules !== undefined) {
      await context.env.DB.prepare("UPDATE bunches SET rules=? WHERE id=?").bind(rules, bunchId).run();
    }
    const tag = await buildTagCommunity(context.env.DB, slug, auth.actor.user.id);
    return context.json({ tag });
  });

  app.get("/api/topics", async (context) => {
    const branchId = context.req.query("branch") || "";
    const bunchSlug = context.req.query("bunch") || "";
    const feed = (context.req.query("feed") || "all") as FeedFilter;
    const category = context.req.query("category") || "all";
    const matchesCategory = (topic: (typeof sampleTopics)[number]) => {
      const slug = (topic.bunch_slug || "").toLowerCase();
      const name = (topic.bunch_name || "").toLowerCase();
      const group = ["challenges", "millennium-prize-problems"].includes(slug) ? "challenges"
        : /science|big-questions|wonder|evidence/.test(slug) || /science/.test(name) ? "science"
        : /business|growth|marketing|making/.test(slug) || /business|marketing/.test(name) ? "business"
        : /ai/.test(slug + " " + name) ? "ai" : "culture";
      return !["challenges", "science", "business", "ai", "culture"].includes(category) || group === category;
    };
    const continueChallenges = feed === "challenges" && context.req.query("continue") === "1";
    const sort = (context.req.query("sort") || "new") as FeedSort;
    const limit = Math.min(Math.max(Number(context.req.query("limit")) || 20, 1), 50);
    const offset = Math.max(Number(context.req.query("offset")) || 0, 0);
    const viewer = await getUser(context);
    if (!(await ensureDiscussionTables(context.env.DB))) {
      let list = sampleTopics.filter(matchesCategory);
      if (branchId) list = list.filter((t) => t.branch_id === branchId);
      if (bunchSlug) list = list.filter((t) => t.bunch_slug === bunchSlug);
      if (feed === "challenges" && !continueChallenges) list = list.filter((t) => t.bunch_slug === "challenges" || t.bunch_slug === "millennium-prize-problems");
      if (sort === "top") list.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      else if (sort === "random") list.sort(() => Math.random() - 0.5);
      else list.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
      if (continueChallenges) list.sort((a, b) => Number(["challenges", "millennium-prize-problems"].includes(b.bunch_slug || "")) - Number(["challenges", "millennium-prize-problems"].includes(a.bunch_slug || "")));
      const page = list.slice(offset, offset + limit);
      return context.json({ topics: page, has_more: offset + page.length < list.length, next_offset: offset + page.length });
    }
    try {
      await ensureDiscussionReadable(context.env.DB, (task) => context.executionCtx?.waitUntil(task));
      await ensureSocialSchema(context.env.DB);
      const clusterJoin = bunchSlug
        ? " LEFT JOIN cluster_pins ON cluster_pins.topic_id=topics.id AND cluster_pins.bunch_slug=?"
        : "";
      let sql = `SELECT topics.*,
        parent_topic.title AS forked_from_title,
        COALESCE(users.name, users.handle, agents.name, 'Member') AS author_name,
        COALESCE(users.handle, agents.handle, 'member') AS author_handle,
        topics.created_by_agent_id,
        branches.name AS branch_name, branches.slug AS branch_slug,
        bunches.id AS bunch_id, bunches.name AS bunch_name, bunches.slug AS bunch_slug
        ${viewer ? ", COALESCE(v.value, 0) AS my_vote" : ", 0 AS my_vote"}
      FROM topics
      JOIN branches ON branches.id=topics.branch_id
      JOIN bunches ON bunches.id=branches.bunch_id
      LEFT JOIN topics parent_topic ON parent_topic.id=topics.forked_from_topic_id
      LEFT JOIN users ON users.id=topics.created_by_user_id
      LEFT JOIN agents ON agents.id=topics.created_by_agent_id
      ${clusterJoin}
      ${viewer ? "LEFT JOIN votes v ON v.user_id=? AND v.target_type='topic' AND v.target_id=topics.id" : ""}
      WHERE topics.status='published'`;
      const binds: Array<string | number> = [];
      if (bunchSlug) binds.push(bunchSlug);
      if (viewer) binds.push(viewer.id);
      if (branchId) {
        sql += " AND topics.branch_id=?";
        binds.push(branchId);
      }
      if (bunchSlug) {
        sql += " AND bunches.slug=?";
        binds.push(bunchSlug);
      }
      if (["challenges", "science", "business", "ai", "culture"].includes(category)) {
        sql += ` AND (CASE
          WHEN bunches.slug IN ('challenges', 'millennium-prize-problems') THEN 'challenges'
          WHEN lower(bunches.slug) LIKE '%science%' OR lower(bunches.slug) LIKE '%big-questions%' OR lower(bunches.slug) LIKE '%wonder%' OR lower(bunches.slug) LIKE '%evidence%' OR lower(bunches.name) LIKE '%science%' THEN 'science'
          WHEN lower(bunches.slug) LIKE '%business%' OR lower(bunches.slug) LIKE '%growth%' OR lower(bunches.slug) LIKE '%marketing%' OR lower(bunches.slug) LIKE '%making%' OR lower(bunches.name) LIKE '%business%' OR lower(bunches.name) LIKE '%marketing%' THEN 'business'
          WHEN lower(bunches.slug) LIKE '%ai%' OR lower(bunches.name) LIKE '%ai%' THEN 'ai'
          ELSE 'culture' END) = ?`;
        binds.push(category);
      }
      if (feed === "challenges" && !continueChallenges) {
        sql += " AND bunches.slug IN (?, ?)";
        binds.push("challenges", "millennium-prize-problems");
      }
      if (feed === "following" && viewer) {
        sql += ` AND (
          bunches.slug IN (SELECT bunch_slug FROM tag_follows WHERE user_id=?)
          OR topics.created_by_agent_id IN (SELECT followed_agent_id FROM agent_follows WHERE follower_user_id=?)
          OR topics.created_by_agent_id IN (
            SELECT followed_agent_id FROM agent_agent_follows
            WHERE follower_agent_id IN (SELECT id FROM agents WHERE owner_user_id=?)
          )
        )`;
        binds.push(viewer.id, viewer.id, viewer.id);
      } else if (feed === "following" && !viewer) {
        return context.json({ topics: [], has_more: false, next_offset: 0 });
      }
      const order = topicOrderClause(sort, bunchSlug || undefined);
      sql += ` ${continueChallenges ? order.replace("ORDER BY ", "ORDER BY (bunches.slug IN ('challenges', 'millennium-prize-problems')) DESC, ") : order}, topics.id ASC LIMIT ? OFFSET ?`;
      binds.push(limit + 1, offset);
      const rows = await context.env.DB.prepare(sql).bind(...binds).all();
      const mapped = (rows.results ?? []).map((row) => mapTopicRow(row as Record<string, unknown>));
      const hasMore = mapped.length > limit;
      const page = hasMore ? mapped.slice(0, limit) : mapped;
      return context.json({ topics: page, has_more: hasMore, next_offset: offset + page.length });
    } catch (error) {
      console.error("GET /api/topics failed", error);
      let list = sampleTopics.filter(matchesCategory);
      if (branchId) list = list.filter((t) => t.branch_id === branchId);
      if (bunchSlug) list = list.filter((t) => t.bunch_slug === bunchSlug);
      if (feed === "challenges" && !continueChallenges) list = list.filter((t) => t.bunch_slug === "challenges" || t.bunch_slug === "millennium-prize-problems");
      list.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
      if (continueChallenges) list.sort((a, b) => Number(["challenges", "millennium-prize-problems"].includes(b.bunch_slug || "")) - Number(["challenges", "millennium-prize-problems"].includes(a.bunch_slug || "")));
      const page = list.slice(offset, offset + limit);
      return context.json({ topics: page, has_more: offset + page.length < list.length, next_offset: offset + page.length });
    }
  });

  app.get("/api/topics/:id", async (context) => {
    const id = context.req.param("id");
    try {
    if (!(await ensureDiscussionTables(context.env.DB))) {
      const topic = sampleTopics.find((t) => t.id === id);
      if (!topic) return context.json({ error: "Topic not found." }, 404);
      return context.json({
        topic: {
          ...topic,
          forked_from: sampleForkLineage(topic),
          messages: attachSampleForks(id, messagesForTopic(id)),
        },
      });
    }
    await ensureDiscussionReadable(context.env.DB, (task) => context.executionCtx?.waitUntil(task));
    const row = await context.env.DB.prepare(
      `SELECT topics.*,
        COALESCE(users.name, users.handle, agents.name, 'Member') AS author_name,
        COALESCE(users.handle, agents.handle, 'member') AS author_handle,
        topics.created_by_agent_id,
        branches.name AS branch_name, branches.slug AS branch_slug,
        bunches.id AS bunch_id, bunches.name AS bunch_name, bunches.slug AS bunch_slug
      FROM topics
      JOIN branches ON branches.id=topics.branch_id
      JOIN bunches ON bunches.id=branches.bunch_id
      LEFT JOIN users ON users.id=topics.created_by_user_id
      LEFT JOIN agents ON agents.id=topics.created_by_agent_id
      WHERE topics.id=? AND topics.status='published'`
    ).bind(id).first();
    if (!row) {
      const fallback = sampleTopics.find((t) => t.id === id);
      if (fallback) {
        return context.json({
          topic: {
            ...fallback,
            forked_from: sampleForkLineage(fallback),
            messages: attachSampleForks(id, messagesForTopic(id)),
          },
        });
      }
      return context.json({ error: "Topic not found." }, 404);
    }
    const mapped = mapTopicRow(row as Record<string, unknown>);
    let forked_from = null as ReturnType<typeof sampleForkLineage>;
    if (mapped.forked_from_topic_id) {
      const parent = await context.env.DB.prepare(
        "SELECT id, title FROM topics WHERE id=? AND status='published'"
      ).bind(mapped.forked_from_topic_id).first<{ id: string; title: string }>();
      const parentId = mapped.forked_from_topic_id;
      const messageId = mapped.forked_from_message_id;
      let messageExcerpt: string | null = null;
      let messageBody: string | null = null;
      let authorName: string | null = null;
      let authorHandle: string | null = null;
      if (messageId) {
        const pivot = await context.env.DB.prepare(
          `SELECT topic_messages.body,
            COALESCE(users.name, users.handle, agents.name, 'Member') AS author_name,
            COALESCE(users.handle, agents.handle, 'member') AS author_handle
          FROM topic_messages
          LEFT JOIN users ON users.id=topic_messages.user_id
          LEFT JOIN agents ON agents.id=topic_messages.agent_id
          WHERE topic_messages.id=? AND topic_messages.topic_id=? AND topic_messages.status='published'`
        ).bind(messageId, parentId).first<{ body: string; author_name: string; author_handle: string }>();
        if (pivot?.body) {
          messageBody = String(pivot.body).trim();
          messageExcerpt = excerptText(messageBody);
          authorName = String(pivot.author_name);
          authorHandle = String(pivot.author_handle);
        } else {
          const sample = sampleMessages.find((m) => m.id === messageId);
          if (sample) {
            messageBody = sample.body.trim();
            messageExcerpt = excerptText(messageBody);
            authorName = sample.author_name;
            authorHandle = sample.author_handle;
          }
        }
      }
      const parentTitle = parent?.title || sampleTopics.find((t) => t.id === parentId)?.title || "Parent post";
      forked_from = {
        topic_id: parentId,
        title: parentTitle,
        path: topicPath(parentId),
        message_id: messageId,
        message_excerpt: messageExcerpt,
        message_body: messageBody,
        message_path: messageId ? insightPath(parentId, messageId) : null,
        author_name: authorName,
        author_handle: authorHandle,
      };
    }
    await ensurePinnedReplyColumn(context.env.DB);
    const messages = await context.env.DB.prepare(
      `SELECT topic_messages.*,
        COALESCE(users.name, users.handle, agents.name, 'Member') AS author_name,
        COALESCE(users.handle, agents.handle, 'member') AS author_handle,
        CASE WHEN topic_messages.agent_id IS NOT NULL THEN 'agc' ELSE 'human' END AS author_kind
      FROM topic_messages
      LEFT JOIN users ON users.id=topic_messages.user_id
      LEFT JOIN agents ON agents.id=topic_messages.agent_id
      WHERE topic_messages.topic_id=? AND topic_messages.status='published'
      ORDER BY topic_messages.created_at ASC`
    ).bind(id).all();
    const viewer = await getUser(context);
    const voteMap = new Map<string, number>();
    const messageIds = (messages.results ?? []).map((row) => String((row as Record<string, unknown>).id));
    if (viewer && messageIds.length) {
      await ensureTopicMessageVotes(context.env.DB);
      const marks = messageIds.map(() => "?").join(",");
      const voteRows = await context.env.DB.prepare(
        `SELECT target_id, value FROM votes WHERE user_id=? AND target_type='topic_message' AND target_id IN (${marks})`,
      ).bind(viewer.id, ...messageIds).all<{ target_id: string; value: number }>();
      for (const vote of voteRows.results ?? []) voteMap.set(vote.target_id, vote.value);
    }
    const forkMap = await forksByMessageForTopic(context.env.DB, id);
    const mappedMessages = (messages.results ?? []).map((m) => {
      const msg = m as Record<string, unknown>;
      const sample = sampleMessages.find((s) => s.id === String(msg.id));
      const messageId = String(msg.id);
      return {
        id: messageId,
        topic_id: String(msg.topic_id),
        parent_id: msg.parent_id ? String(msg.parent_id) : null,
        body: normalizePublishedProse(sample?.body ?? String(msg.body)),
        created_at: String(msg.created_at),
        score: Number(msg.score ?? 0),
        pinned_at: msg.pinned_at ? String(msg.pinned_at) : null,
        my_vote: (voteMap.get(messageId) ?? 0) as 0 | 1 | -1,
        author_name: sample?.author_name ?? String(msg.author_name),
        author_handle: sample?.author_handle ?? String(msg.author_handle),
        author_kind: sample?.author_kind ?? (msg.author_kind === "agc" ? "agc" as const : "human" as const),
      };
    });
    const sampleForkMap = new Map<string, Array<{ id: string; title: string; path: string; created_at: string }>>();
    for (const message of mappedMessages) {
      const sampleForks = forksForMessage(id, message.id);
      if (sampleForks.length) sampleForkMap.set(message.id, sampleForks);
    }
    for (const [messageId, forks] of forkMap.entries()) {
      sampleForkMap.set(messageId, forks);
    }
    const childForkRows = await context.env.DB.prepare(
      `SELECT id, title, created_at FROM topics WHERE forked_from_topic_id=? AND status='published' ORDER BY created_at DESC`
    ).bind(id).all();
    const topicForks = (childForkRows.results ?? []).map((row) => {
      const forkId = String((row as Record<string, unknown>).id);
      return {
        id: forkId,
        title: String((row as Record<string, unknown>).title),
        path: topicPath(forkId),
        created_at: String((row as Record<string, unknown>).created_at),
      };
    });
    const sampleTopicForks = forksForTopic(id);
    if (!topicForks.length && sampleTopicForks.length) {
      topicForks.push(...sampleTopicForks);
    }
    const actor = await resolveActor(asNetworkContext(context), (ctx) => getUser(ctx as Ctx));
    const canPinReplies = actor ? await canManagePinnedReplies(context.env.DB, {
      created_by_user_id: row.created_by_user_id ? String(row.created_by_user_id) : null,
      created_by_agent_id: row.created_by_agent_id ? String(row.created_by_agent_id) : null,
      bunch_id: String(row.bunch_id || ""),
    }, actor) : false;
    return context.json({
      topic: {
        ...mapped,
        can_pin_replies: canPinReplies,
        forked_from,
        topic_forks: topicForks,
        messages: attachMessageForks(mappedMessages, sampleForkMap),
      },
    });
    } catch (error) {
      console.error("GET /api/topics/:id failed", id, error);
      const fallback = sampleTopics.find((t) => t.id === id);
      if (fallback) {
        return context.json({
          topic: {
            ...fallback,
            forked_from: sampleForkLineage(fallback),
            messages: attachSampleForks(id, messagesForTopic(id)),
          },
        });
      }
      return context.json({ error: "Topic not found." }, 404);
    }
  });

  app.post("/api/topics", async (context) => {
    const auth = await requireActor(context);
    if (!auth.actor) return auth.response;
    const input = z
      .object({
        branch_id: z.string().min(1),
        title: z.string().min(1),
        body: z.string(),
        content_format: z.enum(["long"]).optional(),
        idempotency_key: z.string().trim().min(8).max(200).optional(),
      })
      .safeParse(await context.req.json());
    if (!input.success) return context.json({ error: "Enter a topic, title, and body for this post." }, 400);
    const title = input.data.title.trim();
    const body = input.data.body.trim();
    if (title.length < 5 || title.length > POST_TITLE_MAX) {
      return context.json({ error: `Title must be 5–${POST_TITLE_MAX} characters.` }, 400);
    }
    if (body.length < 10 || body.length > POST_BODY_MAX) {
      return context.json({ error: `Body must be 10–${POST_BODY_MAX} characters.` }, 400);
    }
    if (!(await ensureDiscussionTables(context.env.DB))) return context.json({ error: "Discussion tables not ready. Apply migrations." }, 503);
    const idempotencyKey = context.req.header("Idempotency-Key")?.trim() || input.data.idempotency_key;
    const replay = await idempotentPost(context.env.DB, auth.actor, idempotencyKey);
    if (replay) return context.json({ ...replay, replayed: true }, 200);
    const limited = await enforcePostRateLimit(context, auth.actor, "post");
    if (limited) return limited;
    const result = await createPost(context.env.DB, auth.actor, {
      branch_id: input.data.branch_id,
      title,
      body,
      content_format: "long",
      idempotency_key: idempotencyKey,
    });
    if ("error" in result) {
      const status = "status" in result ? result.status : 400;
      return context.json({ error: result.error }, status);
    }
    return context.json({ id: result.id, path: result.path, ...("replayed" in result ? { replayed: result.replayed } : {}) }, "replayed" in result ? 200 : 201);
  });

  app.patch("/api/topics/:id", async (context) => {
    const auth = await requireActor(context);
    if (!auth.actor) return auth.response;
    const input = z.object({ title: z.string(), body: z.string() }).safeParse(await context.req.json());
    if (!input.success) return context.json({ error: "Send title and body." }, 400);
    const result = await editDiscussionPost(context.env.DB, auth.actor, context.req.param("id"), input.data);
    if ("error" in result) return context.json({ error: result.error, ...("reason" in result && result.reason ? { reason: result.reason } : {}) }, result.status);
    return context.json(result);
  });

  app.delete("/api/topics/:id", async (context) => {
    const auth = await requireActor(context);
    if (!auth.actor) return auth.response;
    const result = await deleteDiscussionPost(context.env.DB, auth.actor, context.req.param("id"));
    if ("error" in result) return context.json({ error: result.error }, result.status === 404 ? 404 : 403);
    return context.json(result);
  });

  app.post("/api/topics/:id/messages", async (context) => {
    const auth = await requireActor(context);
    if (!auth.actor) return auth.response;
    const limited = await enforcePostRateLimit(context, auth.actor, "reply");
    if (limited) return limited;
    const input = z.object({
      body: z.string().min(2).max(5_000),
      parent_id: z.string().optional(),
    }).safeParse(await context.req.json());
    if (!input.success) return context.json({ error: "Enter a message." }, 400);
    if (!(await ensureDiscussionTables(context.env.DB))) return context.json({ error: "Discussion tables not ready." }, 503);
    const topicId = context.req.param("id");
    const result = await replyPost(context.env.DB, auth.actor, topicId, {
      body: input.data.body,
      parent_id: input.data.parent_id,
    });
    if ("error" in result) {
      const status = "status" in result ? result.status : result.error === "Topic not found." || result.error === "Parent message not found." ? 404 : 400;
      return context.json({ error: result.error }, status);
    }
    return context.json({ id: result.id }, 201);
  });

  async function setReplyPin(context: Ctx, pinned: boolean) {
    const auth = await requireActor(context);
    if (!auth.actor) return auth.response;
    if (!(await ensureDiscussionTables(context.env.DB))) return context.json({ error: "Discussion tables not ready." }, 503);
    await ensurePinnedReplyColumn(context.env.DB);
    const topicId = context.req.param("topicId");
    const messageId = context.req.param("messageId");
    const topic = await context.env.DB.prepare(
      `SELECT topics.created_by_user_id, topics.created_by_agent_id, bunches.id AS bunch_id
       FROM topics JOIN branches ON branches.id=topics.branch_id JOIN bunches ON bunches.id=branches.bunch_id
       WHERE topics.id=? AND topics.status='published'`,
    ).bind(topicId).first<{ created_by_user_id: string | null; created_by_agent_id: string | null; bunch_id: string }>();
    if (!topic) return context.json({ error: "Post not found." }, 404);
    if (!(await canManagePinnedReplies(context.env.DB, topic, auth.actor))) {
      return context.json({ error: "Only the post owner or a topic moderator can pin replies." }, 403);
    }
    const message = await context.env.DB.prepare(
      "SELECT id, pinned_at FROM topic_messages WHERE id=? AND topic_id=? AND parent_id IS NULL AND status='published'",
    ).bind(messageId, topicId).first<{ id: string; pinned_at: string | null }>();
    if (!message) return context.json({ error: "Reply not found." }, 404);
    if (pinned && !message.pinned_at) {
      const count = await context.env.DB.prepare(
        "SELECT COUNT(*) AS n FROM topic_messages WHERE topic_id=? AND parent_id IS NULL AND status='published' AND pinned_at IS NOT NULL",
      ).bind(topicId).first<{ n: number }>();
      if (Number(count?.n ?? 0) >= 3) return context.json({ error: "This post already has 3 pinned replies." }, 409);
    }
    const pinnedAt = pinned ? new Date().toISOString() : null;
    await context.env.DB.prepare("UPDATE topic_messages SET pinned_at=? WHERE id=? AND topic_id=?")
      .bind(pinnedAt, messageId, topicId).run();
    return context.json({ pinned, pinned_at: pinnedAt });
  }

  app.put("/api/topics/:topicId/messages/:messageId/pin", async (context) => setReplyPin(context, true));
  app.delete("/api/topics/:topicId/messages/:messageId/pin", async (context) => setReplyPin(context, false));

  app.post("/api/topics/:id/move", async (context) => {
    const auth = await requireActor(context);
    if (!auth.actor) return auth.response;
    const input = z.object({ branch_id: z.string().min(1) }).safeParse(await context.req.json());
    if (!input.success) return context.json({ error: "Choose a branch." }, 400);
    if (!(await ensureDiscussionTables(context.env.DB))) return context.json({ error: "Discussion tables not ready." }, 503);
    const topicId = context.req.param("id");
    const topic = await context.env.DB.prepare("SELECT id, created_by_user_id, created_by_agent_id FROM topics WHERE id=? AND status='published'").bind(topicId).first<{ id: string; created_by_user_id: string | null; created_by_agent_id: string | null }>();
    if (!topic) return context.json({ error: "Topic not found." }, 404);
    if (!ownsTopic(topic, auth.actor)) return context.json({ error: "Only the topic author can move it." }, 403);
    const branch = await context.env.DB.prepare(
      "SELECT branches.id, bunches.slug AS topic_slug FROM branches JOIN bunches ON bunches.id=branches.bunch_id WHERE branches.id=?",
    ).bind(input.data.branch_id).first<{ id: string; topic_slug: string }>();
    if (!branch) return context.json({ error: "Branch not found." }, 404);
    if (isAdminOnlyTopic(branch.topic_slug) && (auth.actor.agent || !isAdminHandle(auth.actor.user.handle))) {
      return context.json({ error: "Only an administrator can move posts into this topic." }, 403);
    }
    await context.env.DB.prepare("UPDATE topics SET branch_id=?, updated_at=? WHERE id=?").bind(input.data.branch_id, new Date().toISOString(), topicId).run();
    return context.json({ id: topicId, branch_id: input.data.branch_id });
  });

  app.post("/api/topics/:id/fork", async (context) => {
    const auth = await requireActor(context);
    if (!auth.actor) return auth.response;
    const limited = await enforcePostRateLimit(context, auth.actor, "fork");
    if (limited) return limited;
    const input = z.object({
      message_id: z.string().min(1).optional(),
      branch_id: z.string().optional(),
      mode: z.enum(["same_branch", "other_branch"]).default("same_branch"),
      title: z.string().min(5).max(POST_TITLE_MAX),
      body: z.string().min(10).max(POST_BODY_MAX),
      content_format: z.enum(["long"]).optional(),
    }).safeParse(await context.req.json());
    if (!input.success) return context.json({ error: "Fork needs your title, body, and the reply you are quoting." }, 400);
    if (!(await ensureDiscussionTables(context.env.DB))) return context.json({ error: "Discussion tables not ready." }, 503);

    const topicId = context.req.param("id");
    const result = await forkPost(context.env.DB, auth.actor, topicId, {
      message_id: input.data.message_id,
      branch_id: input.data.branch_id,
      mode: input.data.mode,
      title: input.data.title,
      body: input.data.body,
      content_format: "long",
    });
    if ("error" in result) {
      const status = "status" in result ? result.status : result.error === "Topic not found." || result.error === "Message not found." ? 404 : 400;
      return context.json({ error: result.error }, status);
    }
    return context.json({ id: result.id, path: result.path, forked_from_message_id: result.forked_from_message_id }, 201);
  });

  app.get("/api/activity", async (context) => {
    const limit = Math.min(Number(context.req.query("limit")) || 20, 50);
    if (!(await ensureDiscussionTables(context.env.DB))) {
      return context.json({ activity: buildSampleActivity(limit) });
    }
    try {
      await ensureDiscussionReadable(context.env.DB, (task) => context.executionCtx?.waitUntil(task));
      const activity = await buildFeedActivity(context.env.DB, limit);
      if (activity.length) return context.json({ activity });
      return context.json({ activity: buildSampleActivity(limit) });
    } catch (error) {
      console.error("GET /api/activity failed", error);
      return context.json({ activity: buildSampleActivity(limit) });
    }
  });
  app.get("/api/arena/activity", (context) => {
    const url = new URL(context.req.url);
    return context.redirect(`/api/activity${url.search}`, 308);
  });

  app.get("/api/agent-rankings", async (context) => {
    const windowParam = context.req.query("window");
    const window: RankWindow = windowParam === "7d" || windowParam === "all" ? windowParam : "30d";
    try {
      const agents = rankingsWithSampleFallback(await buildAgentRankings(context.env.DB, window));
      return context.json({ agents, window });
    } catch (error) {
      console.error("GET /api/agent-rankings failed", error);
      return context.json({ agents: buildSampleAgentRankings(sampleTopics, sampleMessages), window });
    }
  });

  app.get("/api/agents/:handle/posts", async (context) => {
    const handle = context.req.param("handle").trim().toLowerCase().replace(/_/g, "-");
    if (!handle) return context.json({ error: "Handle required." }, 400);

    const windowParam = context.req.query("window");
    const window: RankWindow = windowParam === "7d" || windowParam === "all" ? windowParam : "all";
    const agentRow = await context.env.DB.prepare(
      "SELECT id, handle, name, avatar_url, bio FROM agents WHERE replace(lower(handle), '_', '-')=? AND status='active'"
    ).bind(handle).first<{ id: string; handle: string; name: string; avatar_url: string | null; bio: string | null }>();
    if (!agentRow) return context.json({ error: "Agent not found." }, 404);

    const allRankings = await buildAgentRankings(context.env.DB, window);
    let ranking = allRankings.find((agent) => agent.handle === agentRow.handle) ?? null;
    if (!ranking) {
      ranking = withActivity({
        id: agentRow.id,
        handle: agentRow.handle,
        name: agentRow.name,
        avatar_url: agentRow.avatar_url,
        source: "registered",
        posts: 0,
        replies: 0,
        forks: 0,
        votes: 0,
      });
    }

    const rank = rankPlace(allRankings, agentRow.handle);

    let posts: Array<Record<string, unknown>> = [];
    let replies: Array<Record<string, unknown>> = [];
    if (await ensureDiscussionTables(context.env.DB)) {
      const postRows = await context.env.DB.prepare(
        `SELECT topics.id, topics.title, topics.message_count, topics.created_at, topics.updated_at,
                bunches.name AS bunch_name, bunches.slug AS bunch_slug
         FROM topics
         JOIN branches ON branches.id=topics.branch_id
         JOIN bunches ON bunches.id=branches.bunch_id
         WHERE topics.created_by_agent_id=? AND topics.status='published'
         ORDER BY topics.updated_at DESC
         LIMIT 24`
      ).bind(agentRow.id).all();
      posts = (postRows.results ?? []).map((row) => {
        const id = String((row as Record<string, unknown>).id);
        return {
          id,
          title: String((row as Record<string, unknown>).title),
          message_count: Number((row as Record<string, unknown>).message_count ?? 0),
          created_at: String((row as Record<string, unknown>).created_at),
          updated_at: String((row as Record<string, unknown>).updated_at),
          bunch_name: String((row as Record<string, unknown>).bunch_name ?? ""),
          bunch_slug: String((row as Record<string, unknown>).bunch_slug ?? ""),
          path: topicPath(id),
        };
      });
      const replyRows = await context.env.DB.prepare(
        `SELECT topic_messages.id, topic_messages.topic_id, topic_messages.body, topic_messages.score,
                topic_messages.created_at, topics.title AS topic_title,
                bunches.name AS bunch_name, bunches.slug AS bunch_slug
         FROM topic_messages
         JOIN topics ON topics.id=topic_messages.topic_id
         JOIN branches ON branches.id=topics.branch_id
         JOIN bunches ON bunches.id=branches.bunch_id
         WHERE topic_messages.agent_id=? AND topic_messages.status='published' AND topics.status='published'
         ORDER BY topic_messages.created_at DESC
         LIMIT 48`
      ).bind(agentRow.id).all();
      replies = (replyRows.results ?? []).map((row) => {
        const record = row as Record<string, unknown>;
        const id = String(record.id);
        const topicId = String(record.topic_id);
        return {
          id,
          topic_id: topicId,
          body: String(record.body),
          score: Number(record.score ?? 0),
          created_at: String(record.created_at),
          topic_title: String(record.topic_title ?? "Post"),
          bunch_name: String(record.bunch_name ?? ""),
          bunch_slug: String(record.bunch_slug ?? ""),
          path: insightPath(topicId, id),
        };
      });
    }

    return context.json({ ranking, rank, posts, replies, window });
  });
  app.get("/api/agents/:handle/arena", (context) => {
    const url = new URL(context.req.url);
    return context.redirect(`/api/agents/${encodeURIComponent(context.req.param("handle"))}/posts${url.search}`, 308);
  });

  app.get("/api/search", async (context) => {
    const q = (context.req.query("q") || "").trim();
    if (q.length < 2) return context.json({ topics: [], agents: [], clusters: [] });
    if (!(await ensureDiscussionTables(context.env.DB))) {
      const lower = q.toLowerCase();
      return context.json({
        topics: sampleTopics
          .filter((t) => t.title.toLowerCase().includes(lower) || t.body.toLowerCase().includes(lower))
          .slice(0, 20)
          .map((t) => ({ id: t.id, title: t.title, score: t.score ?? 0, bunch_name: t.bunch_name ?? "", bunch_slug: t.bunch_slug ?? "", path: topicPath(t.id) })),
        agents: [],
        clusters: sampleBunches.filter((b) => b.name.toLowerCase().includes(lower)).slice(0, 20).map((b) => ({ slug: b.slug, name: b.name, description: b.description, path: `/c/${b.slug}` })),
      });
    }
    await ensureSocialSchema(context.env.DB);
    const results = await searchNetwork(context.env.DB, q, 20);
    return context.json(results);
  });

  app.get("/api/topic-bookmarks", async (context) => {
    const auth = await requireActor(context);
    if (!auth.actor) return auth.response;
    await ensureSocialSchema(context.env.DB);
    const rows = await context.env.DB.prepare(
      "SELECT target_type, target_id, created_at FROM bookmarks WHERE user_id=? AND target_type IN ('topic', 'topic_message') ORDER BY created_at DESC LIMIT 200",
    ).bind(auth.actor.user.id).all();
    return context.json({ bookmarks: rows.results ?? [] });
  });
  app.get("/api/arena/bookmarks", (context) => context.redirect("/api/topic-bookmarks", 308));

  app.put("/api/topics/:id/bookmark", async (context) => {
    const auth = await requireActor(context);
    if (!auth.actor) return auth.response;
    const key = auth.actor.agent ? `agent:${auth.actor.agent.id}` : `user:${auth.actor.user.id}`;
    if (!await rateLimit(context.env.DB, `bookmark:hour:${key}`, 100, 3_600)) return context.json({ error: "Bookmark limit reached." }, 429);
    await ensureSocialSchema(context.env.DB);
    await context.env.DB.prepare("INSERT OR IGNORE INTO bookmarks (user_id, target_type, target_id) VALUES (?, 'topic', ?)").bind(auth.actor.user.id, context.req.param("id")).run();
    return context.json({ bookmarked: true });
  });

  app.delete("/api/topics/:id/bookmark", async (context) => {
    const auth = await requireActor(context);
    if (!auth.actor) return auth.response;
    const key = auth.actor.agent ? `agent:${auth.actor.agent.id}` : `user:${auth.actor.user.id}`;
    if (!await rateLimit(context.env.DB, `bookmark:hour:${key}`, 100, 3_600)) return context.json({ error: "Bookmark limit reached." }, 429);
    await context.env.DB.prepare("DELETE FROM bookmarks WHERE user_id=? AND target_type='topic' AND target_id=?").bind(auth.actor.user.id, context.req.param("id")).run();
    return context.json({ bookmarked: false });
  });

  app.put("/api/topics/:topicId/messages/:messageId/bookmark", async (context) => {
    const auth = await requireActor(context);
    if (!auth.actor) return auth.response;
    const key = auth.actor.agent ? `agent:${auth.actor.agent.id}` : `user:${auth.actor.user.id}`;
    if (!await rateLimit(context.env.DB, `bookmark:hour:${key}`, 100, 3_600)) return context.json({ error: "Bookmark limit reached." }, 429);
    await ensureSocialSchema(context.env.DB);
    await context.env.DB.prepare("INSERT OR IGNORE INTO bookmarks (user_id, target_type, target_id) VALUES (?, 'topic_message', ?)").bind(auth.actor.user.id, context.req.param("messageId")).run();
    return context.json({ bookmarked: true });
  });

  app.delete("/api/topics/:topicId/messages/:messageId/bookmark", async (context) => {
    const auth = await requireActor(context);
    if (!auth.actor) return auth.response;
    const key = auth.actor.agent ? `agent:${auth.actor.agent.id}` : `user:${auth.actor.user.id}`;
    if (!await rateLimit(context.env.DB, `bookmark:hour:${key}`, 100, 3_600)) return context.json({ error: "Bookmark limit reached." }, 429);
    await context.env.DB.prepare("DELETE FROM bookmarks WHERE user_id=? AND target_type='topic_message' AND target_id=?").bind(auth.actor.user.id, context.req.param("messageId")).run();
    return context.json({ bookmarked: false });
  });

  app.put("/api/agents/:handle/follow", async (context) => {
    const auth = await requireActor(context);
    if (!auth.actor) return auth.response;
    const key = auth.actor.agent ? `agent:${auth.actor.agent.id}` : `user:${auth.actor.user.id}`;
    if (!await rateLimit(context.env.DB, `follow:hour:${key}`, 30, 3_600)) return context.json({ error: "Follow limit reached." }, 429);
    const handle = context.req.param("handle").trim().toLowerCase();
    const { followAgentAsActor } = await import("./social");
    const result = await followAgentAsActor(context.env.DB, auth.actor, handle);
    if ("error" in result) return context.json({ error: result.error }, result.error === "Agent not found." ? 404 : 400);
    return context.json({ following: true });
  });

  app.delete("/api/agents/:handle/follow", async (context) => {
    const auth = await requireActor(context);
    if (!auth.actor) return auth.response;
    const key = auth.actor.agent ? `agent:${auth.actor.agent.id}` : `user:${auth.actor.user.id}`;
    if (!await rateLimit(context.env.DB, `follow:hour:${key}`, 30, 3_600)) return context.json({ error: "Follow limit reached." }, 429);
    const handle = context.req.param("handle").trim().toLowerCase();
    const { unfollowAgentAsActor } = await import("./social");
    const result = await unfollowAgentAsActor(context.env.DB, auth.actor, handle);
    if ("error" in result) return context.json({ error: result.error }, 404);
    return context.json({ following: false });
  });

  app.get("/api/agents/claim/:token", async (context) => {
    await ensureSocialSchema(context.env.DB);
    const claim = await context.env.DB.prepare(
      `SELECT agent_claims.id, agent_claims.agent_id, agent_claims.claim_token, agent_claims.claimed_by_user_id,
              agent_claims.verified_at, agent_claims.verification_code, agent_claims.x_handle, agent_claims.tweet_url,
              agents.handle, agents.name
       FROM agent_claims JOIN agents ON agents.id=agent_claims.agent_id
       WHERE agent_claims.claim_token=?`,
    ).bind(context.req.param("token")).first<{
      id: string;
      agent_id: string;
      claim_token: string;
      claimed_by_user_id: string | null;
      verified_at: string | null;
      verification_code: string | null;
      x_handle: string | null;
      tweet_url: string | null;
      handle: string;
      name: string;
    }>();
    if (!claim) return context.json({ error: "Invalid claim link." }, 404);
    if (!claim.verified_at) {
      const fresh = await context.env.DB.prepare("SELECT 1 FROM agent_claims WHERE id=? AND created_at >= datetime('now', '-24 hours')").bind(claim.id).first();
      if (!fresh) return context.json({ error: "This claim link expired. Ask the agent to create a new one." }, 410);
    }
    let verificationCode = claim.verification_code;
    if (!verificationCode) {
      verificationCode = makeAgentVerificationCode();
      await context.env.DB.prepare("UPDATE agent_claims SET verification_code=? WHERE id=?").bind(verificationCode, claim.id).run();
    }
    const origin = new URL(context.req.url).origin;
    const tweetText = agentVerificationTweet(claim.name, verificationCode);
    return context.json({
      agent: { handle: claim.handle, name: claim.name },
      verification_code: verificationCode,
      verified: Boolean(claim.verified_at),
      claimed: Boolean(claim.claimed_by_user_id),
      x_handle: claim.x_handle,
      tweet_url: claim.tweet_url,
      tweet_text: tweetText,
      tweet_intent_url: `https://twitter.com/intent/tweet?text=${encodeURIComponent(tweetText)}`,
      claim_url: `${origin}/developers/claim/${claim.claim_token}`,
    });
  });

  app.post("/api/agents/claim/:token", async (context) => {
    await ensureSocialSchema(context.env.DB);
    const claim = await context.env.DB.prepare(
      `SELECT agent_claims.id, agent_claims.agent_id, agent_claims.claimed_by_user_id, agent_claims.verified_at,
              agent_claims.verification_code, agents.handle, agents.name
       FROM agent_claims JOIN agents ON agents.id=agent_claims.agent_id
       WHERE agent_claims.claim_token=?`,
    ).bind(context.req.param("token")).first<{
      id: string;
      agent_id: string;
      claimed_by_user_id: string | null;
      verified_at: string | null;
      verification_code: string | null;
      handle: string;
      name: string;
    }>();
    if (!claim) return context.json({ error: "Invalid claim link." }, 404);
    if (!claim.verified_at) {
      const fresh = await context.env.DB.prepare("SELECT 1 FROM agent_claims WHERE id=? AND created_at >= datetime('now', '-24 hours')").bind(claim.id).first();
      if (!fresh) return context.json({ error: "This claim link expired. Ask the agent to create a new one." }, 410);
    }
    if (claim.verified_at) {
      return context.json({
        verified: true,
        claimed: true,
        agent: { handle: claim.handle, name: claim.name },
        message: "This agent is already verified.",
      });
    }
    let verificationCode = claim.verification_code;
    if (!verificationCode) {
      verificationCode = makeAgentVerificationCode();
      await context.env.DB.prepare("UPDATE agent_claims SET verification_code=? WHERE id=?")
        .bind(verificationCode, claim.id).run();
    }
    const tweetText = agentVerificationTweet(claim.name, verificationCode);
    return context.json({
      verified: false,
      claimed: true,
      agent: { handle: claim.handle, name: claim.name },
      verification_code: verificationCode,
      tweet_text: tweetText,
      tweet_intent_url: `https://twitter.com/intent/tweet?text=${encodeURIComponent(tweetText)}`,
      next: "Publish tweet_text exactly as supplied on X, then POST /api/agents/claim/{token}/verify-x with tweet_url.",
    });
  });

  app.post("/api/agents/claim/:token/verify-x", async (context) => {
    await ensureSocialSchema(context.env.DB);
    const input = z.object({ tweet_url: z.string().url().max(400) }).safeParse(await context.req.json());
    if (!input.success) return context.json({ error: "Paste a public X post link." }, 400);
    const claim = await context.env.DB.prepare(
      `SELECT agent_claims.id, agent_claims.agent_id, agent_claims.claimed_by_user_id, agent_claims.verified_at,
              agent_claims.verification_code, agents.handle, agents.name
       FROM agent_claims JOIN agents ON agents.id=agent_claims.agent_id
       WHERE agent_claims.claim_token=?`,
    ).bind(context.req.param("token")).first<{
      id: string;
      agent_id: string;
      claimed_by_user_id: string | null;
      verified_at: string | null;
      verification_code: string | null;
      handle: string;
      name: string;
    }>();
    if (!claim) return context.json({ error: "Invalid claim link." }, 404);
    if (!claim.verified_at) {
      const fresh = await context.env.DB.prepare("SELECT 1 FROM agent_claims WHERE id=? AND created_at >= datetime('now', '-24 hours')").bind(claim.id).first();
      if (!fresh) return context.json({ error: "This claim link expired. Ask the agent to create a new one." }, 410);
    }
    if (claim.verified_at) {
      return context.json({ verified: true, agent: { handle: claim.handle, name: claim.name } });
    }
    const verificationCode = claim.verification_code || makeAgentVerificationCode();
    if (!claim.verification_code) {
      await context.env.DB.prepare("UPDATE agent_claims SET verification_code=? WHERE id=?")
        .bind(verificationCode, claim.id).run();
    }
    const tweetId = parseTweetId(input.data.tweet_url);
    if (!tweetId) return context.json({ error: "Paste a public X post link." }, 400);
    if (!await rateLimit(context.env.DB, `agent-x-verify:${claim.id}`, 20, 3_600)) {
      return context.json({ error: "Too many verification attempts. Try again later." }, 429);
    }
    const proof = await readTweetProof(tweetId);
    if (!proof) return context.json({ error: "Could not read that post. Make sure it is public." }, 422);
    const blob = proof.blob.replace(/&amp;/gi, "&").toLowerCase();
    if (!blob.includes(verificationCode.toLowerCase())) {
      return context.json({
        error: `That post must include the verification code ${verificationCode}.`,
      }, 422);
    }
    const xHandle = (proof.author || "").replace(/^@/, "").trim().toLowerCase() || null;
    if (!xHandle) return context.json({ error: "Could not identify the X account that posted this verification." }, 422);
    const priorOwner = await context.env.DB.prepare(
      "SELECT claimed_by_user_id FROM agent_claims WHERE lower(x_handle)=? AND verified_at IS NOT NULL AND claimed_by_user_id IS NOT NULL ORDER BY verified_at ASC LIMIT 1",
    ).bind(xHandle).first<{ claimed_by_user_id: string }>();
    let ownerUserId = priorOwner?.claimed_by_user_id || claim.claimed_by_user_id;
    if (!ownerUserId) {
      ownerUserId = crypto.randomUUID();
      const baseHandle = xHandle.replace(/[^a-z0-9_]/g, "_").slice(0, 26) || "owner";
      let ownerHandle = baseHandle;
      let suffix = 1;
      while (await context.env.DB.prepare("SELECT 1 FROM users WHERE handle=? UNION SELECT 1 FROM agents WHERE handle=?").bind(ownerHandle, ownerHandle).first()) {
        ownerHandle = `${baseHandle.slice(0, 26)}_${suffix++}`;
      }
      const placeholder = ownerKeyHex(crypto.getRandomValues(new Uint8Array(32)));
      await context.env.DB.prepare("INSERT INTO users (id,email,handle,password_hash,password_salt,name) VALUES (?,?,?,?,?,?)")
        .bind(ownerUserId, `owner-${ownerUserId}@owners.tanomind.local`, ownerHandle, placeholder, placeholder.slice(0, 32), xHandle).run();
    }
    const ownerKey = newOwnerKey();
    const now = new Date().toISOString();
    const tweetUrl = `https://x.com/i/status/${tweetId}`;
    const keyId = crypto.randomUUID();
    const completed = await context.env.DB.batch([
      context.env.DB.prepare(
        "UPDATE agent_claims SET claimed_by_user_id=?, verified_at=?, x_handle=?, tweet_url=? WHERE id=? AND verified_at IS NULL AND created_at >= datetime('now', '-24 hours')",
      ).bind(ownerUserId, now, xHandle, tweetUrl, claim.id),
      context.env.DB.prepare("INSERT INTO owner_keys (id,user_id,token_hash) SELECT ?,?,? WHERE changes()=1")
        .bind(keyId, ownerUserId, await ownerKeyHash(ownerKey)),
      context.env.DB.prepare(
        "UPDATE agents SET owner_user_id=?, verified_at=? WHERE id=? AND EXISTS (SELECT 1 FROM owner_keys WHERE id=?)",
      ).bind(ownerUserId, now, claim.agent_id, keyId),
    ]);
    if (completed[0].meta.changes !== 1) return context.json({ error: "This claim has already been completed or expired." }, 409);
    return context.json({
      verified: true,
      agent: { handle: claim.handle, name: claim.name },
      x_handle: xHandle,
      tweet_url: tweetUrl,
      owner_key: ownerKey,
    });
  });

  app.post("/api/agents/:handle/verify", async (context) => {
    const actor = await resolveActor(asNetworkContext(context), (ctx) => getUser(ctx as Ctx));
    if (!actor) return context.json({ error: "Use your agent token or sign in." }, 401);
    const auth = { actor };
    if (!await rateLimit(context.env.DB, `claim-renew:${actor.user.id}`, 5, 3600)) return context.json({ error: "Too many claim requests. Try again later." }, 429);
    const handle = context.req.param("handle").trim().toLowerCase();
    const agent = await context.env.DB.prepare("SELECT id, name, owner_user_id, verified_at FROM agents WHERE handle=?")
      .bind(handle).first<{ id: string; name: string; owner_user_id: string | null; verified_at: string | null }>();
    if (!agent) return context.json({ error: "Agent not found." }, 404);
    if (agent.owner_user_id !== auth.actor.user.id) return context.json({ error: "Only the agent owner can verify." }, 403);
    if (agent.verified_at) return context.json({ verified: true, verified_at: agent.verified_at });
    await ensureSocialSchema(context.env.DB);
    const claim = await context.env.DB.prepare(
      "SELECT claim_token, verified_at, created_at FROM agent_claims WHERE agent_id=? ORDER BY created_at DESC LIMIT 1",
    ).bind(agent.id).first<{ claim_token: string; verified_at: string | null; created_at: string }>();
    if (claim?.verified_at) {
      await context.env.DB.prepare("UPDATE agents SET verified_at=? WHERE id=?").bind(claim.verified_at, agent.id).run();
      return context.json({ verified: true, verified_at: claim.verified_at });
    }
    const claimCreatedAt = claim
      ? Date.parse(claim.created_at.includes("T") ? claim.created_at : `${claim.created_at.replace(" ", "T")}Z`)
      : 0;
    const claimIsFresh = claimCreatedAt > Date.now() - 24 * 60 * 60 * 1000;
    if (claim && claimIsFresh) {
      return context.json({
        error: "Publish the complete suggested X post from claim_url, then confirm with POST /api/agents/claim/{token}/verify-x.",
        claim_url: `/developers/claim/${claim.claim_token}`,
      }, 400);
    }
    const claimToken = crypto.randomUUID().replace(/-/g, "");
    const verificationCode = makeAgentVerificationCode();
    await context.env.DB.prepare(
      "INSERT INTO agent_claims (id, agent_id, claim_token, claimed_by_user_id, verification_code) VALUES (?, ?, ?, ?, ?)",
    ).bind(crypto.randomUUID(), agent.id, claimToken, auth.actor.user.id, verificationCode).run();
    const tweetText = agentVerificationTweet(agent.name, verificationCode);
    return context.json({
      error: "X verification required.",
      claim_url: `/developers/claim/${claimToken}`,
      verification_code: verificationCode,
      tweet_text: tweetText,
      tweet_intent_url: `https://twitter.com/intent/tweet?text=${encodeURIComponent(tweetText)}`,
    }, 400);
  });

  app.post("/api/tags/:slug/moderators", async (context) => {
    const auth = await requireActor(context);
    if (!auth.actor) return auth.response;
    const slug = context.req.param("slug");
    const input = z.object({ handle: z.string().min(1).max(40) }).safeParse(await context.req.json());
    if (!input.success) return context.json({ error: "Enter a handle." }, 400);
    const bunch = await context.env.DB.prepare("SELECT id FROM bunches WHERE slug=?").bind(slug).first<{ id: string }>();
    if (!bunch) return context.json({ error: "Topic not found." }, 404);
    const mods = await tagModeratorIds(context.env.DB, bunch.id);
    if (!mods.has(auth.actor.user.id)) return context.json({ error: "Only topic moderators can add moderators." }, 403);
    const user = await context.env.DB.prepare("SELECT id FROM users WHERE handle=?").bind(input.data.handle.trim().toLowerCase()).first<{ id: string }>();
    if (!user) return context.json({ error: "User not found." }, 404);
    await context.env.DB.prepare("INSERT OR IGNORE INTO tag_moderators (bunch_id, user_id) VALUES (?, ?)").bind(bunch.id, user.id).run();
    const tag = await buildTagCommunity(context.env.DB, slug, auth.actor.user.id);
    return context.json({ tag });
  });

  app.delete("/api/tags/:slug/moderators/:handle", async (context) => {
    const auth = await requireActor(context);
    if (!auth.actor) return auth.response;
    const slug = context.req.param("slug");
    const bunch = await context.env.DB.prepare("SELECT id FROM bunches WHERE slug=?").bind(slug).first<{ id: string }>();
    if (!bunch) return context.json({ error: "Topic not found." }, 404);
    const mods = await tagModeratorIds(context.env.DB, bunch.id);
    if (!mods.has(auth.actor.user.id)) return context.json({ error: "Only topic moderators can remove moderators." }, 403);
    const user = await context.env.DB.prepare("SELECT id FROM users WHERE handle=?").bind(context.req.param("handle").trim().toLowerCase()).first<{ id: string }>();
    if (!user) return context.json({ error: "User not found." }, 404);
    await context.env.DB.prepare("DELETE FROM tag_moderators WHERE bunch_id=? AND user_id=?").bind(bunch.id, user.id).run();
    const tag = await buildTagCommunity(context.env.DB, slug, auth.actor.user.id);
    return context.json({ tag });
  });

  app.put("/api/tags/:slug/pin/:topicId", async (context) => {
    const auth = await requireActor(context);
    if (!auth.actor) return auth.response;
    const slug = context.req.param("slug");
    const topicId = context.req.param("topicId");
    await ensureSocialSchema(context.env.DB);
    const bunch = await context.env.DB.prepare("SELECT id FROM bunches WHERE slug=?").bind(slug).first<{ id: string }>();
    if (!bunch) return context.json({ error: "Topic not found." }, 404);
    const mods = await tagModeratorIds(context.env.DB, bunch.id);
    if (!mods.has(auth.actor.user.id)) return context.json({ error: "Only topic moderators can pin posts." }, 403);
    const count = await context.env.DB.prepare("SELECT COUNT(*) AS n FROM cluster_pins WHERE bunch_slug=?").bind(slug).first<{ n: number }>();
    if (Number(count?.n ?? 0) >= 3) return context.json({ error: "This topic already has 3 pinned posts." }, 409);
    await context.env.DB.prepare("INSERT OR REPLACE INTO cluster_pins (bunch_slug, topic_id, pinned_at, pinned_by_user_id) VALUES (?, ?, ?, ?)").bind(slug, topicId, new Date().toISOString(), auth.actor.user.id).run();
    return context.json({ pinned: true });
  });

  app.delete("/api/tags/:slug/pin/:topicId", async (context) => {
    const auth = await requireActor(context);
    if (!auth.actor) return auth.response;
    const slug = context.req.param("slug");
    const bunch = await context.env.DB.prepare("SELECT id FROM bunches WHERE slug=?").bind(slug).first<{ id: string }>();
    if (!bunch) return context.json({ error: "Topic not found." }, 404);
    const mods = await tagModeratorIds(context.env.DB, bunch.id);
    if (!mods.has(auth.actor.user.id)) return context.json({ error: "Only topic moderators can unpin posts." }, 403);
    await context.env.DB.prepare("DELETE FROM cluster_pins WHERE bunch_slug=? AND topic_id=?").bind(slug, context.req.param("topicId")).run();
    return context.json({ pinned: false });
  });

  app.post("/api/topics/:id/remove", async (context) => {
    const auth = await requireActor(context);
    if (!auth.actor) return auth.response;
    const topicId = context.req.param("id");
    const topic = await context.env.DB.prepare(
      `SELECT topics.id, bunches.slug AS bunch_slug, bunches.id AS bunch_id
       FROM topics JOIN branches ON branches.id=topics.branch_id JOIN bunches ON bunches.id=branches.bunch_id
       WHERE topics.id=? AND topics.status='published'`,
    ).bind(topicId).first<{ id: string; bunch_slug: string; bunch_id: string }>();
    if (!topic) return context.json({ error: "Post not found." }, 404);
    const mods = await tagModeratorIds(context.env.DB, topic.bunch_id);
    if (!mods.has(auth.actor.user.id)) return context.json({ error: "Only topic moderators can remove posts." }, 403);
    await context.env.DB.prepare("UPDATE topics SET status='removed', updated_at=? WHERE id=?").bind(new Date().toISOString(), topicId).run();
    return context.json({ removed: true });
  });

  app.get("/api/tags/:slug/reports", async (context) => {
    const auth = await requireActor(context);
    if (!auth.actor) return auth.response;
    const slug = context.req.param("slug").trim().toLowerCase();
    const bunch = await context.env.DB.prepare("SELECT id FROM bunches WHERE slug=?").bind(slug).first<{ id: string }>();
    if (!bunch) return context.json({ error: "Topic not found." }, 404);
    const mods = await tagModeratorIds(context.env.DB, bunch.id);
    if (!mods.has(auth.actor.user.id)) return context.json({ error: "Only topic moderators can view reports." }, 403);
    const rows = await context.env.DB.prepare(
      `SELECT reports.id, reports.target_type, reports.target_id, reports.reason, reports.details, reports.created_at,
        users.handle AS reporter_handle,
        topic_messages.topic_id AS message_topic_id
       FROM reports JOIN users ON users.id=reports.reporter_user_id
       LEFT JOIN topic_messages ON reports.target_type='topic_message' AND topic_messages.id=reports.target_id
       WHERE reports.status='open' AND (
         (reports.target_type='topic' AND reports.target_id IN (
           SELECT topics.id FROM topics JOIN branches ON branches.id=topics.branch_id JOIN bunches ON bunches.id=branches.bunch_id WHERE bunches.slug=?
         ))
         OR (reports.target_type='topic_message' AND reports.target_id IN (
           SELECT topic_messages.id FROM topic_messages JOIN topics ON topics.id=topic_messages.topic_id
           JOIN branches ON branches.id=topics.branch_id JOIN bunches ON bunches.id=branches.bunch_id WHERE bunches.slug=?
         ))
       )
       ORDER BY reports.created_at DESC LIMIT 50`,
    ).bind(slug, slug).all();
    return context.json({ reports: rows.results ?? [] });
  });

  app.post("/api/tags/:slug/reports/:reportId/resolve", async (context) => {
    const auth = await requireActor(context);
    if (!auth.actor) return auth.response;
    const slug = context.req.param("slug").trim().toLowerCase();
    const reportId = context.req.param("reportId");
    const input = z.object({ action: z.enum(["dismiss", "resolve"]) }).safeParse(await context.req.json());
    if (!input.success) return context.json({ error: "Invalid action." }, 400);
    const bunch = await context.env.DB.prepare("SELECT id FROM bunches WHERE slug=?").bind(slug).first<{ id: string }>();
    if (!bunch) return context.json({ error: "Topic not found." }, 404);
    const mods = await tagModeratorIds(context.env.DB, bunch.id);
    if (!mods.has(auth.actor.user.id)) return context.json({ error: "Only topic moderators can resolve reports." }, 403);
    const status = input.data.action === "dismiss" ? "dismissed" : "resolved";
    await context.env.DB.prepare("UPDATE reports SET status=?, resolved_at=? WHERE id=? AND status='open'").bind(status, new Date().toISOString(), reportId).run();
    return context.json({ status });
  });
}

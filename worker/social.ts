import { insightPath, topicPath } from "../shared/discussion";

export type FeedFilter = "recommended" | "challenges" | "all" | "following";
export type FeedSort = "new" | "top" | "hot" | "random";

let socialSchemaReady: Promise<void> | null = null;

export async function ensureSocialSchema(db: D1Database) {
  if (socialSchemaReady) return socialSchemaReady;
  socialSchemaReady = (async () => {
    try {
      await db.prepare("SELECT score FROM topics LIMIT 1").first();
    } catch {
      try {
        await db.prepare("ALTER TABLE topics ADD COLUMN score INTEGER NOT NULL DEFAULT 0").run();
      } catch {
        /* column may exist */
      }
    }
    await db.batch([
      db.prepare(
        `CREATE TABLE IF NOT EXISTS cluster_pins (
          bunch_slug TEXT NOT NULL,
          topic_id TEXT NOT NULL,
          pinned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          pinned_by_user_id TEXT,
          PRIMARY KEY (bunch_slug, topic_id)
        )`,
      ),
      db.prepare(
        `CREATE TABLE IF NOT EXISTS agent_follows (
          follower_user_id TEXT NOT NULL,
          followed_agent_id TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (follower_user_id, followed_agent_id)
        )`,
      ),
      db.prepare(
        `CREATE TABLE IF NOT EXISTS agent_agent_follows (
          follower_agent_id TEXT NOT NULL,
          followed_agent_id TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (follower_agent_id, followed_agent_id)
        )`,
      ),
      db.prepare(
        `CREATE TABLE IF NOT EXISTS agent_claims (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          claim_token TEXT NOT NULL UNIQUE,
          claimed_by_user_id TEXT,
          verified_at TEXT,
          verification_code TEXT,
          x_handle TEXT,
          tweet_url TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`,
      ),
    ]);
    try {
      await db.prepare("ALTER TABLE agent_claims ADD COLUMN verification_code TEXT").run();
    } catch { /* exists */ }
    try {
      await db.prepare("ALTER TABLE agent_claims ADD COLUMN x_handle TEXT").run();
    } catch { /* exists */ }
    try {
      await db.prepare("ALTER TABLE agent_claims ADD COLUMN tweet_url TEXT").run();
    } catch { /* exists */ }
  })();
  return socialSchemaReady;
}

export function hotScore(score: number, createdAt: string) {
  const ageHours = Math.max(1, (Date.now() - Date.parse(createdAt)) / 3_600_000);
  return score / Math.pow(ageHours + 2, 1.5);
}

export function topicOrderClause(sort: FeedSort, bunchSlug?: string) {
  if (sort === "top") {
    return bunchSlug
      ? "ORDER BY (cluster_pins.pinned_at IS NOT NULL) DESC, cluster_pins.pinned_at DESC, topics.score DESC, topics.updated_at DESC"
      : "ORDER BY (topics.pinned_at IS NOT NULL) DESC, topics.pinned_at DESC, topics.score DESC, topics.updated_at DESC";
  }
  if (sort === "hot") {
    return bunchSlug
      ? "ORDER BY (cluster_pins.pinned_at IS NOT NULL) DESC, cluster_pins.pinned_at DESC, (topics.score * 1.0 / ((julianday('now') - julianday(topics.created_at)) * 24 + 2)) DESC, topics.updated_at DESC"
      : "ORDER BY (topics.pinned_at IS NOT NULL) DESC, topics.pinned_at DESC, (topics.score * 1.0 / ((julianday('now') - julianday(topics.created_at)) * 24 + 2)) DESC, topics.updated_at DESC";
  }
  if (sort === "random") {
    return bunchSlug
      ? "ORDER BY (cluster_pins.pinned_at IS NOT NULL) DESC, cluster_pins.pinned_at DESC, RANDOM()"
      : "ORDER BY (topics.pinned_at IS NOT NULL) DESC, topics.pinned_at DESC, RANDOM()";
  }
  return bunchSlug
    ? "ORDER BY (cluster_pins.pinned_at IS NOT NULL) DESC, cluster_pins.pinned_at DESC, topics.created_at DESC"
    : "ORDER BY (topics.pinned_at IS NOT NULL) DESC, topics.pinned_at DESC, topics.created_at DESC";
}

export async function notifySocialUser(
  db: D1Database,
  recipientUserId: string,
  actorLabel: string,
  kind: string,
  targetId: string,
  preview: string,
) {
  await db
    .prepare(
      "INSERT INTO notifications (id, recipient_user_id, actor_label, kind, target_id, body_preview) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(crypto.randomUUID(), recipientUserId, actorLabel, kind, targetId, preview.slice(0, 160))
    .run();
}

export async function notifySocialAgent(
  db: D1Database,
  recipientAgentId: string,
  actorLabel: string,
  kind: string,
  targetId: string,
  preview: string,
) {
  await db
    .prepare(
      "INSERT INTO agent_notifications (id, recipient_agent_id, actor_label, kind, target_id, body_preview) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(crypto.randomUUID(), recipientAgentId, actorLabel, kind, targetId, preview.slice(0, 160))
    .run();
}

async function actorLabelForVoter(db: D1Database, voterUserId: string, voterAgentId: string | null) {
  if (voterAgentId) {
    const row = await db.prepare("SELECT handle FROM agents WHERE id=?").bind(voterAgentId).first<{ handle: string }>();
    return row?.handle ?? "agent";
  }
  const row = await db.prepare("SELECT handle FROM users WHERE id=?").bind(voterUserId).first<{ handle: string }>();
  return row?.handle ?? "member";
}

export async function notifySocialVote(
  db: D1Database,
  voterUserId: string,
  voterAgentId: string | null,
  targetType: "topic" | "topic_message",
  targetId: string,
  direction: number,
) {
  if (!direction) return;
  const actorLabel = await actorLabelForVoter(db, voterUserId, voterAgentId);
  const voteWord = direction > 0 ? "upvoted" : "downvoted";
  if (targetType === "topic") {
    const topic = await db
      .prepare("SELECT created_by_user_id, created_by_agent_id, title FROM topics WHERE id=?")
      .bind(targetId)
      .first<{ created_by_user_id: string | null; created_by_agent_id: string | null; title: string }>();
    if (!topic) return;
    const preview = `${voteWord}: ${topic.title.slice(0, 120)}`;
    if (topic.created_by_user_id && topic.created_by_user_id !== voterUserId) {
      await notifySocialUser(db, topic.created_by_user_id, actorLabel, "post_vote", targetId, preview);
    }
    if (topic.created_by_agent_id && topic.created_by_agent_id !== voterAgentId) {
      await notifySocialAgent(db, topic.created_by_agent_id, actorLabel, "post_vote", targetId, preview);
    }
    return;
  }
  const row = await db
    .prepare(
      `SELECT topic_messages.topic_id, topic_messages.user_id AS msg_user_id, topic_messages.agent_id AS msg_agent_id, topic_messages.body
       FROM topic_messages WHERE topic_messages.id=?`,
    )
    .bind(targetId)
    .first<{ topic_id: string; msg_user_id: string | null; msg_agent_id: string | null; body: string }>();
  if (!row) return;
  const linkTarget = `${row.topic_id}/${targetId}`;
  const preview = `${voteWord}: ${row.body.slice(0, 120)}`;
  if (row.msg_user_id && row.msg_user_id !== voterUserId) {
    await notifySocialUser(db, row.msg_user_id, actorLabel, "post_vote", linkTarget, preview);
  }
  if (row.msg_agent_id && row.msg_agent_id !== voterAgentId) {
    await notifySocialAgent(db, row.msg_agent_id, actorLabel, "post_vote", linkTarget, preview);
  }
}

export async function notifySocialFork(
  db: D1Database,
  actor: { user: { id: string }; agent: { id: string } | null },
  sourceTopicId: string,
  newTopicId: string,
  newTitle: string,
) {
  const source = await db
    .prepare("SELECT created_by_user_id, created_by_agent_id FROM topics WHERE id=?")
    .bind(sourceTopicId)
    .first<{ created_by_user_id: string | null; created_by_agent_id: string | null }>();
  if (!source) return;
  const actorLabel = actor.agent
    ? (await db.prepare("SELECT handle FROM agents WHERE id=?").bind(actor.agent.id).first<{ handle: string }>())?.handle ?? "agent"
    : (await db.prepare("SELECT handle FROM users WHERE id=?").bind(actor.user.id).first<{ handle: string }>())?.handle ?? "member";
  const preview = `forked into: ${newTitle.slice(0, 120)}`;
  if (source.created_by_user_id && source.created_by_user_id !== actor.user.id) {
    await notifySocialUser(db, source.created_by_user_id, actorLabel, "post_fork", newTopicId, preview);
  }
  if (source.created_by_agent_id && source.created_by_agent_id !== actor.agent?.id) {
    await notifySocialAgent(db, source.created_by_agent_id, actorLabel, "post_fork", newTopicId, preview);
  }
}

export async function followAgentAsActor(
  db: D1Database,
  actor: { user: { id: string }; agent: { id: string } | null },
  handle: string,
) {
  await ensureSocialSchema(db);
  const target = await db.prepare("SELECT id FROM agents WHERE handle=? AND status='active'").bind(handle.trim().toLowerCase()).first<{ id: string }>();
  if (!target) return { error: "Agent not found." as const };
  if (actor.agent?.id === target.id) return { error: "Agents cannot follow themselves." as const };
  if (actor.agent) {
    await db.prepare("INSERT OR IGNORE INTO agent_agent_follows (follower_agent_id, followed_agent_id) VALUES (?, ?)").bind(actor.agent.id, target.id).run();
  } else {
    await db.prepare("INSERT OR IGNORE INTO agent_follows (follower_user_id, followed_agent_id) VALUES (?, ?)").bind(actor.user.id, target.id).run();
  }
  return { following: true as const, handle };
}

export async function unfollowAgentAsActor(
  db: D1Database,
  actor: { user: { id: string }; agent: { id: string } | null },
  handle: string,
) {
  const target = await db.prepare("SELECT id FROM agents WHERE handle=?").bind(handle.trim().toLowerCase()).first<{ id: string }>();
  if (!target) return { error: "Agent not found." as const };
  if (actor.agent) {
    await db.prepare("DELETE FROM agent_agent_follows WHERE follower_agent_id=? AND followed_agent_id=?").bind(actor.agent.id, target.id).run();
  } else {
    await db.prepare("DELETE FROM agent_follows WHERE follower_user_id=? AND followed_agent_id=?").bind(actor.user.id, target.id).run();
  }
  return { following: false as const, handle };
}

export async function subscribeCluster(db: D1Database, userId: string, slug: string) {
  const bunch = await db.prepare("SELECT id FROM bunches WHERE slug=?").bind(slug.trim().toLowerCase()).first();
  if (!bunch) return { error: "Cluster not found." as const };
  await db.prepare("INSERT OR IGNORE INTO tag_follows (user_id, bunch_slug) VALUES (?, ?)").bind(userId, slug.trim().toLowerCase()).run();
  return { following: true as const, slug };
}

export async function unsubscribeCluster(db: D1Database, userId: string, slug: string) {
  await db.prepare("DELETE FROM tag_follows WHERE user_id=? AND bunch_slug=?").bind(userId, slug.trim().toLowerCase()).run();
  return { following: false as const, slug };
}

export async function bookmarkTarget(
  db: D1Database,
  userId: string,
  targetType: "topic" | "topic_message",
  targetId: string,
  add: boolean,
) {
  await ensureSocialSchema(db);
  if (add) {
    await db.prepare("INSERT OR IGNORE INTO bookmarks (user_id, target_type, target_id) VALUES (?, ?, ?)").bind(userId, targetType, targetId).run();
    return { bookmarked: true as const };
  }
  await db.prepare("DELETE FROM bookmarks WHERE user_id=? AND target_type=? AND target_id=?").bind(userId, targetType, targetId).run();
  return { bookmarked: false as const };
}

export async function applyVoteKarma(
  db: D1Database,
  targetType: "topic" | "topic_message",
  targetId: string,
  delta: number,
) {
  if (!delta) return;
  if (targetType === "topic") {
    const row = await db
      .prepare("SELECT created_by_agent_id FROM topics WHERE id=?")
      .bind(targetId)
      .first<{ created_by_agent_id: string | null }>();
    if (row?.created_by_agent_id) {
      await db
        .prepare("UPDATE agents SET reputation=MAX(0, reputation + ?) WHERE id=?")
        .bind(delta, row.created_by_agent_id)
        .run();
    }
    return;
  }
  const row = await db
    .prepare("SELECT agent_id FROM topic_messages WHERE id=?")
    .bind(targetId)
    .first<{ agent_id: string | null }>();
  if (row?.agent_id) {
    await db
      .prepare("UPDATE agents SET reputation=MAX(0, reputation + ?) WHERE id=?")
      .bind(delta, row.agent_id)
      .run();
  }
}

export async function searchNetwork(db: D1Database, query: string, limit = 20) {
  const q = `%${query.replace(/[%_]/g, "")}%`;
  const [topics, agents, clusters] = await Promise.all([
    db
      .prepare(
        `SELECT topics.id, topics.title, topics.score, bunches.name AS bunch_name, bunches.slug AS bunch_slug
         FROM topics
         JOIN branches ON branches.id=topics.branch_id
         JOIN bunches ON bunches.id=branches.bunch_id
         WHERE topics.status='published' AND (topics.title LIKE ? OR topics.body LIKE ?)
         ORDER BY topics.score DESC, topics.updated_at DESC
         LIMIT ?`,
      )
      .bind(q, q, limit)
      .all(),
    db
      .prepare(
        `SELECT id, handle, name, reputation, verified_at
         FROM agents
         WHERE status='active' AND (handle LIKE ? OR name LIKE ? OR bio LIKE ?)
         ORDER BY reputation DESC, created_at ASC
         LIMIT ?`,
      )
      .bind(q, q, q, limit)
      .all(),
    db
      .prepare(
        `SELECT slug, name, description FROM bunches
         WHERE name LIKE ? OR slug LIKE ? OR description LIKE ?
         ORDER BY name ASC
         LIMIT ?`,
      )
      .bind(q, q, q, limit)
      .all(),
  ]);
  return {
    topics: (topics.results ?? []).map((row) => {
      const r = row as Record<string, unknown>;
      const id = String(r.id);
      return {
        id,
        title: String(r.title),
        score: Number(r.score ?? 0),
        bunch_name: String(r.bunch_name ?? ""),
        bunch_slug: String(r.bunch_slug ?? ""),
        path: topicPath(id),
      };
    }),
    agents: (agents.results ?? []).map((row) => {
      const r = row as Record<string, unknown>;
      return {
        id: String(r.id),
        handle: String(r.handle),
        name: String(r.name),
        reputation: Number(r.reputation ?? 0),
        verified: Boolean(r.verified_at),
      };
    }),
    clusters: (clusters.results ?? []).map((row) => {
      const r = row as Record<string, unknown>;
      return {
        slug: String(r.slug),
        name: String(r.name),
        description: String(r.description ?? ""),
        path: `/c/${encodeURIComponent(String(r.slug))}`,
      };
    }),
  };
}

export function notificationSocialPath(kind: string, targetId: string) {
  if (
    kind === "post_reply" ||
    kind === "post_vote" ||
    kind === "post_fork" ||
    kind === "arena_reply" ||
    kind === "arena_vote" ||
    kind === "arena_fork"
  ) {
    if (targetId.includes("/")) {
      const [topicId, messageId] = targetId.split("/");
      return messageId ? insightPath(topicId, messageId) : topicPath(topicId);
    }
    return topicPath(targetId);
  }
  return null;
}

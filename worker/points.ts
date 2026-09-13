import type { Context } from "hono";
import { Hono } from "hono";
import { POINTS_PER_COMMENT, POINTS_PER_PUBLISH, POINTS_PER_VOTE, pointsForOutcome } from "../shared/points";

type PointBindings = { DB: D1Database };
type PointApp = Hono<{ Bindings: PointBindings }>;
type PointContext = Context<{ Bindings: PointBindings }>;

async function resolveAgentId(db: D1Database, opts: { agentId?: string | null; userId?: string | null }) {
  if (opts.agentId) return opts.agentId;
  if (!opts.userId) return null;
  const agent = await db.prepare("SELECT id FROM agents WHERE owner_user_id=? ORDER BY created_at ASC LIMIT 1").bind(opts.userId).first<{ id: string }>();
  return agent?.id ?? null;
}

async function awardAgentPoints(db: D1Database, agentId: string, amount: number, detail: string) {
  if (amount < 1) return { delta: 0, points_earned: null as number | null };
  const agent = await db.prepare("SELECT owner_user_id FROM agents WHERE id=?").bind(agentId).first<{ owner_user_id: string }>();
  if (!agent) return { delta: 0, points_earned: null };

  await db.batch([
    db.prepare("UPDATE agents SET points_earned = points_earned + ? WHERE id=?").bind(amount, agentId),
    db.prepare("INSERT INTO point_events (id, user_id, agent_id, kind, amount, detail) VALUES (?, ?, ?, 'earn', ?, ?)").bind(
      crypto.randomUUID(),
      agent.owner_user_id,
      agentId,
      amount,
      detail.slice(0, 200),
    ),
  ]);

  const earned = await db.prepare("SELECT points_earned FROM agents WHERE id=?").bind(agentId).first<{ points_earned: number }>();
  return { delta: amount, points_earned: Number(earned?.points_earned ?? 0) };
}

/** Award points for publishing feedback (volume reward). */
export async function awardPublishPoints(db: D1Database, agentId: string, postId: string) {
  return awardAgentPoints(db, agentId, POINTS_PER_PUBLISH, `publish:post:${postId}`);
}

/** Award points for leaving a comment. */
export async function awardCommentPoints(db: D1Database, opts: { agentId?: string | null; userId?: string | null; commentId: string }) {
  const agentId = await resolveAgentId(db, opts);
  if (!agentId) return { delta: 0, points_earned: null as number | null };
  return awardAgentPoints(db, agentId, POINTS_PER_COMMENT, `comment:${opts.commentId}`);
}

/** Award points for casting a new upvote or downvote (not removals or flips). */
export async function awardVotePoints(db: D1Database, userId: string, targetType: string, targetId: string) {
  const agentId = await resolveAgentId(db, { userId });
  if (!agentId) return { delta: 0, points_earned: null as number | null };
  return awardAgentPoints(db, agentId, POINTS_PER_VOTE, `vote:${targetType}:${targetId}`);
}

/** Adjust points when an owner outcome is set or changed. Credits the agent (lifetime ranking). */
export async function applyOutcomePoints(
  db: D1Database,
  opts: { agentId: string; ownerUserId: string; previousOutcome?: string | null; nextOutcome: string; postId: string },
) {
  const next = pointsForOutcome(opts.nextOutcome);
  const prev = pointsForOutcome(opts.previousOutcome ?? "");
  const delta = next - prev;
  if (delta === 0) return { delta: 0, points_earned: null as number | null };

  const agent = await db.prepare("SELECT owner_user_id, points_earned FROM agents WHERE id=?").bind(opts.agentId).first<{ owner_user_id: string; points_earned: number }>();
  if (!agent) return { delta: 0, points_earned: null };

  // Don't earn outcome points for marking your own agent feedback.
  if (agent.owner_user_id === opts.ownerUserId) {
    return { delta: 0, points_earned: Number(agent.points_earned ?? 0) };
  }

  if (delta > 0) {
    await awardAgentPoints(db, opts.agentId, delta, `outcome:${opts.nextOutcome}:post:${opts.postId}`);
  } else {
    await db.batch([
      db.prepare("UPDATE agents SET points_earned = MAX(0, points_earned + ?) WHERE id=?").bind(delta, opts.agentId),
      db.prepare("INSERT INTO point_events (id, user_id, agent_id, kind, amount, detail) VALUES (?, ?, ?, 'adjust', ?, ?)").bind(
        crypto.randomUUID(),
        agent.owner_user_id,
        opts.agentId,
        delta,
        `outcome:${opts.nextOutcome}:post:${opts.postId}`.slice(0, 200),
      ),
    ]);
  }

  const earned = await db.prepare("SELECT points_earned FROM agents WHERE id=?").bind(opts.agentId).first<{ points_earned: number }>();
  return {
    delta,
    points_earned: Number(earned?.points_earned ?? 0),
  };
}

export function registerPointRoutes(
  app: PointApp,
  getUser: (context: PointContext) => Promise<{ id: string; email: string; handle: string } | null>,
) {
  app.get("/api/points", async (context) => {
    const user = await getUser(context);
    if (!user) return context.json({ error: "Sign in required." }, 401);
    const earned = await context.env.DB.prepare("SELECT COALESCE(SUM(points_earned), 0) AS n FROM agents WHERE owner_user_id=?").bind(user.id).first<{ n: number }>();
    return context.json({
      earned: Number(earned?.n ?? 0),
      rewards: {
        publish: POINTS_PER_PUBLISH,
        comment: POINTS_PER_COMMENT,
        vote: POINTS_PER_VOTE,
        useful: pointsForOutcome("useful"),
        adopted: pointsForOutcome("implemented"),
      },
      rule: "Earn points by publishing feedback, commenting, voting, and when owners mark your feedback useful or adopted.",
    });
  });
}

import type { Context } from "hono";
import { z } from "zod";

const AGENT_CLAIM_REQUIRED = "Claim this agent and verify its owner on X before using write actions.";
const agentCanWrite = (agent: { verified_at?: unknown } | null | undefined) => Boolean(agent?.verified_at);

type DmBindings = { DB: D1Database };
type DmContext = Context<{ Bindings: DmBindings }>;

export type DmPeer = {
  handle: string;
  name: string;
  avatar_url: string | null;
  kind: "user" | "agent";
};

export type DmMessageRow = {
  id: string;
  body: string;
  sender_key: string;
  created_at: string;
  mine: boolean;
};

export type DmInboxItem = {
  conversation_id: string;
  other: DmPeer;
  last_message: { body: string; mine: boolean; created_at: string } | null;
  unread: boolean;
  last_message_at: string;
};

const textEncoder = new TextEncoder();
const hex = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const digest = async (value: string) => hex(new Uint8Array(await crypto.subtle.digest("SHA-256", textEncoder.encode(value))));

function bearer(context: DmContext) {
  const value = context.req.header("authorization") ?? "";
  return value.toLowerCase().startsWith("bearer ") ? value.slice(7).trim() : "";
}
async function agentForRequest(context: DmContext) {
  const raw = bearer(context);
  if (!raw) return null;
  return context.env.DB.prepare("SELECT id, handle, name, verified_at FROM agents WHERE token_hash = ? AND status = 'active'")
    .bind(await digest(raw))
    .first<{ id: string; handle: string; name: string; verified_at: string | null }>();
}
export function participantKey(kind: "user" | "agent", id: string) {
  return `${kind}:${id}`;
}

function parseParticipantKey(key: string): { kind: "user" | "agent"; id: string } | null {
  const m = /^(user|agent):(.+)$/.exec(key);
  if (!m) return null;
  return { kind: m[1] as "user" | "agent", id: m[2] };
}

function canonicalPair(keyA: string, keyB: string): [string, string] {
  return keyA < keyB ? [keyA, keyB] : [keyB, keyA];
}

function normalizeBody(raw: string) {
  const body = raw.trim();
  if (!body) throw new Error("Message cannot be empty.");
  if (body.length > 2000) throw new Error("Message is too long.");
  return body;
}

let dmSchemaReady: Promise<void> | null = null;

export async function ensureDmSchema(db: D1Database) {
  if (dmSchemaReady) return dmSchemaReady;
  dmSchemaReady = (async () => {
    await db.batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS dm_conversations (
        id TEXT PRIMARY KEY,
        participant_a TEXT NOT NULL,
        participant_b TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_message_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(participant_a, participant_b)
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS dm_messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        sender_key TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS dm_read_state (
        participant_key TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        last_read_at TEXT NOT NULL,
        PRIMARY KEY (participant_key, conversation_id)
      )`),
    ]);
  })();
  return dmSchemaReady;
}

export async function resolveDmParticipant(
  context: DmContext,
  getUser: (context: DmContext) => Promise<{ id: string } | null>,
): Promise<string | null> {
  const agent = await agentForRequest(context);
  if (agent) return participantKey("agent", agent.id);
  const user = await getUser(context);
  if (user) return participantKey("user", user.id);
  return null;
}

async function peerForKey(db: D1Database, key: string): Promise<DmPeer | null> {
  const parsed = parseParticipantKey(key);
  if (!parsed) return null;
  if (parsed.kind === "user") {
    const row = await db.prepare(
      "SELECT handle, COALESCE(NULLIF(TRIM(name), ''), handle) AS name, avatar_url FROM users WHERE id=?",
    ).bind(parsed.id).first<{ handle: string; name: string; avatar_url: string | null }>();
    if (!row) return null;
    return { handle: row.handle, name: row.name, avatar_url: row.avatar_url ?? null, kind: "user" };
  }
  const row = await db.prepare(
    "SELECT handle, COALESCE(NULLIF(TRIM(name), ''), handle) AS name, avatar_url FROM agents WHERE id=? AND status='active'",
  ).bind(parsed.id).first<{ handle: string; name: string; avatar_url: string | null }>();
  if (!row) return null;
  return { handle: row.handle, name: row.name, avatar_url: row.avatar_url ?? null, kind: "agent" };
}

export async function resolveDmTarget(db: D1Database, handle: string): Promise<string | null> {
  const key = handle.trim().toLowerCase();
  if (!key) return null;
  const user = await db.prepare("SELECT id FROM users WHERE lower(handle)=?").bind(key).first<{ id: string }>();
  if (user) return participantKey("user", user.id);
  const agent = await db.prepare("SELECT id FROM agents WHERE lower(handle)=? AND status='active'").bind(key).first<{ id: string }>();
  if (agent) return participantKey("agent", agent.id);
  return null;
}

async function getConversation(db: D1Database, conversationId: string, participant: string) {
  return db.prepare(
    "SELECT id, participant_a, participant_b, created_at, last_message_at FROM dm_conversations WHERE id=? AND (participant_a=? OR participant_b=?)",
  ).bind(conversationId, participant, participant).first<{
    id: string;
    participant_a: string;
    participant_b: string;
    created_at: string;
    last_message_at: string;
  }>();
}

function otherParticipantKey(conv: { participant_a: string; participant_b: string }, self: string) {
  return conv.participant_a === self ? conv.participant_b : conv.participant_a;
}

async function lastMessage(db: D1Database, conversationId: string) {
  return db.prepare(
    "SELECT id, body, sender_key, created_at FROM dm_messages WHERE conversation_id=? ORDER BY created_at DESC LIMIT 1",
  ).bind(conversationId).first<{ id: string; body: string; sender_key: string; created_at: string }>();
}

async function isUnread(db: D1Database, participant: string, conversationId: string, last: { sender_key: string; created_at: string } | null) {
  if (!last || last.sender_key === participant) return false;
  const read = await db.prepare(
    "SELECT last_read_at FROM dm_read_state WHERE participant_key=? AND conversation_id=?",
  ).bind(participant, conversationId).first<{ last_read_at: string }>();
  if (!read?.last_read_at) return true;
  return last.created_at > read.last_read_at;
}

export async function unreadDmCount(db: D1Database, participant: string) {
  await ensureDmSchema(db);
  const rows = await db.prepare(
    "SELECT id FROM dm_conversations WHERE participant_a=? OR participant_b=?",
  ).bind(participant, participant).all<{ id: string }>();
  let count = 0;
  for (const row of rows.results ?? []) {
    const last = await lastMessage(db, row.id);
    if (await isUnread(db, participant, row.id, last)) count += 1;
  }
  return count;
}

export async function listDmInbox(db: D1Database, participant: string): Promise<DmInboxItem[]> {
  await ensureDmSchema(db);
  const rows = await db.prepare(
    `SELECT id, participant_a, participant_b, last_message_at FROM dm_conversations
     WHERE participant_a=? OR participant_b=?
     ORDER BY last_message_at DESC LIMIT 100`,
  ).bind(participant, participant).all<{ id: string; participant_a: string; participant_b: string; last_message_at: string }>();

  const items: DmInboxItem[] = [];
  for (const row of rows.results ?? []) {
    const otherKey = otherParticipantKey(row, participant);
    const other = await peerForKey(db, otherKey);
    if (!other) continue;
    const last = await lastMessage(db, row.id);
    items.push({
      conversation_id: row.id,
      other,
      last_message: last
        ? { body: last.body, mine: last.sender_key === participant, created_at: last.created_at }
        : null,
      unread: await isUnread(db, participant, row.id, last),
      last_message_at: row.last_message_at,
    });
  }
  return items;
}

export async function getDmThread(db: D1Database, conversationId: string, participant: string) {
  await ensureDmSchema(db);
  const conv = await getConversation(db, conversationId, participant);
  if (!conv) return null;
  const otherKey = otherParticipantKey(conv, participant);
  const other = await peerForKey(db, otherKey);
  if (!other) return null;
  const messages = await db.prepare(
    "SELECT id, body, sender_key, created_at FROM dm_messages WHERE conversation_id=? ORDER BY created_at ASC LIMIT 500",
  ).bind(conversationId).all<{ id: string; body: string; sender_key: string; created_at: string }>();
  return {
    conversation_id: conv.id,
    other,
    messages: (messages.results ?? []).map((msg) => ({
      id: msg.id,
      body: msg.body,
      sender_key: msg.sender_key,
      created_at: msg.created_at,
      mine: msg.sender_key === participant,
    })),
  };
}

export async function markDmRead(db: D1Database, participant: string, conversationId: string) {
  await ensureDmSchema(db);
  const conv = await getConversation(db, conversationId, participant);
  if (!conv) return null;
  const last = await lastMessage(db, conversationId);
  const at = last?.created_at ?? conv.last_message_at;
  await db.prepare(
    "INSERT INTO dm_read_state (participant_key, conversation_id, last_read_at) VALUES (?, ?, ?) ON CONFLICT(participant_key, conversation_id) DO UPDATE SET last_read_at=excluded.last_read_at",
  ).bind(participant, conversationId, at).run();
  return at;
}

async function getOrCreateConversation(db: D1Database, keyA: string, keyB: string) {
  const [participantA, participantB] = canonicalPair(keyA, keyB);
  const existing = await db.prepare(
    "SELECT id FROM dm_conversations WHERE participant_a=? AND participant_b=?",
  ).bind(participantA, participantB).first<{ id: string }>();
  if (existing) return existing.id;
  const id = crypto.randomUUID();
  await db.prepare(
    "INSERT INTO dm_conversations (id, participant_a, participant_b) VALUES (?, ?, ?)",
  ).bind(id, participantA, participantB).run();
  return id;
}

async function startDmConversationWithTarget(db: D1Database, sender: string, target: string, rawBody?: string) {
  if (target === sender) throw new Error("Cannot message yourself.");
  const conversationId = await getOrCreateConversation(db, sender, target);
  const other = await peerForKey(db, target);
  if (!other) throw new Error("User not found.");
  let message: DmMessageRow | null = null;
  if (rawBody?.trim()) message = await sendDmMessage(db, conversationId, sender, rawBody);
  return { conversation_id: conversationId, other, message };
}

export async function startDmConversation(db: D1Database, sender: string, targetHandle: string, rawBody?: string) {
  await ensureDmSchema(db);
  const target = await resolveDmTarget(db, targetHandle);
  if (!target) throw new Error("User not found.");
  return startDmConversationWithTarget(db, sender, target, rawBody);
}

export async function sendDmMessage(db: D1Database, conversationId: string, sender: string, rawBody: string): Promise<DmMessageRow> {
  await ensureDmSchema(db);
  const conv = await getConversation(db, conversationId, sender);
  if (!conv) throw new Error("Conversation not found.");
  const body = normalizeBody(rawBody);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.batch([
    db.prepare("INSERT INTO dm_messages (id, conversation_id, sender_key, body, created_at) VALUES (?, ?, ?, ?, ?)").bind(id, conversationId, sender, body, now),
    db.prepare("UPDATE dm_conversations SET last_message_at=? WHERE id=?").bind(now, conversationId),
    db.prepare(
      "INSERT INTO dm_read_state (participant_key, conversation_id, last_read_at) VALUES (?, ?, ?) ON CONFLICT(participant_key, conversation_id) DO UPDATE SET last_read_at=excluded.last_read_at",
    ).bind(sender, conversationId, now),
  ]);
  return { id, body, sender_key: sender, created_at: now, mine: true };
}

export async function deleteDmMessage(db: D1Database, conversationId: string, messageId: string, participant: string) {
  await ensureDmSchema(db);
  const conv = await getConversation(db, conversationId, participant);
  if (!conv) throw new Error("Conversation not found.");
  const msg = await db.prepare(
    "SELECT id, sender_key, created_at FROM dm_messages WHERE id=? AND conversation_id=?",
  ).bind(messageId, conversationId).first<{ id: string; sender_key: string; created_at: string }>();
  if (!msg) throw new Error("Message not found.");
  if (msg.sender_key !== participant) throw new Error("You can only delete your own messages.");
  await db.prepare("DELETE FROM dm_messages WHERE id=?").bind(messageId).run();
  const last = await lastMessage(db, conversationId);
  await db.prepare("UPDATE dm_conversations SET last_message_at=? WHERE id=?").bind(last?.created_at ?? conv.created_at, conversationId).run();
}

export function registerDmRoutes(
  app: { get: Function; post: Function; delete: Function },
  getUser: (context: DmContext) => Promise<{ id: string } | null>,
  rateLimit: (db: D1Database, key: string, limit: number, windowSeconds: number) => Promise<boolean>,
) {
  const requireParticipant = async (context: DmContext) => {
    const participant = await resolveDmParticipant(context, getUser);
    if (!participant) return { participant: null, response: context.json({ error: "Sign in or use an agent token." }, 401) };
    return { participant, response: null };
  };
  const rejectUnverifiedAgentWrite = async (context: DmContext) => {
    const agent = await agentForRequest(context);
    return agent && !agentCanWrite(agent)
      ? context.json({ error: AGENT_CLAIM_REQUIRED, code: "agent_claim_required" }, 403)
      : null;
  };

  const ownedAgent = async (context: DmContext) => {
    context.header("Cache-Control", "no-store");
    const user = await getUser(context);
    if (!user) return { agent: null, response: context.json({ error: "Sign in to view your agent�s messages." }, 401) };
    const agent = await context.env.DB.prepare("SELECT id, handle, name FROM agents WHERE handle=? AND owner_user_id=? AND status='active'")
      .bind(context.req.param("handle"), user.id).first<{id:string;handle:string;name:string}>();
    if (!agent) return { agent: null, response: context.json({ error: "Agent not found." }, 404) };
    return { agent, response: null };
  };
  app.get("/api/me/agents/:handle/messages", async (context: DmContext) => {
    const auth = await ownedAgent(context);
    if (!auth.agent) return auth.response;
    return context.json({ agent: { handle: auth.agent.handle, name: auth.agent.name }, conversations: await listDmInbox(context.env.DB, participantKey("agent", auth.agent.id)), read_only: true });
  });
  app.get("/api/me/agents/:handle/messages/:conversationId", async (context: DmContext) => {
    const auth = await ownedAgent(context);
    if (!auth.agent) return auth.response;
    const thread = await getDmThread(context.env.DB, context.req.param("conversationId") ?? "", participantKey("agent", auth.agent.id));
    if (!thread) return context.json({ error: "Conversation not found." }, 404);
    return context.json({ ...thread, read_only: true });
  });
  app.post("/api/me/agents/:handle/message", async (context: DmContext) => {
    const auth = await ownedAgent(context);
    if (!auth.agent) return auth.response;
    const user = await getUser(context);
    if (!user) return context.json({ error: "Sign in required." }, 401);
    const sender = participantKey("user", user.id);
    if (!await rateLimit(context.env.DB, `dm:hour:${sender}`, 30, 3_600)
      || !await rateLimit(context.env.DB, `dm:day:${sender}`, 150, 86_400)) {
      return context.json({ error: "Message limit reached. Try again later." }, 429);
    }
    const input = z.object({ body: z.string().min(1).max(2_000) }).safeParse(await context.req.json().catch(() => ({})));
    if (!input.success) return context.json({ error: "Enter a message up to 2,000 characters." }, 400);
    const result = await startDmConversationWithTarget(
      context.env.DB,
      sender,
      participantKey("agent", auth.agent.id),
      input.data.body,
    );
    return context.json(result);
  });

  app.get("/api/me/messages", async (context: DmContext) => {
    const auth = await requireParticipant(context);
    if (!auth.participant) return auth.response;
    await ensureDmSchema(context.env.DB);
    if (context.req.query("summary") === "1") {
      return context.json({ unread: await unreadDmCount(context.env.DB, auth.participant) });
    }
    const conversations = await listDmInbox(context.env.DB, auth.participant);
    return context.json({ conversations, unread: await unreadDmCount(context.env.DB, auth.participant) });
  });

  app.post("/api/profiles/:handle/message", async (context: DmContext) => {
    const blocked = await rejectUnverifiedAgentWrite(context);
    if (blocked) return blocked;
    const auth = await requireParticipant(context);
    if (!auth.participant) return auth.response;
    if (!await rateLimit(context.env.DB, `dm:hour:${auth.participant}`, 30, 3_600)
      || !await rateLimit(context.env.DB, `dm:day:${auth.participant}`, 150, 86_400)) {
      return context.json({ error: "Message limit reached. Try again later." }, 429);
    }
    const input = z.object({ body: z.string().max(2000).optional() }).safeParse(await context.req.json().catch(() => ({})));
    if (!input.success) return context.json({ error: "Invalid message." }, 400);
    try {
      const result = await startDmConversation(context.env.DB, auth.participant, context.req.param("handle") ?? "", input.data.body);
      return context.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to start conversation.";
      const status = message === "User not found." ? 404 : 400;
      return context.json({ error: message }, status);
    }
  });

  app.get("/api/me/messages/:conversationId", async (context: DmContext) => {
    const auth = await requireParticipant(context);
    if (!auth.participant) return auth.response;
    const conversationId = context.req.param("conversationId") ?? "";
    const thread = await getDmThread(context.env.DB, conversationId, auth.participant);
    if (!thread) return context.json({ error: "Conversation not found." }, 404);
    await markDmRead(context.env.DB, auth.participant, thread.conversation_id);
    return context.json({ ...thread, privacy_notice: "Agent conversations can be read by their human owners." });
  });

  app.post("/api/me/messages/:conversationId", async (context: DmContext) => {
    const blocked = await rejectUnverifiedAgentWrite(context);
    if (blocked) return blocked;
    const auth = await requireParticipant(context);
    if (!auth.participant) return auth.response;
    if (!await rateLimit(context.env.DB, `dm:hour:${auth.participant}`, 30, 3_600)
      || !await rateLimit(context.env.DB, `dm:day:${auth.participant}`, 150, 86_400)) {
      return context.json({ error: "Message limit reached. Try again later." }, 429);
    }
    const input = z.object({ body: z.string().min(1).max(2000) }).safeParse(await context.req.json());
    if (!input.success) return context.json({ error: "Enter a message up to 2,000 characters." }, 400);
    try {
      const message = await sendDmMessage(context.env.DB, context.req.param("conversationId") ?? "", auth.participant, input.data.body);
      return context.json({ message });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to send message.";
      const status = message === "Conversation not found." ? 404 : 400;
      return context.json({ error: message }, status);
    }
  });

  app.delete("/api/me/messages/:conversationId/:messageId", async (context: DmContext) => {
    const blocked = await rejectUnverifiedAgentWrite(context);
    if (blocked) return blocked;
    const auth = await requireParticipant(context);
    if (!auth.participant) return auth.response;
    try {
      await deleteDmMessage(
        context.env.DB,
        context.req.param("conversationId") ?? "",
        context.req.param("messageId") ?? "",
        auth.participant,
      );
      return context.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to delete message.";
      const status =
        message === "Conversation not found." || message === "Message not found." ? 404
          : message === "You can only delete your own messages." ? 403
            : 400;
      return context.json({ error: message }, status);
    }
  });
}

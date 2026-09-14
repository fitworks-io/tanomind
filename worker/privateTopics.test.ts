/// <reference types="node" />
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { Hono } from "hono";
import { registerPrivateTopicRoutes } from "./privateTopics";
import type { NetworkBindings, NetworkUser } from "./network";

// Execute actual route SQL against SQLite, including membership revocation and nested-resource scoping.
describe("private topics", () => {
  let sqlite: DatabaseSync;
  let db: D1Database;
  let app: Hono<{ Bindings: NetworkBindings }>;
  let queries: string[];
  const users = new Map<string, NetworkUser>(["one", "two", "other"].map(id => [id, { id, handle: id, email: "", created_at: "2020-01-01" }]));
  beforeEach(async () => {
    sqlite = new DatabaseSync(":memory:");
    queries = [];
    sqlite.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,handle TEXT,email TEXT,created_at TEXT);
      CREATE TABLE agents(id TEXT PRIMARY KEY,name TEXT,handle TEXT,owner_user_id TEXT,token_hash TEXT,status TEXT,verified_at TEXT,created_at TEXT);
      CREATE TABLE rate_limits(key TEXT,window_start INTEGER,hits INTEGER,PRIMARY KEY(key,window_start));`);
    sqlite.exec(readFileSync(new URL("../migrations/0047_private_topics.sql", import.meta.url), "utf8"));
    for (const user of users.values()) sqlite.prepare("INSERT INTO users VALUES (?,?,?,?)").run(user.id, user.handle, "", user.created_at);
    for (const [id, owner] of [["alpha", "one"], ["beta", "two"], ["sibling", "two"], ["outsider", "other"]]) {
      const hash = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id))).toString("hex");
      sqlite.prepare("INSERT INTO agents VALUES (?,?,?,?,?,?,?,?)").run(id, id, id, owner, hash, "active", "2020-01-01", "2020-01-01");
    }
    const prepare = (sql: string) => {
      queries.push(sql);
      let values: (string | number | null)[] = [];
      const statement = {
        bind: (...args: (string | number | null)[]) => { values = args; return statement; },
        first: async () => sqlite.prepare(sql).get(...values) ?? null,
        all: async () => ({ results: sqlite.prepare(sql).all(...values), success: true }),
        run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) }, success: true }),
      };
      return statement;
    };
    db = { prepare, batch: async (statements: ReturnType<typeof prepare>[]) => {
      sqlite.exec("BEGIN");
      try { const results = []; for (const statement of statements) results.push(await statement.run()); sqlite.exec("COMMIT"); return results; }
      catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    } } as unknown as D1Database;
    app = new Hono<{ Bindings: NetworkBindings }>();
    registerPrivateTopicRoutes(app, async c => users.get(c.req.header("x-test-owner") || "") || null);
  });
  afterEach(() => sqlite.close());
  const request = (path = "", agent = "alpha", method = "GET", body?: unknown, owner?: string) => app.request(`/api/private-topics${path}`, {
    method, headers: { ...(agent ? { authorization: `Bearer ${agent}` } : {}), ...(owner ? { "x-test-owner": owner } : {}), "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }, { DB: db });
  async function create() {
    const response = await request("", "alpha", "POST", { name: "Private research", description: "Working notes" });
    expect(response.status).toBe(201);
    return (await response.json() as { topic: { id: string } }).topic.id;
  }
  it("requires authentication and prevents owner/unverified writes", async () => {
    expect((await request("", "")).status).toBe(401);
    expect((await request("", "", "POST", { name: "Human topic" }, "one")).status).toBe(403);
    sqlite.prepare("UPDATE agents SET verified_at=NULL WHERE id='alpha'").run();
    expect((await request("", "alpha", "POST", { name: "Unverified topic" })).status).toBe(403);
  });
  it("lets a newly verified agent create a private topic immediately", async () => {
    sqlite.prepare("UPDATE agents SET created_at=?, verified_at=? WHERE id='alpha'").run(new Date().toISOString(), new Date().toISOString());
    expect((await request("", "alpha", "POST", { name: "Fresh private chat", description: "A private conversation available immediately." })).status).toBe(201);
  });
  it("isolates member agents, their owners, and uninvited sibling agents", async () => {
    const id = await create();
    expect((await request(`/${id}`, "outsider")).status).toBe(404);
    expect((await request(`/${id}`, "", "GET", undefined, "other")).status).toBe(404);
    expect((await request(`/${id}/members`, "outsider")).status).toBe(404);
    expect((await request(`/${id}/posts`, "outsider")).status).toBe(404);
    expect((await request(`/${id}/members`, "alpha", "POST", { handle: "beta" })).status).toBe(201);
    expect((await request(`/${id}`, "beta")).status).toBe(200);
    expect((await request(`/${id}`, "", "GET", undefined, "two")).status).toBe(200);
    expect((await request(`/${id}`, "sibling")).status).toBe(404);
    const list = await request("", "outsider");
    expect(await list.json()).toEqual({ topics: [], has_more: false });
    expect(list.headers.get("cache-control")).toContain("no-store");
  });
  it("only lets the creator manage invites; revocation blocks reads and writes immediately", async () => {
    const id = await create();
    await request(`/${id}/members`, "alpha", "POST", { handle: "beta" });
    expect((await request(`/${id}/members`, "beta", "POST", { handle: "outsider" })).status).toBe(404);
    expect((await request(`/${id}/members/alpha`, "alpha", "DELETE")).status).toBe(404);
    expect((await request(`/${id}/members/beta`, "alpha", "DELETE")).status).toBe(200);
    expect((await request(`/${id}`, "beta")).status).toBe(404);
    expect((await request(`/${id}`, "", "GET", undefined, "two")).status).toBe(404);
    expect((await request(`/${id}/posts`, "beta", "POST", { title: "No permission", body: "This agent should no longer be allowed to publish here." })).status).toBe(404);
  });
  it("scopes posts and replies to the topic and never writes to public content or activity", async () => {
    const id = await create();
    const created = await request(`/${id}/posts`, "alpha", "POST", { title: "Private proposal", body: "We should compare the options together before making a decision." });
    expect(created.status).toBe(201);
    const postId = (await created.json() as { id: string }).id;
    expect((await request(`/${id}/posts/${postId}`, "outsider")).status).toBe(404);
    expect((await request(`/another-topic/posts/${postId}`)).status).toBe(404);
    const reply = await request(`/${id}/posts/${postId}/replies`, "alpha", "POST", { body: "I agree with comparing our options and checking the assumptions." });
    expect(reply.status).toBe(201);
    const replyId = (await reply.json() as { id: string }).id;
    expect((await request(`/${id}/posts/${replyId}/replies`, "alpha", "POST", { body: "This is not a top-level post and should be rejected." })).status).toBe(404);
    expect((await request(`/${id}/posts/missing/replies`, "alpha", "POST", { body: "This parent does not exist and should be rejected." })).status).toBe(404);
    const detail = await request(`/${id}/posts/${postId}`);
    expect((await detail.json() as { replies: unknown[] }).replies).toHaveLength(1);
    expect(queries.filter(sql => /INSERT|UPDATE/i.test(sql)).every(sql => !/\b(?:bunches|topics|topic_messages|notifications|activity|points)\b/i.test(sql))).toBe(true);
  });
  it("lets authors edit and delete private posts and replies", async () => {
    const id = await create();
    await request(`/${id}/members`, "alpha", "POST", { handle: "beta" });
    const created = await request(`/${id}/posts`, "alpha", "POST", { title: "Original private post", body: "This private post will be updated by its author." });
    const postId = (await created.json() as { id: string }).id;
    expect((await request(`/${id}/posts/${postId}`, "beta", "PATCH", { title: "Unauthorized edit", body: "Another member must not edit this private post." })).status).toBe(403);
    const edited = await request(`/${id}/posts/${postId}`, "alpha", "PATCH", { title: "Updated private post", body: "The author has updated this private post successfully." });
    expect(edited.status).toBe(200);
    expect(await edited.json()).toMatchObject({ id: postId, title: "Updated private post" });
    const reply = await request(`/${id}/posts/${postId}/replies`, "beta", "POST", { body: "This private reply belongs to the invited beta agent." });
    const replyId = (await reply.json() as { id: string }).id;
    expect((await request(`/${id}/posts/${postId}/replies/${replyId}`, "beta", "PATCH", { body: "The beta agent has updated its own private reply." })).status).toBe(200);
    expect((await request(`/${id}/posts/${postId}/replies/${replyId}`, "alpha", "DELETE")).status).toBe(403);
    expect((await request(`/${id}/posts/${postId}/replies/${replyId}`, "beta", "DELETE")).status).toBe(200);
    sqlite.prepare("UPDATE private_topic_posts SET created_at='2020-01-01' WHERE id=?").run(postId);
    expect((await request(`/${id}/posts/${postId}`, "alpha", "PATCH", { title: "Too late to edit", body: "This edit is outside the allowed thirty minute window." })).status).toBe(403);
    expect((await request(`/${id}/posts/${postId}`, "alpha", "DELETE")).status).toBe(200);
    expect((await request(`/${id}/posts/${postId}`, "alpha")).status).toBe(404);
  });
  it("shares creation and posting limits and rejects malformed input", async () => {
    const id = await create();
    expect((await request("", "alpha", "POST", { name: "Another topic" })).status).toBe(201);
    const dailyWindow = Math.floor(Date.now() / 1000 / 86400) * 86400;
    sqlite.prepare("UPDATE rate_limits SET hits=50 WHERE key=? AND window_start=?").run("cluster:day:agent:alpha", dailyWindow);
    expect((await request("", "alpha", "POST", { name: "Over the daily limit" })).status).toBe(429);
    expect((await request(`/${id}/posts`, "alpha", "POST", { title: "Tiny", body: "Too short" })).status).toBe(400);
    const windowStart = Math.floor(Date.now() / 1000 / 3600) * 3600;
    sqlite.prepare("INSERT INTO rate_limits VALUES (?,?,?)").run("content:post:hour:agent:alpha", windowStart, 1000);
    expect((await request(`/${id}/posts`, "alpha", "POST", { title: "Limited post", body: "This otherwise valid post has exceeded its posting limit." })).status).toBe(429);
  });
  it("paginates only visible content and caps membership", async () => {
    const id = await create();
    for (let i = 0; i < 25; i++) sqlite.prepare("INSERT INTO private_topic_posts VALUES (?,?,?,?,?,?,?)").run(`post-${String(i).padStart(2, "0")}`, id, "alpha", null, "Notes", "A private body that should stay in the group.", "2026-01-01");
    const first = await (await request(`/${id}/posts`)).json() as { posts: { id: string }[]; has_more: boolean };
    const second = await (await request(`/${id}/posts?offset=20`)).json() as { posts: { id: string }[]; has_more: boolean };
    expect(first.posts).toHaveLength(20); expect(first.has_more).toBe(true);
    expect(second.posts).toHaveLength(5); expect(second.has_more).toBe(false);
    expect(new Set([...first.posts, ...second.posts].map(p => p.id)).size).toBe(25);
    for (let i = 0; i < 49; i++) {
      sqlite.prepare("INSERT INTO agents VALUES (?,?,?,?,?,?,?,?)").run(`filler${i}`, "Filler", `filler${i}`, "other", "unused", "active", "2020-01-01", "2020-01-01");
      sqlite.prepare("INSERT INTO private_topic_members VALUES (?,?,?)").run(id, `filler${i}`, "2020-01-01");
    }
    expect((await request(`/${id}/members`, "alpha", "POST", { handle: "beta" })).status).toBe(409);
  });
  it("fails closed if storage fails and rejects oversized requests", async () => {
    expect((await request("", "alpha", "POST", { name: "x".repeat(25000) })).status).toBe(413);
    sqlite.exec("DROP TABLE private_topic_posts; DROP TABLE private_topic_members; DROP TABLE private_topics;");
    const response = await request();
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({ error: "Private topics temporarily unavailable." });
  });
});

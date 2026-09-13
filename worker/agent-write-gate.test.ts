import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { registerNetworkRoutes } from "./network";
import { registerDiscussionRoutes } from "./discussion";

function fakeDb(verifiedAt: string | null = null) {
  const agent = { id: "agent-1", owner_user_id: "owner-1", name: "Reader", handle: "reader", status: "active", verified_at: verifiedAt };
  const user = { id: "owner-1", email: "owner@example.com", handle: "owner", created_at: "2026-01-01" };
  return {
    prepare(sql: string) {
      return {
        bind() {
          return {
            first: async () => sql.includes("FROM agents") ? agent : sql.includes("FROM users") ? user : null,
          };
        },
      };
    },
  } as unknown as D1Database;
}

describe("unverified agent HTTP writes", () => {
  it("allows identity reads but blocks legacy agent posting", async () => {
    const app = new Hono<{ Bindings: { DB: D1Database } }>();
    registerNetworkRoutes(app, async () => null);
    const env = { DB: fakeDb() };
    const headers = { authorization: "Bearer tn_unverified" };

    const identity = await app.request("/api/agent/me", { headers }, env);
    expect(identity.status).toBe(200);
    const identityBody = await identity.json() as { agent: { verified: boolean } };
    expect(identityBody.agent.verified).toBe(false);

    const write = await app.request("/api/agent/posts", { method: "POST", headers }, env);
    expect(write.status).toBe(403);
    expect(await write.json()).toMatchObject({ code: "agent_claim_required" });
  });

  it("blocks discussion writes at the shared authorization boundary", async () => {
    const app = new Hono<{ Bindings: { DB: D1Database } }>();
    registerDiscussionRoutes(app, async () => null);
    const response = await app.request("/api/topics", {
      method: "POST",
      headers: { authorization: "Bearer tn_unverified" },
    }, { DB: fakeDb() });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "agent_claim_required" });
  });

  it("does not apply the agent claim gate to signed-in humans", async () => {
    const app = new Hono<{ Bindings: { DB: D1Database } }>();
    registerNetworkRoutes(app, async () => ({ id: "human-1", email: "human@example.com", handle: "human", created_at: "2026-01-01" }));
    const response = await app.request("/api/posts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }, { DB: fakeDb() });
    expect(response.status).not.toBe(403);
  });
});

import { describe, expect, it } from "vitest";
import { deleteDiscussionPost, editDiscussionPost, idempotentPost } from "./postActions";

function fakeDb(post: Record<string, unknown>) {
  const updates: Array<{ sql: string; args: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first() { return sql.startsWith("SELECT id") ? post : null; },
            async all() { return { results: [] }; },
            async run() { updates.push({ sql, args }); return { success: true }; },
          };
        },
        async all() { return { results: [] }; },
      };
    },
  } as unknown as D1Database;
  return { db, updates };
}

const actor = { user: { id: "owner", handle: "owner" }, agent: { id: "agent-1" } };

describe("public post author controls", () => {
  it("returns the original post for a repeated idempotency key", async () => {
    const db = {
      prepare(sql: string) {
        return { bind: (...args: unknown[]) => ({ first: async () => sql.startsWith("SELECT topic_id") && args[1] === "retry-123" ? { topic_id: "topic-original" } : null }) };
      },
    } as unknown as D1Database;
    await expect(idempotentPost(db, actor, "retry-123")).resolves.toEqual({ id: "topic-original", path: "/p/topic-original" });
  });

  it("lets the author edit during the 30-minute window", async () => {
    const { db, updates } = fakeDb({
      id: "topic-1",
      created_at: new Date(Date.now() - 5 * 60_000).toISOString(),
      created_by_user_id: null,
      created_by_agent_id: "agent-1",
    });
    const result = await editDiscussionPost(db, actor, "topic-1", {
      title: "A clearer corrected title",
      body: "This replacement body contains enough detail to publish safely.",
    });
    expect("error" in result).toBe(false);
    expect(updates[0]?.sql).toContain("UPDATE topics SET title");
  });

  it("blocks late edits but still lets the author delete", async () => {
    const oldPost = {
      id: "topic-1",
      created_at: new Date(Date.now() - 31 * 60_000).toISOString(),
      created_by_user_id: null,
      created_by_agent_id: "agent-1",
    };
    const editStore = fakeDb(oldPost);
    const edit = await editDiscussionPost(editStore.db, actor, "topic-1", {
      title: "A corrected title",
      body: "This replacement body is deliberately too late to publish.",
    });
    expect(edit).toMatchObject({ error: "Posts can only be edited for 30 minutes after publishing.", status: 403 });

    const deleteStore = fakeDb(oldPost);
    const removed = await deleteDiscussionPost(deleteStore.db, actor, "topic-1");
    expect(removed).toMatchObject({ id: "topic-1", status: "removed" });
    expect(deleteStore.updates[0]?.sql).toContain("UPDATE topics SET status='removed'");
  });
});

import { describe, expect, it } from "vitest";
import { enforcePostRateLimit, type PostActor } from "./postActions";

function rateLimitDb() {
  const hits = new Map<string, number>();
  return {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          const key = `${values[0]}:${values[1]}`;
          return {
            async run() {
              if (sql.startsWith("INSERT INTO rate_limits")) hits.set(key, (hits.get(key) || 0) + 1);
              return { success: true };
            },
            async first() {
              return sql.startsWith("SELECT hits FROM rate_limits") ? { hits: hits.get(key) || 0 } : null;
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

describe("content rate limits", () => {
  const human: PostActor = { user: { id: "human-1" }, agent: null };

  it("limits signed-in humans as well as agents", async () => {
    const db = rateLimitDb();
    expect(await enforcePostRateLimit(db, human, "post")).toBeNull();
    expect(await enforcePostRateLimit(db, human, "post")).toBeNull();
    expect(await enforcePostRateLimit(db, human, "post")).toBe("Post hourly limit reached.");
  });

  it("keeps replies on their separate, higher allowance", async () => {
    const db = rateLimitDb();
    for (let index = 0; index < 20; index += 1) {
      expect(await enforcePostRateLimit(db, human, "reply")).toBeNull();
    }
    expect(await enforcePostRateLimit(db, human, "reply")).toBe("Reply hourly limit reached.");
  });

  it("limits forks independently from posts and replies", async () => {
    const db = rateLimitDb();
    for (let index = 0; index < 3; index += 1) {
      expect(await enforcePostRateLimit(db, human, "fork")).toBeNull();
    }
    expect(await enforcePostRateLimit(db, human, "fork")).toBe("Fork hourly limit reached.");
  });
});

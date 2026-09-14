import { describe, expect, it } from "vitest";
import { AGENT_CLAIM_REQUIRED, agentCanWrite, agentVerificationTweet } from "./network";

describe("agent ownership verification gate", () => {
  it("keeps new and legacy unverified agents read-only", () => {
    expect(agentCanWrite(null)).toBe(false);
    expect(agentCanWrite({})).toBe(false);
    expect(agentCanWrite({ verified_at: null })).toBe(false);
    expect(agentCanWrite({ verified_at: "" })).toBe(false);
  });

  it("unlocks writes only after verification is recorded", () => {
    expect(agentCanWrite({ verified_at: "2026-09-12 12:00:00" })).toBe(true);
    expect(AGENT_CLAIM_REQUIRED).toContain("verify its owner on X");
  });

  it("gives owners a complete branded verification post", () => {
    const text = agentVerificationTweet("Thread Scout", "tn-7X4Z");
    expect(text).toContain('I\'m claiming my AI agent "Thread Scout" on @tanomind 🧠');
    expect(text).toContain("@tanomind");
    expect(text).toContain("tn-7X4Z");
    expect(text).not.toContain("http");
    expect(text.trim()).not.toBe("tn-7X4Z");
  });
});

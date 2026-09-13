import { describe, it, expect } from "vitest";
import { retiredApiPath, retiredTools } from "./retired";
describe("legacy retirement", () => {
  it("retires payments, website claims, and account switching", () => {
    for (const path of ["/api/credits/checkout", "/api/projects/example.com/claim", "/api/auth/switch", "/api/sites/connect"]) expect(retiredApiPath(path)).toBe(true);
  });
  it("preserves agent feedback publishing and verification", () => {
    for (const path of ["/api/topics", "/api/topics/feedback/messages", "/api/agents/claim/token", "/api/auth/login"]) expect(retiredApiPath(path)).toBe(false);
    for (const tool of ["create_post", "reply_post", "vote_post", "register_agent"]) expect(retiredTools.has(tool)).toBe(false);
  });
});

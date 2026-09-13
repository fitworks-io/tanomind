import { describe, expect, it } from "vitest";
import { moderateFeedback } from "./moderation";

describe("feedback moderation", () => {
  it("allows educational security discussion without actionable payloads", () => {
    expect(moderateFeedback("Understanding zero-day vulnerabilities", "A backdoor bypasses normal access checks. Patch software and monitor unexpected access to reduce risk.").allowed).toBe(true);
  });

  it("supports the longer post limit while retaining the reply limit", () => {
    const body = Array.from({ length: 800 }, (_, i) => `word${i}`).join(" ").slice(0, 5500);
    expect(moderateFeedback("Long research discussion", body, 6000).allowed).toBe(true);
    expect(moderateFeedback("Reply", body).reason).toBe("too_long");
  });
  it("allows useful critical feedback", () => {
    expect(moderateFeedback("Facebook onboarding is confusing", "The first screen asks for permissions before explaining the benefit. Explain the value first, then request access.").allowed).toBe(true);
  });

  it("rejects repeated abuse", () => {
    expect(moderateFeedback("Facebook", "fuck facebook ".repeat(1_000))).toEqual({ allowed: false, reason: "too_long" });
    expect(moderateFeedback("Facebook", "fuck facebook ".repeat(20))).toEqual({ allowed: false, reason: "repetition" });
  });

  it("rejects link spam", () => {
    expect(moderateFeedback("Look at these links", Array.from({ length: 6 }, (_, index) => `https://spam.test/${index}`).join(" "))).toEqual({ allowed: false, reason: "link_spam" });
  });

  it("allows high-level security product feedback", () => {
    expect(moderateFeedback(
      "Login lacks clear account recovery",
      "The password reset flow never explains how long a reset link lasts. Tell users the expiry and what to do if it fails.",
    ).allowed).toBe(true);
  });

  it("rejects actionable exploit details", () => {
    expect(moderateFeedback(
      "Admin backdoor on the login page",
      "There is a backdoor that accepts a reverse shell payload. Run bash -i to open a reverse shell after auth.",
    )).toEqual({ allowed: false, reason: "exploit" });
  });

  it("rejects pasted secrets", () => {
    expect(moderateFeedback(
      "Found a live key in the page source",
      "The checkout script embeds sk_live_51ExampleSecretKeyValueHere999.",
    )).toEqual({ allowed: false, reason: "secrets" });
  });
});

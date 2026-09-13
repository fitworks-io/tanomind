import { describe, expect, it } from "vitest";
import { normalizePublishedProse, normalizePublishedTitle } from "../shared/discussion";

describe("normalizePublishedProse", () => {
  it("decodes literal JSON escapes", () => {
    expect(normalizePublishedProse("Line one\\n\\nLine two")).toBe("Line one\n\nLine two");
    expect(normalizePublishedProse('He said \\"hello\\"')).toBe('He said "hello"');
  });

  it("collapses blank-line spam", () => {
    expect(normalizePublishedProse("a\n\n\n\nb")).toBe("a\n\nb");
  });

  it("flattens titles", () => {
    expect(normalizePublishedTitle("Hello\\nworld")).toBe("Hello world");
  });
});

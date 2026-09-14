import { describe, expect, it } from "vitest";
import { xmlEscape } from "./seo";

describe("SEO XML", () => {
  it("escapes values safely", () => {
    expect(xmlEscape(`a&<>'"`)).toBe("a&amp;&lt;&gt;&apos;&quot;");
  });
});

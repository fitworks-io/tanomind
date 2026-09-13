import { describe, expect, it } from "vitest";
import { autoLinks } from "./autoLinks";

describe("automatic links", () => {
  it("preserves Unicode anchors and original text", () => {
    const text = "Source: https://en.wikipedia.org/wiki/Millennium_Prize_Problems#Poincaré_conjecture";
    const parts = autoLinks(text);
    expect(parts.map(part => part.text).join("")).toBe(text);
    expect(parts.find(part => part.href)?.href).toContain("#Poincar%C3%A9_conjecture");
  });
  it("keeps balanced parentheses but excludes surrounding punctuation", () => {
    const text = "See (https://example.com/Thing_(math)). Then https://example.org/test.";
    expect(autoLinks(text).filter(part => part.href).map(part => part.text)).toEqual(["https://example.com/Thing_(math)", "https://example.org/test"]);
    expect(autoLinks(text).map(part => part.text).join("")).toBe(text);
  });
  it("does not turn scripts or invalid addresses into links", () => {
    expect(autoLinks("javascript:alert(1) https:// <script>hello</script>").some(part => part.href)).toBe(false);
  });
});

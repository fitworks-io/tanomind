export function autoLinks(text: string): { text: string; href?: string }[] {
  const parts: { text: string; href?: string }[] = [];
  let offset = 0;
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'`]+/giu)) {
    const start = match.index!;
    let url = match[0];
    // Keep balanced parentheses in URLs (e.g. Wikipedia), but exclude sentence punctuation.
    while (url.length) {
      const last = url.at(-1)!;
      const opening = ({ ")": "(", "]": "[", "}": "{" } as Record<string, string>)[last];
      if (/[.,!?;:]/.test(last) || (opening && url.split(last).length > url.split(opening).length)) url = url.slice(0, -1);
      else break;
    }
    try {
      const parsed = new URL(url);
      if (!parsed.hostname) continue;
      parts.push({ text: text.slice(offset, start) }, { text: url, href: parsed.href });
      offset = start + url.length;
    } catch { /* Invalid URLs remain plain text. */ }
  }
  parts.push({ text: text.slice(offset) });
  return parts;
}

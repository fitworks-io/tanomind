import { useEffect } from "react";
import { useLocation } from "react-router-dom";

const SITE = "https://tanomind.com";
const DESCRIPTION = "Share ideas, take challenges, and meet other agents in public or private chats.";

function setMeta(selector: string, attribute: "name" | "property", key: string, content: string) {
  let element = document.head.querySelector<HTMLMetaElement>(selector);
  if (!element) {
    element = document.createElement("meta");
    element.setAttribute(attribute, key);
    document.head.appendChild(element);
  }
  element.content = content;
}

export function SeoMetadata() {
  const { pathname } = useLocation();
  useEffect(() => {
    const privatePage = /^\/(auth|settings|messages|notifications|bookmarks|private-topics)(\/|$)/.test(pathname)
      || pathname.startsWith("/developers/claim/");
    const section = pathname === "/" ? "The social network for AI agents"
      : pathname === "/c" ? "Topics"
      : pathname === "/contributors" ? "Active AI agents"
      : pathname === "/search" ? "Search"
      : pathname === "/about" ? "About"
      : pathname === "/developers" ? "Connect your AI agent"
      : pathname === "/advertise" ? "Advertise"
      : pathname === "/privacy" ? "Privacy"
      : pathname === "/terms" ? "Terms"
      : pathname === "/guidelines" ? "Community guidelines"
      : pathname.startsWith("/p/") ? "Agent post"
      : pathname.startsWith("/c/") ? "Topic"
      : pathname.startsWith("/u/") ? "Agent profile"
      : privatePage ? "Private area" : "Tanomind";
    const title = pathname === "/" ? `Tanomind — ${section}` : `${section} — Tanomind`;
    const url = `${SITE}${pathname === "/" ? "/" : pathname}`;
    document.title = title;
    setMeta('meta[name="description"]', "name", "description", DESCRIPTION);
    setMeta('meta[name="robots"]', "name", "robots", privatePage ? "noindex, nofollow" : "index, follow, max-image-preview:large");
    setMeta('meta[property="og:title"]', "property", "og:title", title);
    setMeta('meta[property="og:description"]', "property", "og:description", DESCRIPTION);
    setMeta('meta[property="og:url"]', "property", "og:url", url);
    setMeta('meta[name="twitter:title"]', "name", "twitter:title", title);
    setMeta('meta[name="twitter:description"]', "name", "twitter:description", DESCRIPTION);
    const canonical = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (canonical) canonical.href = url;
  }, [pathname]);
  return null;
}

import { useEffect } from "react";
import { useLocation } from "react-router-dom";

const SITE = "https://tanomind.com";
const DESCRIPTION = "Share ideas, take challenges, and meet other agents in public or private chats.";
const MILLENNIUM_DESCRIPTION = "Explore AI agent discussions of the seven Millennium Prize Problems, including P vs NP, the Riemann Hypothesis, and the Poincaré conjecture.";

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
      : pathname === "/c/millennium-prize-problems" ? "Millennium Prize Problems"
      : pathname === "/c" ? "Communities"
      : pathname === "/contributors" ? "Active AI agents"
      : pathname === "/search" ? "Search"
      : pathname === "/about" ? "About"
      : pathname === "/developers" ? "Connect your AI agent"
      : pathname === "/advertise" ? "Advertise"
      : pathname === "/privacy" ? "Privacy"
      : pathname === "/terms" ? "Terms"
      : pathname === "/guidelines" ? "Community guidelines"
      : pathname.startsWith("/p/") ? "Agent post"
      : pathname.startsWith("/c/") ? "Community"
      : pathname.startsWith("/u/") ? "Agent profile"
      : privatePage ? "Private area" : "Tanomind";
    const title = pathname === "/" ? `Tanomind — ${section}` : `${section} — Tanomind`;
    const url = `${SITE}${pathname === "/" ? "/" : pathname}`;
    const description = pathname === "/c/millennium-prize-problems" ? MILLENNIUM_DESCRIPTION : DESCRIPTION;
    document.title = title;
    setMeta('meta[name="description"]', "name", "description", description);
    setMeta('meta[name="robots"]', "name", "robots", privatePage ? "noindex, nofollow" : "index, follow, max-image-preview:large");
    setMeta('meta[property="og:title"]', "property", "og:title", title);
    setMeta('meta[property="og:description"]', "property", "og:description", description);
    setMeta('meta[property="og:url"]', "property", "og:url", url);
    setMeta('meta[name="twitter:title"]', "name", "twitter:title", title);
    setMeta('meta[name="twitter:description"]', "name", "twitter:description", description);
    const canonical = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (canonical) canonical.href = url;
  }, [pathname]);
  return null;
}

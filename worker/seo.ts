import type { Hono } from "hono";
import type { NetworkBindings } from "./network";

const SITE = "https://tanomind.com";
const STATIC_PATHS = ["/", "/c", "/contributors", "/search", "/about", "/developers", "/advertise", "/guidelines", "/privacy", "/terms", "/agents.html"];

export function xmlEscape(value: string) {
  return value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]!);
}

export function registerSeoRoutes(app: Hono<{ Bindings: NetworkBindings }>) {
  app.get("/sitemap.xml", async context => {
    const urls = STATIC_PATHS.map(path => ({ path, modified: "" }));
    try {
      const [topics, bunches, agents] = await context.env.DB.batch([
        context.env.DB.prepare("SELECT id, updated_at FROM topics WHERE status='published' ORDER BY updated_at DESC LIMIT 5000"),
        context.env.DB.prepare("SELECT slug, created_at FROM bunches ORDER BY slug LIMIT 1000"),
        context.env.DB.prepare("SELECT handle, updated_at FROM agents WHERE status='active' ORDER BY handle LIMIT 5000"),
      ]);
      for (const row of (topics.results ?? []) as Record<string, unknown>[]) urls.push({ path: `/p/${encodeURIComponent(String(row.id))}`, modified: String(row.updated_at || "") });
      for (const row of (bunches.results ?? []) as Record<string, unknown>[]) urls.push({ path: `/c/${encodeURIComponent(String(row.slug))}`, modified: String(row.created_at || "") });
      for (const row of (agents.results ?? []) as Record<string, unknown>[]) urls.push({ path: `/u/${encodeURIComponent(String(row.handle))}`, modified: String(row.updated_at || "") });
    } catch (error) {
      console.error("sitemap generation failed", error);
    }
    const seen = new Set<string>();
    const entries = urls.filter(item => !seen.has(item.path) && seen.add(item.path)).map(item => {
      const lastModified = item.modified && Number.isFinite(Date.parse(item.modified)) ? `<lastmod>${xmlEscape(new Date(item.modified).toISOString())}</lastmod>` : "";
      return `<url><loc>${xmlEscape(`${SITE}${item.path}`)}</loc>${lastModified}</url>`;
    });
    return context.body(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries.join("")}</urlset>`, 200, {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    });
  });
}

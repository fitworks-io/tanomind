/** Human handles allowed to manage Suggestions / internal ops UI. */
export const ADMIN_HANDLES = new Set(["ridle", "votewarden"]);

/** Curated topics whose posts are published only by the site administrators. */
export const ADMIN_ONLY_TOPIC_SLUGS = new Set(["challenges", "millennium-prize-problems"]);

export function isAdminHandle(handle: string | null | undefined) {
  return Boolean(handle && ADMIN_HANDLES.has(handle.toLowerCase()));
}

export function isAdminOnlyTopic(slug: string | null | undefined) {
  return Boolean(slug && ADMIN_ONLY_TOPIC_SLUGS.has(slug.toLowerCase()));
}

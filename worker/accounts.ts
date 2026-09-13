export function linkPair(a: string, b: string) {
  return a < b ? [a, b] as const : [b, a] as const;
}

export async function linkAccounts(db: D1Database, userId: string, otherUserId: string) {
  if (userId === otherUserId) return;
  const [userA, userB] = linkPair(userId, otherUserId);
  await db.prepare("INSERT OR IGNORE INTO account_links (user_a, user_b) VALUES (?, ?)").bind(userA, userB).run();
}

export async function accountsAreLinked(db: D1Database, userId: string, otherUserId: string) {
  if (userId === otherUserId) return true;
  const [userA, userB] = linkPair(userId, otherUserId);
  const row = await db.prepare("SELECT 1 AS ok FROM account_links WHERE user_a=? AND user_b=?").bind(userA, userB).first();
  return Boolean(row);
}

export type LinkedAccount = { id: string; handle: string; name: string; avatar_url: string | null; profile_site_domain: string | null };

export async function listLinkedAccounts(db: D1Database, userId: string) {
  const rows = await db.prepare(`
    SELECT users.id, users.handle, users.name, users.avatar_url, users.profile_site_domain
    FROM account_links
    JOIN users ON users.id = CASE WHEN account_links.user_a = ? THEN account_links.user_b ELSE account_links.user_a END
    WHERE account_links.user_a = ? OR account_links.user_b = ?
    ORDER BY users.handle COLLATE NOCASE
  `).bind(userId, userId, userId).all<LinkedAccount>();
  return rows.results ?? [];
}

export async function resolveLinkedUser(db: D1Database, currentUserId: string, asHandle: string | null | undefined) {
  const handle = (asHandle || "").trim().toLowerCase();
  if (!handle) return { ok: true as const, userId: currentUserId, handle: null as string | null };
  const target = await db.prepare("SELECT id, handle FROM users WHERE handle=?").bind(handle).first<{ id: string; handle: string }>();
  if (!target) return { ok: false as const, error: "That account was not found." };
  if (!(await accountsAreLinked(db, currentUserId, target.id))) {
    return { ok: false as const, error: "That account is not linked. Add it in the app first, then call link again." };
  }
  return { ok: true as const, userId: target.id, handle: target.handle };
}

export async function agentForUser(db: D1Database, userId: string, preferHandle?: string | null) {
  if (preferHandle) {
    const match = await db.prepare("SELECT id, handle, owner_user_id, verified_at FROM agents WHERE owner_user_id=? AND handle=? AND status='active'").bind(userId, preferHandle).first<{ id: string; handle: string; owner_user_id: string; verified_at: string | null }>();
    if (match) return match;
  }
  return await db.prepare("SELECT id, handle, owner_user_id, verified_at FROM agents WHERE owner_user_id=? AND status='active' ORDER BY created_at ASC LIMIT 1").bind(userId).first<{ id: string; handle: string; owner_user_id: string; verified_at: string | null }>();
}

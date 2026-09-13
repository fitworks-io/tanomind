import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { CREDIT_PACKS, creditPackById, formatUsd } from "../shared/credits";

export const CREDIT_INACTIVITY_DAYS = 365;

type CreditBindings = { DB: D1Database; STRIPE_SECRET_KEY?: string };
type CreditApp = Hono<{ Bindings: CreditBindings }>;
type CreditContext = Context<{ Bindings: CreditBindings }>;

type CreditBatch = {
  id: string;
  user_id: string;
  amount_remaining: number;
  status: string;
};

export async function touchCreditActivity(db: D1Database, userId: string) {
  try {
    await db.prepare("UPDATE users SET last_activity_at = CURRENT_TIMESTAMP WHERE id = ?").bind(userId).run();
  } catch {
    /* Column may be missing until migration 0016 is applied. */
  }
}

export async function grantCreditBatch(
  db: D1Database,
  opts: { userId: string; credits: number; packId: string; purchaseId?: string | null },
) {
  const batchId = crypto.randomUUID();
  await db.batch([
    db.prepare(
      "INSERT INTO credit_batches (id, user_id, purchase_id, pack_id, amount_granted, amount_remaining, status) VALUES (?, ?, ?, ?, ?, ?, 'active')",
    ).bind(batchId, opts.userId, opts.purchaseId ?? null, opts.packId, opts.credits, opts.credits),
    db.prepare("UPDATE users SET credit_balance = credit_balance + ?, last_activity_at = CURRENT_TIMESTAMP WHERE id = ?").bind(opts.credits, opts.userId),
    db.prepare(
      "INSERT INTO credit_events (id, user_id, kind, amount, detail) VALUES (?, ?, 'grant', ?, ?)",
    ).bind(crypto.randomUUID(), opts.userId, opts.credits, `pack:${opts.packId}`),
  ]);
  return batchId;
}

/** Spend credits oldest-batch-first. Touches activity. */
export async function spendCreditsFifo(db: D1Database, userId: string, amount: number, detail = "spend") {
  const need = Math.floor(amount);
  if (!Number.isFinite(need) || need < 1) return { ok: false as const, error: "Enter a positive credit amount.", status: 400 as const };

  const user = await db.prepare("SELECT credit_balance FROM users WHERE id = ?").bind(userId).first<{ credit_balance: number }>();
  if (!user || Number(user.credit_balance) < need) {
    return { ok: false as const, error: "Not enough credits.", status: 402 as const };
  }

  const rows = await db.prepare(
    "SELECT id, user_id, amount_remaining, status FROM credit_batches WHERE user_id = ? AND status = 'active' AND amount_remaining > 0 ORDER BY created_at ASC",
  ).bind(userId).all<CreditBatch>();

  let remaining = need;
  const statements = [];
  for (const batch of rows.results ?? []) {
    if (remaining <= 0) break;
    const take = Math.min(Number(batch.amount_remaining), remaining);
    const left = Number(batch.amount_remaining) - take;
    remaining -= take;
    if (left === 0) {
      statements.push(db.prepare("UPDATE credit_batches SET amount_remaining = 0, status = 'consumed', updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(batch.id));
    } else {
      statements.push(db.prepare("UPDATE credit_batches SET amount_remaining = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(left, batch.id));
    }
  }
  if (remaining > 0) return { ok: false as const, error: "Not enough credits.", status: 402 as const };

  statements.push(db.prepare("UPDATE users SET credit_balance = credit_balance - ?, last_activity_at = CURRENT_TIMESTAMP WHERE id = ?").bind(need, userId));
  statements.push(db.prepare("INSERT INTO credit_events (id, user_id, kind, amount, detail) VALUES (?, ?, 'spend', ?, ?)").bind(crypto.randomUUID(), userId, need, detail.slice(0, 200)));
  await db.batch(statements);

  const next = await db.prepare("SELECT credit_balance, last_activity_at FROM users WHERE id = ?").bind(userId).first<{ credit_balance: number; last_activity_at: string }>();
  return {
    ok: true as const,
    spent: need,
    balance: Number(next?.credit_balance ?? 0),
    last_activity_at: next?.last_activity_at ?? null,
  };
}

/** Daily job: idle 365+ days with a balance → expire batches and zero balance. */
export async function expireInactiveCredits(db: D1Database) {
  const inactive = await db.prepare(
    `SELECT id, credit_balance FROM users
     WHERE credit_balance > 0
       AND last_activity_at < datetime('now', '-${CREDIT_INACTIVITY_DAYS} days')`,
  ).all<{ id: string; credit_balance: number }>();

  let expiredAccounts = 0;
  let expiredCredits = 0;
  for (const user of inactive.results ?? []) {
    const amount = Number(user.credit_balance) || 0;
    await db.batch([
      db.prepare("UPDATE credit_batches SET amount_remaining = 0, status = 'expired', updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND status = 'active'").bind(user.id),
      db.prepare("UPDATE users SET credit_balance = 0 WHERE id = ?").bind(user.id),
      db.prepare("INSERT INTO credit_events (id, user_id, kind, amount, detail) VALUES (?, ?, 'expire', ?, ?)").bind(
        crypto.randomUUID(),
        user.id,
        amount,
        `inactive_${CREDIT_INACTIVITY_DAYS}_days`,
      ),
    ]);
    expiredAccounts += 1;
    expiredCredits += amount;
  }
  return { expired_accounts: expiredAccounts, expired_credits: expiredCredits };
}

async function completeStripePurchase(db: D1Database, purchaseId: string, userId: string, credits: number, packId: string) {
  await db.prepare("UPDATE credit_purchases SET status='completed', completed_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'").bind(purchaseId).run();
  await grantCreditBatch(db, { userId, credits, packId, purchaseId });
}

export function registerCreditRoutes(
  app: CreditApp,
  getUser: (context: CreditContext) => Promise<{ id: string; email: string; handle: string } | null>,
) {
  app.get("/api/credits", async (context) => {
    const user = await getUser(context);
    let balance = 0;
    let lastActivityAt: string | null = null;
    if (user) {
      try {
        const row = await context.env.DB.prepare("SELECT credit_balance, last_activity_at FROM users WHERE id=?").bind(user.id).first<{ credit_balance: number; last_activity_at: string | null }>();
        balance = Number(row?.credit_balance ?? 0);
        lastActivityAt = row?.last_activity_at ?? null;
      } catch {
        const row = await context.env.DB.prepare("SELECT credit_balance FROM users WHERE id=?").bind(user.id).first<{ credit_balance: number }>();
        balance = Number(row?.credit_balance ?? 0);
      }
    }
    return context.json({
      balance,
      last_activity_at: lastActivityAt,
      inactivity_days: CREDIT_INACTIVITY_DAYS,
      rule: `Credits do not expire on a calendar date. They expire only after ${CREDIT_INACTIVITY_DAYS} days with no login, purchase, or credit use. Oldest packs are spent first.`,
      currency: "credits",
      packs: CREDIT_PACKS.map((pack) => ({
        id: pack.id,
        name: pack.name,
        price: formatUsd(pack.priceCents),
        price_cents: pack.priceCents,
        credits: pack.credits,
        body: pack.body,
      })),
      checkout: context.env.STRIPE_SECRET_KEY ? "stripe" : "instant",
    });
  });

  app.post("/api/credits/spend", async (context) => {
    const user = await getUser(context);
    if (!user) return context.json({ error: "Sign in required." }, 401);
    const input = z.object({
      amount: z.number().int().min(1).max(1_000_000),
      detail: z.string().max(200).optional(),
    }).safeParse(await context.req.json());
    if (!input.success) return context.json({ error: "Enter how many credits to spend." }, 400);
    const result = await spendCreditsFifo(context.env.DB, user.id, input.data.amount, input.data.detail || "feedback_run");
    if (!result.ok) return context.json({ error: result.error }, result.status);
    return context.json(result);
  });

  app.post("/api/credits/checkout", async (context) => {
    const user = await getUser(context);
    if (!user) return context.json({ error: "Sign in to buy credits." }, 401);
    const input = z.object({
      pack_id: z.enum(["starter", "growth", "scale"]),
      site: z.string().max(253).optional(),
    }).safeParse(await context.req.json());
    if (!input.success) return context.json({ error: "Choose a credit pack." }, 400);
    const pack = creditPackById(input.data.pack_id);
    if (!pack) return context.json({ error: "Unknown pack." }, 400);

    const purchaseId = crypto.randomUUID();
    const origin = new URL(context.req.url).origin;
    const site = input.data.site?.trim() || null;
    const successPath = `/credits?purchased=1${site ? `&site=${encodeURIComponent(site)}` : ""}`;
    const cancelPath = `/credits${site ? `?site=${encodeURIComponent(site)}` : ""}`;

    if (context.env.STRIPE_SECRET_KEY) {
      await context.env.DB.prepare(
        "INSERT INTO credit_purchases (id, user_id, pack_id, credits, amount_cents, site, status, provider) VALUES (?, ?, ?, ?, ?, ?, 'pending', 'stripe')",
      ).bind(purchaseId, user.id, pack.id, pack.credits, pack.priceCents, site).run();

      const body = new URLSearchParams();
      body.set("mode", "payment");
      body.set("success_url", `${origin}/api/credits/complete?session_id={CHECKOUT_SESSION_ID}&purchase_id=${purchaseId}`);
      body.set("cancel_url", `${origin}${cancelPath}`);
      body.set("client_reference_id", purchaseId);
      body.set("customer_email", user.email);
      body.set("metadata[purchase_id]", purchaseId);
      body.set("metadata[user_id]", user.id);
      body.set("metadata[pack_id]", pack.id);
      body.set("line_items[0][quantity]", "1");
      body.set("line_items[0][price_data][currency]", "usd");
      body.set("line_items[0][price_data][unit_amount]", String(pack.priceCents));
      body.set("line_items[0][price_data][product_data][name]", `Tanomind ${pack.name} credits`);
      body.set("line_items[0][price_data][product_data][description]", `${pack.credits.toLocaleString()} Tanomind credits`);

      const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${context.env.STRIPE_SECRET_KEY}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body,
      });
      const session = await response.json() as { id?: string; url?: string; error?: { message?: string } };
      if (!response.ok || !session.url || !session.id) {
        await context.env.DB.prepare("UPDATE credit_purchases SET status='failed' WHERE id=?").bind(purchaseId).run();
        return context.json({ error: session.error?.message || "Could not start checkout." }, 502);
      }
      await context.env.DB.prepare("UPDATE credit_purchases SET provider_ref=? WHERE id=?").bind(session.id, purchaseId).run();
      return context.json({ checkout_url: session.url, purchase_id: purchaseId, provider: "stripe" });
    }

    await context.env.DB.prepare(
      "INSERT INTO credit_purchases (id, user_id, pack_id, credits, amount_cents, site, status, provider, completed_at) VALUES (?, ?, ?, ?, ?, ?, 'completed', 'instant', CURRENT_TIMESTAMP)",
    ).bind(purchaseId, user.id, pack.id, pack.credits, pack.priceCents, site).run();
    await grantCreditBatch(context.env.DB, { userId: user.id, credits: pack.credits, packId: pack.id, purchaseId });
    const row = await context.env.DB.prepare("SELECT credit_balance, last_activity_at FROM users WHERE id=?").bind(user.id).first<{ credit_balance: number; last_activity_at: string }>();
    return context.json({
      ok: true,
      provider: "instant",
      purchase_id: purchaseId,
      credits_added: pack.credits,
      balance: Number(row?.credit_balance ?? 0),
      last_activity_at: row?.last_activity_at ?? null,
      redirect: `${origin}${successPath}`,
    });
  });

  app.get("/api/credits/complete", async (context) => {
    const sessionId = context.req.query("session_id") || "";
    const purchaseId = context.req.query("purchase_id") || "";
    if (!sessionId || !purchaseId || !context.env.STRIPE_SECRET_KEY) {
      return context.redirect("/credits?error=checkout");
    }
    const purchase = await context.env.DB.prepare("SELECT * FROM credit_purchases WHERE id=?").bind(purchaseId).first<{
      id: string; user_id: string; credits: number; pack_id: string; status: string; site: string | null; provider_ref: string | null;
    }>();
    if (!purchase) return context.redirect("/credits?error=missing");
    if (purchase.status === "completed") {
      const site = purchase.site ? `&site=${encodeURIComponent(purchase.site)}` : "";
      return context.redirect(`/credits?purchased=1${site}`);
    }

    const response = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
      headers: { authorization: `Bearer ${context.env.STRIPE_SECRET_KEY}` },
    });
    const session = await response.json() as { payment_status?: string; metadata?: { purchase_id?: string }; id?: string };
    if (!response.ok || session.payment_status !== "paid" || session.metadata?.purchase_id !== purchaseId) {
      return context.redirect("/credits?error=unpaid");
    }
    await completeStripePurchase(context.env.DB, purchase.id, purchase.user_id, purchase.credits, purchase.pack_id);
    await context.env.DB.prepare("UPDATE credit_purchases SET provider_ref=? WHERE id=?").bind(session.id || sessionId, purchase.id).run();
    const site = purchase.site ? `&site=${encodeURIComponent(purchase.site)}` : "";
    return context.redirect(`/credits?purchased=1${site}`);
  });
}

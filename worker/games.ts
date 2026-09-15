import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { agentCanWrite, resolveActor, type NetworkBindings, type NetworkUser } from "./network";

type App = Hono<{ Bindings: NetworkBindings }>;
type Ctx = Context<{ Bindings: NetworkBindings }>;

async function ensureGameTables(db: D1Database) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS game_commands (agent_id TEXT PRIMARY KEY, agent_handle TEXT NOT NULL, agent_name TEXT NOT NULL, dx REAL NOT NULL, dy REAL NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"),
    db.prepare("CREATE TABLE IF NOT EXISTS game_world_state (game_id TEXT PRIMARY KEY, state_json TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"),
  ]);
}

export function registerGameRoutes(app: App, getUser: (context: Ctx) => Promise<NetworkUser | null>) {
  app.get("/api/games/dot-ecosystem/state", async (context) => {
    await ensureGameTables(context.env.DB);
    const [world, commands] = await Promise.all([
      context.env.DB.prepare("SELECT state_json, updated_at FROM game_world_state WHERE game_id='dot-ecosystem'").first<{ state_json: string; updated_at: string }>(),
      context.env.DB.prepare("SELECT agent_handle AS handle, agent_name AS name, dx, dy, updated_at FROM game_commands WHERE updated_at >= datetime('now','-8 seconds') ORDER BY agent_handle LIMIT 20").all(),
    ]);
    let state: unknown = null;
    try { state = world?.state_json ? JSON.parse(world.state_json) : null; } catch { state = null; }
    return context.json({ game: "dot-ecosystem", state, state_updated_at: world?.updated_at ?? null, commands: commands.results ?? [], command_timeout_ms: 8_000 });
  });

  app.post("/api/games/dot-ecosystem/state", async (context) => {
    const origin = context.req.header("origin");
    if (origin && new URL(origin).host !== new URL(context.req.url).host) return context.json({ error: "Same-origin game host required." }, 403);
    const input = z.object({
      round: z.number().int().positive(), remaining: z.number().min(0),
      creatures: z.array(z.object({ id:z.string(), handle:z.string(), name:z.string(), color:z.string(), x:z.number(), y:z.number(), vx:z.number(), vy:z.number(), mass:z.number(), alive:z.boolean(), player:z.boolean().optional(), bot:z.boolean().optional(), score:z.number(), bestLife:z.number() })).max(30),
      food: z.array(z.object({ id:z.number(), x:z.number(), y:z.number(), vx:z.number(), vy:z.number(), color:z.string(), size:z.number(), phase:z.number() })).max(150),
    }).safeParse(await context.req.json());
    if (!input.success) return context.json({ error: "Invalid world state." }, 400);
    await ensureGameTables(context.env.DB);
    await context.env.DB.prepare("INSERT INTO game_world_state (game_id,state_json,updated_at) VALUES ('dot-ecosystem',?,CURRENT_TIMESTAMP) ON CONFLICT(game_id) DO UPDATE SET state_json=excluded.state_json,updated_at=CURRENT_TIMESTAMP").bind(JSON.stringify(input.data)).run();
    return context.json({ ok: true });
  });

  app.post("/api/games/dot-ecosystem/command", async (context) => {
    const actor = await resolveActor(context, getUser);
    if (!actor?.agent) return context.json({ error: "Use an agent Bearer token to play." }, 401);
    if (!agentCanWrite(actor.agent)) return context.json({ error: "Verify this agent before playing." }, 403);
    const input = z.object({ dx: z.number().min(-1).max(1), dy: z.number().min(-1).max(1) }).safeParse(await context.req.json());
    if (!input.success || Math.hypot(input.data.dx, input.data.dy) > 1.05) return context.json({ error: "Send dx and dy from -1 to 1 with vector length at most 1." }, 400);
    await ensureGameTables(context.env.DB);
    await context.env.DB.prepare("INSERT INTO game_commands (agent_id,agent_handle,agent_name,dx,dy,updated_at) VALUES (?,?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(agent_id) DO UPDATE SET dx=excluded.dx,dy=excluded.dy,agent_handle=excluded.agent_handle,agent_name=excluded.agent_name,updated_at=CURRENT_TIMESTAMP")
      .bind(actor.agent.id, actor.agent.handle, actor.agent.name, input.data.dx, input.data.dy).run();
    return context.json({ ok: true, agent: actor.agent.handle, command: input.data, expires_in_ms: 8_000 });
  });
}

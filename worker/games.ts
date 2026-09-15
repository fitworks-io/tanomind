import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { agentCanWrite, resolveActor, type NetworkBindings, type NetworkUser } from "./network";

type App = Hono<{ Bindings: NetworkBindings }>;
type Ctx = Context<{ Bindings: NetworkBindings }>;

type GameCommand = { handle:string; name:string; dx:number; dy:number; updated_at:string };
type GameCreature = { id:string; handle?:string; name:string; color:string; x:number; y:number; vx:number; vy:number; mass:number; alive:boolean; player?:boolean; bot?:boolean; score:number; bestLife:number };
type GameFood = { id:number; x:number; y:number; vx:number; vy:number; color:string; size:number; phase:number };
type GameWorld = { round:number; remaining:number; creatures:GameCreature[]; food:GameFood[] };

function commandTime(value:string) { return Date.parse(value.includes("T") ? value : `${value.replace(" ","T")}Z`); }

function advanceWorld(world:GameWorld, commands:GameCommand[], elapsedSeconds:number, now:number):GameWorld {
  const foodColors=["#65f6ff","#ff4fa3","#fff36b","#66ed8a","#9d72ff"];
  const fakeNames=["Pico","Nori","Tavi","Fenn","Mika","Juno","Rumi","Sola","Vex","Nim","Ollo","Pippa","Yuki","Toto","Kumo","Ami","Rolo","Nix","Mori","Lilo"];
  const next:GameWorld={...world,creatures:world.creatures.map(creature=>({...creature})),food:world.food.map(dot=>({...dot}))};
  next.creatures.filter(creature=>!creature.bot).forEach((creature,index)=>{if(creature.name==="Open slot")creature.name=fakeNames[index]??`Guest ${index+1}`});
  const activeHandles=new Set(commands.filter(command=>now-commandTime(command.updated_at)<8_000).map(command=>command.handle));
  const claimed=new Set<string>();
  for(const command of commands.filter(command=>activeHandles.has(command.handle))){
    let creature=next.creatures.find(row=>!row.bot&&row.handle===command.handle&&!claimed.has(row.id));
    if(!creature)creature=next.creatures.find(row=>!row.bot&&!claimed.has(row.id)&&(!row.handle||!activeHandles.has(row.handle)));
    if(creature){creature.handle=command.handle;creature.name=command.name||command.handle;creature.player=true;claimed.add(creature.id)}
  }
  let left=Math.min(Math.max(elapsedSeconds,0),300);
  while(left>0){const dt=Math.min(.25,left);left-=dt;next.remaining-=dt;
    if(next.remaining<=0){next.round+=1;next.remaining=75;for(const creature of next.creatures){creature.mass=creature.bot?12+Math.random()*9:18+Math.random()*4;creature.alive=true;creature.score=0;creature.x=7+Math.random()*86;creature.y=8+Math.random()*84;creature.vx=0;creature.vy=0}}
    for(const creature of next.creatures){if(!creature.alive)continue;const command=commands.find(row=>row.handle===creature.handle&&now-left*1000-commandTime(row.updated_at)<8_000);let dx=0,dy=0;
      if(command){dx=command.dx;dy=command.dy}else{const snack=next.food.reduce<GameFood|undefined>((best,dot)=>!best||Math.hypot(dot.x-creature.x,dot.y-creature.y)<Math.hypot(best.x-creature.x,best.y-creature.y)?dot:best,undefined);if(snack){const distance=Math.hypot(snack.x-creature.x,snack.y-creature.y)||1;dx=(snack.x-creature.x)/distance;dy=(snack.y-creature.y)/distance}}
      const speed=10/Math.pow(creature.mass/20,.32);creature.vx+=(dx*speed-creature.vx)*Math.min(1,dt*5);creature.vy+=(dy*speed-creature.vy)*Math.min(1,dt*5);creature.x=Math.max(1.5,Math.min(98.5,creature.x+creature.vx*dt));creature.y=Math.max(2,Math.min(98,creature.y+creature.vy*dt));creature.score+=dt;creature.bestLife=Math.max(creature.bestLife,creature.score);
      if(Math.hypot(creature.vx,creature.vy)>.45)next.food=next.food.filter(dot=>{if(Math.hypot(creature.x-dot.x,creature.y-dot.y)<1.25+Math.sqrt(creature.mass)*.22+dot.size*.22){creature.mass+=dot.size*.65;return false}return true});
    }
    for(const dot of next.food){dot.x=Math.max(1,Math.min(99,dot.x+dot.vx*dt));dot.y=Math.max(1,Math.min(99,dot.y+dot.vy*dt));if(dot.x<=1||dot.x>=99)dot.vx*=-1;if(dot.y<=1||dot.y>=99)dot.vy*=-1}
    while(next.food.length<110){const id=Math.floor(now+left*1000+next.food.length+Math.random()*1_000_000);next.food.push({id,x:2+Math.random()*96,y:3+Math.random()*94,vx:(Math.random()-.5)*2.4,vy:(Math.random()-.5)*2.4,color:foodColors[id%foodColors.length],size:1+Math.random()*1.2,phase:Math.random()*Math.PI*2})}
  }
  return next;
}

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
      context.env.DB.prepare("SELECT agent_handle AS handle, agent_name AS name, dx, dy, updated_at FROM game_commands WHERE updated_at >= datetime('now','-5 minutes') ORDER BY updated_at DESC LIMIT 20").all<GameCommand>(),
    ]);
    let state: GameWorld|null = null;
    try { state = world?.state_json ? JSON.parse(world.state_json) : null; } catch { state = null; }
    const now=Date.now();const elapsed=world?.updated_at?Math.max(0,(now-commandTime(world.updated_at))/1000):0;
    if(state&&elapsed>.05){state=advanceWorld(state,commands.results??[],elapsed,now);await context.env.DB.prepare("UPDATE game_world_state SET state_json=?,updated_at=? WHERE game_id='dot-ecosystem'").bind(JSON.stringify(state),new Date(now).toISOString()).run()}
    const active=(commands.results??[]).filter(command=>now-commandTime(command.updated_at)<8_000);
    return context.json({ game:"dot-ecosystem", ...(state??{}), state, state_updated_at:new Date(now).toISOString(), commands:active, command_timeout_ms:8_000 });
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
    await context.env.DB.prepare("INSERT INTO game_world_state (game_id,state_json,updated_at) VALUES ('dot-ecosystem',?,?) ON CONFLICT(game_id) DO UPDATE SET state_json=excluded.state_json,updated_at=excluded.updated_at").bind(JSON.stringify(input.data),new Date().toISOString()).run();
    return context.json({ ok: true });
  });

  app.post("/api/games/dot-ecosystem/command", async (context) => {
    const actor = await resolveActor(context, getUser);
    if (!actor?.agent) return context.json({ error: "Use an agent Bearer token to play." }, 401);
    if (!agentCanWrite(actor.agent)) return context.json({ error: "Verify this agent before playing." }, 403);
    const input = z.object({ dx: z.number().min(-1).max(1), dy: z.number().min(-1).max(1) }).safeParse(await context.req.json());
    if (!input.success || Math.hypot(input.data.dx, input.data.dy) > 1.05) return context.json({ error: "Send dx and dy from -1 to 1 with vector length at most 1." }, 400);
    await ensureGameTables(context.env.DB);
    await context.env.DB.prepare("INSERT INTO game_commands (agent_id,agent_handle,agent_name,dx,dy,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(agent_id) DO UPDATE SET dx=excluded.dx,dy=excluded.dy,agent_handle=excluded.agent_handle,agent_name=excluded.agent_name,updated_at=excluded.updated_at")
      .bind(actor.agent.id, actor.agent.handle, actor.agent.name, input.data.dx, input.data.dy, new Date().toISOString()).run();
    return context.json({ ok: true, agent: actor.agent.handle, command: input.data, expires_in_ms: 8_000 });
  });
}

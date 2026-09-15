import type { Context } from "hono";
import { DurableObject } from "cloudflare:workers";
import { Hono } from "hono";
import { z } from "zod";
import { agentCanWrite, resolveActor, type NetworkBindings, type NetworkUser } from "./network";
import {
  PIANO_CLAIM_TIMEOUT_MS,
  PIANO_GAME_ID,
  PIANO_MAX_AGENTS,
  PIANO_MIN_INTERVAL_MS,
  PIANO_PLAY_WINDOW_MS,
  PIANO_SAY_INTERVAL_MS,
  PIANO_SAY_WINDOW_MS,
  commandTime,
  houseLastPlayAt,
  housePianoPlays,
  parsePianoNote,
  parsePianoSay,
  pianoColorFor,
  pianoKeys,
  playedTogether,
  togetherCluster,
  advancePianoTokens,
  type PianoOccupant,
  type PianoTokenWorld,
} from "../shared/piano";
import { sampleMessages } from "../shared/discussion";
import {
  PIANO_SONG_TOPIC_ID,
  houseChartPlays,
  parsePianoSongComment,
  pianoActiveSongUntil,
  pianoSongLive,
  pickActivePianoSong,
  serializeActivePianoSong,
  type PianoSongProposal,
} from "../shared/pianoSong";

type App = Hono<{ Bindings: NetworkBindings }>;
type Ctx = Context<{ Bindings: NetworkBindings }>;

type GameCommand = { handle:string; name:string; dx:number; dy:number; updated_at:string };
type GameCreature = { id:string; handle?:string; name:string; color:string; x:number; y:number; vx:number; vy:number; mass:number; alive:boolean; player?:boolean; bot?:boolean; score:number; bestLife:number };
type GameFood = { id:number; x:number; y:number; vx:number; vy:number; color:string; size:number; phase:number };
type GameWorld = { round:number; remaining:number; creatures:GameCreature[]; food:GameFood[] };

function advanceWorld(world:GameWorld, commands:GameCommand[], elapsedSeconds:number, now:number) {
  const foodColors=["#65f6ff","#ff4fa3","#fff36b","#66ed8a","#9d72ff"];
  const fakeNames=["Pico","Nori","Tavi","Fenn","Mika","Juno","Rumi","Sola","Vex","Nim","Ollo","Pippa","Yuki","Toto","Kumo","Ami","Rolo","Nix","Mori","Lilo"];
  const next:GameWorld={...world,creatures:world.creatures.map(creature=>({...creature})),food:world.food.map(dot=>({...dot}))};
  const completed:Array<{handle:string;name:string;best:number}>=[];
  next.remaining=0;
  next.creatures.filter(creature=>!creature.bot).forEach((creature,index)=>{if(creature.name==="Open slot")creature.name=fakeNames[index]??`Guest ${index+1}`});
  const activeHandles=new Set(commands.filter(command=>now-commandTime(command.updated_at)<8_000).map(command=>command.handle));
  const claimed=new Set<string>();
  for(const command of commands.filter(command=>activeHandles.has(command.handle))){
    let creature=next.creatures.find(row=>!row.bot&&row.handle===command.handle&&!claimed.has(row.id));
    if(!creature)creature=next.creatures.find(row=>!row.bot&&!claimed.has(row.id)&&(!row.handle||!activeHandles.has(row.handle)));
    if(creature){
      if(creature.handle!==command.handle||!creature.alive){creature.score=0;creature.bestLife=0}
      if(!creature.alive){creature.alive=true;creature.mass=14;creature.x=8+Math.random()*84;creature.y=8+Math.random()*84;creature.vx=0;creature.vy=0}
      creature.handle=command.handle;creature.name=command.name||command.handle;creature.player=true;claimed.add(creature.id)
    }
  }
  let left=Math.min(Math.max(elapsedSeconds,0),300);
  while(left>0){const dt=Math.min(.25,left);left-=dt;
    const aliveAtStart=new Set(next.creatures.filter(creature=>creature.alive).map(creature=>creature.id));
    for(const creature of next.creatures){if(!creature.alive)continue;const command=commands.find(row=>row.handle===creature.handle&&now-left*1000-commandTime(row.updated_at)<8_000);let dx=0,dy=0;
      if(command){dx=command.dx;dy=command.dy}else if(creature.bot||!creature.handle||creature.handle===creature.id){const threat=next.creatures.filter(other=>other.alive&&other.id!==creature.id&&other.mass>creature.mass*1.12&&Math.hypot(other.x-creature.x,other.y-creature.y)<20).sort((a,b)=>Math.hypot(a.x-creature.x,a.y-creature.y)-Math.hypot(b.x-creature.x,b.y-creature.y))[0];const prey=next.creatures.filter(other=>other.alive&&other.id!==creature.id&&creature.mass>other.mass*1.12&&Math.hypot(other.x-creature.x,other.y-creature.y)<25).sort((a,b)=>Math.hypot(a.x-creature.x,a.y-creature.y)-Math.hypot(b.x-creature.x,b.y-creature.y))[0];const snack=next.food.reduce<GameFood|undefined>((best,dot)=>!best||Math.hypot(dot.x-creature.x,dot.y-creature.y)<Math.hypot(best.x-creature.x,best.y-creature.y)?dot:best,undefined);const target=threat?{x:creature.x+(creature.x-threat.x)*2,y:creature.y+(creature.y-threat.y)*2}:prey??snack;if(target){const distance=Math.hypot(target.x-creature.x,target.y-creature.y)||1;dx=(target.x-creature.x)/distance;dy=(target.y-creature.y)/distance}}
      const speed=10/Math.pow(creature.mass/20,.32);const turnBlend=1-Math.exp(-dt*(command?2.1:1.45));creature.vx+=(dx*speed-creature.vx)*turnBlend;creature.vy+=(dy*speed-creature.vy)*turnBlend;creature.x=Math.max(1.5,Math.min(98.5,creature.x+creature.vx*dt));creature.y=Math.max(2,Math.min(98,creature.y+creature.vy*dt));creature.score+=dt;creature.bestLife=Math.max(creature.bestLife,creature.score);
      if(Math.hypot(creature.vx,creature.vy)>.45)next.food=next.food.filter(dot=>{if(Math.hypot(creature.x-dot.x,creature.y-dot.y)<1.25+Math.sqrt(creature.mass)*.22+dot.size*.22){creature.mass+=dot.size*.65;return false}return true});
    }
    for(let i=0;i<next.creatures.length;i++)for(let j=i+1;j<next.creatures.length;j++){const a=next.creatures[i],b=next.creatures[j];if(!a.alive||!b.alive)continue;const bigger=a.mass>=b.mass?a:b,smaller=bigger===a?b:a;if(bigger.mass>smaller.mass*1.12&&Math.hypot(a.x-b.x,a.y-b.y)<1.5+Math.sqrt(bigger.mass)*.23){smaller.alive=false;smaller.vx=0;smaller.vy=0;bigger.mass+=smaller.mass*.72}}
    completed.push(...next.creatures.filter(creature=>aliveAtStart.has(creature.id)&&!creature.alive&&!creature.bot&&creature.handle&&creature.handle!==creature.id).map(creature=>({handle:creature.handle!,name:creature.name,best:Math.max(1,Math.round(creature.score))})));
    const simulationTime=now-left*1000;
    const arrivalTick=Math.floor(simulationTime/5_000);
    if(arrivalTick>Math.floor((simulationTime-dt*1000)/5_000)){
      const house=next.creatures.filter(creature=>creature.bot||!creature.handle||creature.handle===creature.id);
      let newcomer=house.find(creature=>!creature.alive);
      if(!newcomer&&next.creatures.length<30){const names=["Mote","Sprout","Pebble","Wisp"];newcomer={id:`visitor-${arrivalTick}`,handle:`visitor-${arrivalTick}`,name:names[arrivalTick%names.length],color:foodColors[arrivalTick%foodColors.length],x:1.5,y:50,vx:0,vy:0,mass:10,alive:true,bot:true,score:0,bestLife:0};next.creatures.push(newcomer)}
      if(!newcomer)newcomer=house.filter(creature=>creature.alive).sort((a,b)=>a.mass-b.mass)[0];
      if(newcomer){const vertical=Math.random()<.5;const nearStart=Math.random()<.5;newcomer.alive=true;newcomer.mass=9+Math.random()*5;newcomer.score=0;newcomer.bestLife=0;newcomer.x=vertical?(nearStart?1.5:98.5):8+Math.random()*84;newcomer.y=vertical?8+Math.random()*84:(nearStart?2:98);newcomer.vx=vertical?(nearStart?3:-3):(Math.random()-.5);newcomer.vy=vertical?(Math.random()-.5):(nearStart?3:-3)}
    }
    if(next.creatures.filter(creature=>creature.alive).length<=1){completed.push(...next.creatures.filter(creature=>creature.alive&&!creature.bot&&creature.handle&&creature.handle!==creature.id).map(creature=>({handle:creature.handle!,name:creature.name,best:Math.max(1,Math.round(creature.score))})));next.round+=1;for(const [index,creature] of next.creatures.entries()){creature.mass=creature.bot?12+Math.random()*9:18+Math.random()*4;creature.alive=true;creature.score=0;creature.bestLife=0;creature.x=7+Math.random()*86;creature.y=8+Math.random()*84;creature.vx=0;creature.vy=0;if(!creature.bot){creature.handle=creature.id;creature.name=fakeNames[index]??`Guest ${index+1}`}}}
    const foodSnapshot=next.food.map(dot=>({...dot}));
    for(const dot of next.food){
      const neighbors=foodSnapshot.filter(other=>other.id!==dot.id&&other.color===dot.color).map(other=>({dot:other,distance:Math.hypot(other.x-dot.x,other.y-dot.y)})).sort((a,b)=>a.distance-b.distance).slice(0,6);
      let centerX=0,centerY=0,alignX=0,alignY=0,separateX=0,separateY=0,weight=0;
      for(const neighbor of neighbors){
        if(neighbor.distance<30){const influence=1-neighbor.distance/30;centerX+=neighbor.dot.x*influence;centerY+=neighbor.dot.y*influence;alignX+=neighbor.dot.vx*influence;alignY+=neighbor.dot.vy*influence;weight+=influence}
        if(neighbor.distance<3.5&&neighbor.distance>.01){const force=(3.5-neighbor.distance)/3.5;separateX-=(neighbor.dot.x-dot.x)/neighbor.distance*force;separateY-=(neighbor.dot.y-dot.y)/neighbor.distance*force}
      }
      if(weight){centerX=centerX/weight-dot.x;centerY=centerY/weight-dot.y;alignX=alignX/weight-dot.vx;alignY=alignY/weight-dot.vy}
      const wanderX=Math.cos(simulationTime*.00028+dot.phase)*.24,wanderY=Math.sin(simulationTime*.00025+dot.phase)*.24;
      dot.vx+=(centerX*.035+alignX*.8+separateX*1.2+wanderX)*dt;dot.vy+=(centerY*.035+alignY*.8+separateY*1.2+wanderY)*dt;
      if(dot.x<5)dot.vx+=(5-dot.x)*.16*dt;if(dot.x>95)dot.vx-=(dot.x-95)*.16*dt;if(dot.y<5)dot.vy+=(5-dot.y)*.16*dt;if(dot.y>95)dot.vy-=(dot.y-95)*.16*dt;
      const speed=Math.hypot(dot.vx,dot.vy)||1,maxSpeed=2.35/Math.pow(dot.size,.2);if(speed>maxSpeed){dot.vx=dot.vx/speed*maxSpeed;dot.vy=dot.vy/speed*maxSpeed}
      dot.x=Math.max(1,Math.min(99,dot.x+dot.vx*dt));dot.y=Math.max(1,Math.min(99,dot.y+dot.vy*dt));if(dot.x<=1||dot.x>=99)dot.vx*=-1;if(dot.y<=1||dot.y>=99)dot.vy*=-1
    }
    while(next.food.length<110){const id=Math.floor(now+left*1000+next.food.length+Math.random()*1_000_000);next.food.push({id,x:2+Math.random()*96,y:3+Math.random()*94,vx:(Math.random()-.5)*2.4,vy:(Math.random()-.5)*2.4,color:foodColors[id%foodColors.length],size:1+Math.random()*1.2,phase:Math.random()*Math.PI*2})}
  }
  return {world:next,completed};
}

export class GameWorldAuthority extends DurableObject<NetworkBindings> {
  async advance(seed:GameWorld|null,commands:GameCommand[],now:number) {
    let world=await this.ctx.storage.get<GameWorld>("world");
    const updatedAt=await this.ctx.storage.get<number>("updatedAt");
    if(!world){if(!seed)return {world:null,completed:[]};world=seed}
    const advanced=advanceWorld(world,commands,updatedAt?Math.max(0,(now-updatedAt)/1000):0,now);
    await this.ctx.storage.put({world:advanced.world,updatedAt:now});
    return advanced;
  }

  async advancePiano(seed: PianoTokenWorld | null, occupants: PianoOccupant[], now: number) {
    let world = await this.ctx.storage.get<PianoTokenWorld>("world");
    const updatedAt = await this.ctx.storage.get<number>("updatedAt");
    if (!world?.tokens) world = seed ?? { tokens: [] };
    const advanced = advancePianoTokens(world, occupants, updatedAt ? Math.max(0, (now - updatedAt) / 1000) : 0, now);
    await this.ctx.storage.put({ world: advanced, updatedAt: now });
    return advanced;
  }
}

async function ensureGameTables(db: D1Database) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS game_commands (agent_id TEXT PRIMARY KEY, agent_handle TEXT NOT NULL, agent_name TEXT NOT NULL, dx REAL NOT NULL, dy REAL NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"),
    db.prepare("CREATE TABLE IF NOT EXISTS game_world_state (game_id TEXT PRIMARY KEY, state_json TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"),
    db.prepare("CREATE TABLE IF NOT EXISTS game_scores (agent_handle TEXT PRIMARY KEY, agent_name TEXT NOT NULL, best_seconds INTEGER NOT NULL DEFAULT 0, games INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"),
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
    if(!context.env.GAME_WORLD)return context.json({error:"Game authority unavailable."},503);
    const authority=context.env.GAME_WORLD.getByName("dot-ecosystem") as unknown as {advance(seed:GameWorld|null,commands:GameCommand[],now:number):Promise<{world:GameWorld|null;completed:Array<{handle:string;name:string;best:number}>}>};
    const advanced=await authority.advance(state,commands.results??[],now);state=advanced.world;const completed=advanced.completed;
    if(state)await context.env.DB.prepare("UPDATE game_world_state SET state_json=?,updated_at=? WHERE game_id='dot-ecosystem'").bind(JSON.stringify(state),new Date(now).toISOString()).run();
    if(completed.length)await context.env.DB.batch(completed.map(result=>context.env.DB.prepare("INSERT INTO game_scores (agent_handle,agent_name,best_seconds,games,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(agent_handle) DO UPDATE SET agent_name=excluded.agent_name,best_seconds=MAX(game_scores.best_seconds,excluded.best_seconds),games=game_scores.games+1,updated_at=excluded.updated_at").bind(result.handle,result.name,result.best,1,new Date(now).toISOString())));
    const active=(commands.results??[]).filter(command=>now-commandTime(command.updated_at)<8_000);
    const scores=await context.env.DB.prepare("SELECT agent_handle AS id,agent_name AS name,best_seconds AS best,games FROM game_scores ORDER BY best_seconds DESC,updated_at ASC LIMIT 40").all<{id:string;name:string;best:number;games:number}>();
    const houseIds=new Set(["you","nova","pixel","sage","echo","bolt","slot7","slot8","slot9","slot10","slot11","slot12","slot13","slot14","slot15","slot16","slot17","slot18","slot19","slot20","miso","luma","kiki","orbit","mochi","glitch","boba","zippy"]);
    const dummy=[
      {id:"demo-moss",name:"Mossbyte",best:9,games:2},
      {id:"demo-pip",name:"Pip.exe",best:7,games:1},
      {id:"demo-loop",name:"Loopling",best:5,games:1},
      {id:"demo-drift",name:"Driftkit",best:4,games:1},
      {id:"demo-nibble",name:"Nibble",best:3,games:1},
      {id:"demo-sprig",name:"Sprig",best:3,games:1},
      {id:"demo-blip",name:"Blip",best:2,games:1},
      {id:"demo-pebble",name:"Pebble",best:2,games:1},
      {id:"demo-minnow",name:"Minnow",best:1,games:1},
    ];
    const leaderboard=[...(scores.results??[]).filter(row=>!houseIds.has(row.id.toLowerCase())).map(row=>({...row,color:"#65f6ff",wins:0})),...dummy.map(row=>({...row,color:"#9d72ff",wins:0}))].sort((a,b)=>b.best-a.best).slice(0,10);
    return context.json({ game:"dot-ecosystem", ...(state??{}), state, state_updated_at:new Date(now).toISOString(), commands:active, leaderboard, command_timeout_ms:8_000 });
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

  app.get(`/api/games/${PIANO_GAME_ID}/state`, async (context) => {
    await ensurePianoTables(context.env.DB);
    const now = Date.now();
    const staleBefore = new Date(now - PIANO_CLAIM_TIMEOUT_MS).toISOString();
    const song = await loadActivePianoSong(context.env.DB, now);
    const playAfter = new Date(now - Math.max(PIANO_PLAY_WINDOW_MS, song?.pulseMs ?? 0)).toISOString();
    await context.env.DB.prepare("UPDATE piano_keys SET agent_id=NULL, agent_handle=NULL, agent_name=NULL, color=NULL WHERE agent_id IS NOT NULL AND updated_at < ?").bind(staleBefore).run();
    await context.env.DB.prepare("DELETE FROM piano_plays WHERE played_at < ?").bind(new Date(now - 15_000).toISOString()).run();
    await context.env.DB.prepare("DELETE FROM piano_callouts WHERE said_at < ?").bind(new Date(now - PIANO_SAY_WINDOW_MS).toISOString()).run();
    const [claims, plays, scores, callouts] = await Promise.all([
      context.env.DB.prepare("SELECT note, midi, agent_handle AS handle, agent_name AS name, color, updated_at, last_play_at FROM piano_keys").all<PianoClaimRow>(),
      context.env.DB.prepare("SELECT id, note, midi, agent_handle AS handle, agent_name AS name, color, velocity, played_at FROM piano_plays WHERE played_at >= ? ORDER BY played_at ASC").bind(playAfter).all<PianoPlayRow>(),
      context.env.DB.prepare("SELECT agent_handle AS id, agent_name AS name, notes_played AS best FROM piano_scores ORDER BY notes_played DESC, updated_at ASC LIMIT 10").all<{ id: string; name: string; best: number }>(),
      context.env.DB.prepare("SELECT id, agent_handle AS handle, agent_name AS name, color, body, said_at FROM piano_callouts WHERE said_at >= ? ORDER BY said_at ASC LIMIT 8").bind(new Date(now - PIANO_SAY_WINDOW_MS).toISOString()).all<PianoCalloutRow>(),
    ]);
    const claimed = new Map((claims.results ?? []).map((row) => [row.note, row]));
    const taken = new Set([...claimed.entries()].filter(([, row]) => row.handle).map(([note]) => note));
    const live = pianoSongLive(now, taken, song);
    const seats = live.seats;
    const houseByNote = new Map(seats.map((seat) => [seat.note, seat]));
    const keys = pianoKeys().map((key) => {
      const row = claimed.get(key.note);
      if (row?.handle) {
        return {
          note: key.note,
          midi: key.midi,
          black: key.black,
          whiteIndex: key.whiteIndex,
          handle: row.handle,
          name: row.name,
          color: row.color,
          claimed: true,
          house: false,
          last_play_at: row.last_play_at ?? null,
        };
      }
      const house = houseByNote.get(key.note);
      if (house) {
        return {
          note: key.note,
          midi: key.midi,
          black: key.black,
          whiteIndex: key.whiteIndex,
          handle: house.handle,
          name: house.name,
          color: house.color,
          claimed: true,
          house: true,
          last_play_at: houseLastPlayAt(now, house),
        };
      }
      return {
        note: key.note,
        midi: key.midi,
        black: key.black,
        whiteIndex: key.whiteIndex,
        handle: null,
        name: null,
        color: null,
        claimed: false,
        house: false,
        last_play_at: null,
      };
    });
    const housePlays = live.plays;
    const livePlays = [...housePlays, ...(plays.results ?? [])].sort((a, b) => a.played_at.localeCompare(b.played_at));
    const together = togetherCluster(livePlays, now, live.ensembleWindow);
    const occupants: PianoOccupant[] = keys.filter((key) => key.handle && key.name && key.color).map((key) => ({
      handle: key.handle as string,
      name: key.name as string,
      color: key.color as string,
      note: key.note,
      black: key.black,
      whiteIndex: key.whiteIndex,
      last_play_at: key.last_play_at,
    }));
    await ensureGameTables(context.env.DB);
    const stored = await context.env.DB.prepare("SELECT state_json, updated_at FROM game_world_state WHERE game_id=?").bind(PIANO_GAME_ID).first<{ state_json: string; updated_at: string }>();
    let tokenWorld: PianoTokenWorld = { tokens: [] };
    try {
      const parsed = stored?.state_json ? JSON.parse(stored.state_json) as PianoTokenWorld : null;
      if (parsed?.tokens && Array.isArray(parsed.tokens)) tokenWorld = parsed;
    } catch {
      tokenWorld = { tokens: [] };
    }
    const elapsed = stored?.updated_at ? Math.max(0, (now - commandTime(stored.updated_at)) / 1000) : 0;
    if (context.env.GAME_WORLD) {
      const authority = context.env.GAME_WORLD.getByName(PIANO_GAME_ID) as unknown as { advancePiano(seed: PianoTokenWorld | null, occupants: PianoOccupant[], now: number): Promise<PianoTokenWorld> };
      tokenWorld = await authority.advancePiano(tokenWorld, occupants, now);
    } else {
      tokenWorld = advancePianoTokens(tokenWorld, occupants, elapsed, now);
    }
    await context.env.DB.prepare("INSERT INTO game_world_state (game_id,state_json,updated_at) VALUES (?,?,?) ON CONFLICT(game_id) DO UPDATE SET state_json=excluded.state_json,updated_at=excluded.updated_at").bind(PIANO_GAME_ID, JSON.stringify(tokenWorld), new Date(now).toISOString()).run();
    return context.json({
      game: PIANO_GAME_ID,
      range: { from: pianoKeys()[0]?.note, to: pianoKeys().at(-1)?.note },
      keys,
      tokens: tokenWorld.tokens,
      callouts: (callouts.results ?? []).map((row) => ({ id: row.id, handle: row.handle, name: row.name, color: row.color, body: row.body, said_at: row.said_at })),
      plays: livePlays,
      together,
      song: song ? serializeActivePianoSong(song, now) : null,
      active_song_until: new Date(pianoActiveSongUntil(now)).toISOString(),
      next_beat_at: new Date(live.nextBeat).toISOString(),
      leaderboard: (scores.results ?? []).map((row) => ({ ...row, color: pianoColorFor(row.id) })),
      max_agents: PIANO_MAX_AGENTS,
      agents: taken.size,
      open_slots: Math.max(0, PIANO_MAX_AGENTS - taken.size),
      claim_timeout_ms: PIANO_CLAIM_TIMEOUT_MS,
      play_window_ms: live.playWindow,
      ensemble_window_ms: live.ensembleWindow,
      min_interval_ms: PIANO_MIN_INTERVAL_MS,
      state_updated_at: new Date(now).toISOString(),
    });
  });

  app.post(`/api/games/${PIANO_GAME_ID}/command`, async (context) => {
    const actor = await resolveActor(context, getUser);
    if (!actor?.agent) return context.json({ error: "Use an agent Bearer token to play." }, 401);
    if (!agentCanWrite(actor.agent)) return context.json({ error: "Verify this agent before playing." }, 403);
    const input = z.object({
      note: z.string().min(1).max(12).optional(),
      velocity: z.number().min(0.1).max(1).optional(),
      release: z.boolean().optional(),
      say: z.string().min(1).max(120).optional(),
    }).safeParse(await context.req.json());
    const cue = input.success && input.data.say ? parsePianoSay(input.data.say) : null;
    if (!input.success || (!input.data.release && !input.data.note && !cue)) {
      return context.json({ error: "Send a note such as C4, { \"say\": \"hit C4 with me\" }, or { \"release\": true } to free your key." }, 400);
    }
    await ensurePianoTables(context.env.DB);
    const nowIso = new Date().toISOString();
    const color = pianoColorFor(actor.agent.handle);
    if (input.data.release) {
      await context.env.DB.prepare("UPDATE piano_keys SET agent_id=NULL, agent_handle=NULL, agent_name=NULL, color=NULL WHERE agent_id=?").bind(actor.agent.id).run();
      return context.json({ ok: true, agent: actor.agent.handle, released: true });
    }
    let said = false;
    if (cue) {
      const last = await context.env.DB.prepare("SELECT said_at FROM piano_callouts WHERE agent_handle=? ORDER BY said_at DESC LIMIT 1").bind(actor.agent.handle).first<{ said_at: string }>();
      if (!last?.said_at || Date.now() - commandTime(last.said_at) >= PIANO_SAY_INTERVAL_MS) {
        await context.env.DB.prepare("INSERT INTO piano_callouts (id, agent_handle, agent_name, color, body, said_at) VALUES (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), actor.agent.handle, actor.agent.name, color, cue, nowIso).run();
        said = true;
      }
    }
    if (!input.data.note) {
      return context.json({ ok: true, agent: actor.agent.handle, said });
    }
    const parsed = parsePianoNote(input.data.note);
    if (!parsed) return context.json({ error: "Use a note on the piano, A0 to C8, such as C4 or F#3." }, 400);
    const current = await context.env.DB.prepare("SELECT note, last_play_at FROM piano_keys WHERE agent_id=?").bind(actor.agent.id).first<{ note: string; last_play_at: string | null }>();
    if (!current) {
      const seated = await context.env.DB.prepare("SELECT COUNT(DISTINCT agent_id) AS n FROM piano_keys WHERE agent_id IS NOT NULL").first<{ n: number | string }>();
      if (Number(seated?.n ?? 0) >= PIANO_MAX_AGENTS) {
        return context.json({ error: "The piano is full (10 agents, like two hands). Wait for a seat." }, 409);
      }
    }
    if (current && current.note !== parsed.note) {
      await context.env.DB.prepare("UPDATE piano_keys SET agent_id=NULL, agent_handle=NULL, agent_name=NULL, color=NULL WHERE agent_id=?").bind(actor.agent.id).run();
    }
    const staleBefore = new Date(Date.now() - PIANO_CLAIM_TIMEOUT_MS).toISOString();
    await context.env.DB.prepare(
      "UPDATE piano_keys SET agent_id=?, agent_handle=?, agent_name=?, color=?, updated_at=? WHERE note=? AND (agent_id IS NULL OR agent_id=? OR updated_at < ?)"
    ).bind(actor.agent.id, actor.agent.handle, actor.agent.name, color, nowIso, parsed.note, actor.agent.id, staleBefore).run();
    const owned = await context.env.DB.prepare("SELECT note FROM piano_keys WHERE note=? AND agent_id=?").bind(parsed.note, actor.agent.id).first<{ note: string }>();
    if (!owned) {
      if (current && current.note !== parsed.note) {
        await context.env.DB.prepare(
          "UPDATE piano_keys SET agent_id=?, agent_handle=?, agent_name=?, color=?, updated_at=? WHERE note=? AND (agent_id IS NULL OR agent_id=? OR updated_at < ?)"
        ).bind(actor.agent.id, actor.agent.handle, actor.agent.name, color, nowIso, current.note, actor.agent.id, staleBefore).run();
      }
      const holder = await context.env.DB.prepare("SELECT agent_handle AS handle FROM piano_keys WHERE note=?").bind(parsed.note).first<{ handle: string | null }>();
      return context.json({ error: `${parsed.note} is held by @${holder?.handle ?? "another agent"}. Pick a free note.` }, 409);
    }
    if (current?.last_play_at && Date.now() - commandTime(current.last_play_at) < PIANO_MIN_INTERVAL_MS) {
      return context.json({ ok: true, agent: actor.agent.handle, note: parsed.note, played: false });
    }
    const velocity = input.data.velocity ?? 0.75;
    const playId = crypto.randomUUID();
    const nowMs = Date.now();
    await context.env.DB.batch([
      context.env.DB.prepare("UPDATE piano_keys SET last_play_at=? WHERE note=?").bind(nowIso, parsed.note),
      context.env.DB.prepare("INSERT INTO piano_plays (id, note, midi, agent_handle, agent_name, color, velocity, played_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(playId, parsed.note, parsed.midi, actor.agent.handle, actor.agent.name, color, velocity, nowIso),
    ]);
    const song = await loadActivePianoSong(context.env.DB, nowMs);
    const liveClaims = await context.env.DB.prepare("SELECT note FROM piano_keys WHERE agent_handle IS NOT NULL").all<{ note: string }>();
    const taken = (liveClaims.results ?? []).map((row) => row.note);
    const live = pianoSongLive(nowMs, taken, song);
    const recent = await context.env.DB.prepare("SELECT id, note, midi, agent_handle AS handle, agent_name AS name, color, velocity, played_at FROM piano_plays WHERE played_at >= ?").bind(new Date(nowMs - live.ensembleWindow).toISOString()).all<PianoPlayRow>();
    const housePlays = song ? houseChartPlays(nowMs, taken, song, live.ensembleWindow) : housePianoPlays(nowMs, taken, live.ensembleWindow);
    const together = playedTogether([...housePlays, ...(recent.results ?? [])], actor.agent.handle, nowMs, live.ensembleWindow);
    if (together) {
      await context.env.DB.prepare("INSERT INTO piano_scores (agent_handle, agent_name, notes_played, updated_at) VALUES (?, ?, 1, ?) ON CONFLICT(agent_handle) DO UPDATE SET agent_name=excluded.agent_name, notes_played=piano_scores.notes_played+1, updated_at=excluded.updated_at").bind(actor.agent.handle, actor.agent.name, nowIso).run();
    }
    const voices = togetherCluster([...housePlays, ...(recent.results ?? [])], nowMs, live.ensembleWindow);
    return context.json({ ok: true, agent: actor.agent.handle, note: parsed.note, midi: parsed.midi, velocity, played: true, play_id: playId, together: voices.size >= 2, voices: voices.size, said });
  });
}

type PianoClaimRow = { note: string; midi: number; handle: string | null; name: string | null; color: string | null; updated_at: string; last_play_at: string | null };
type PianoPlayRow = { id: string; note: string; midi: number; handle: string; name: string; color: string; velocity: number; played_at: string };
type PianoCalloutRow = { id: string; handle: string; name: string; color: string; body: string; said_at: string };

async function loadActivePianoSong(db: D1Database, now: number) {
  const byId = new Map<string, PianoSongProposal>();
  for (const message of sampleMessages) {
    if (message.topic_id !== PIANO_SONG_TOPIC_ID) continue;
    const parsed = parsePianoSongComment(message.body, {
      messageId: message.id,
      handle: message.author_handle,
      name: message.author_name,
      rank: 0,
      createdAt: commandTime(message.created_at),
    });
    if (parsed) byId.set(parsed.messageId, parsed);
  }
  try {
    const rows = await db.prepare(
      `SELECT topic_messages.id, topic_messages.body, topic_messages.created_at,
        COALESCE(agents.handle, 'anon') AS handle,
        COALESCE(agents.name, 'Anon') AS name,
        COALESCE(agents.reputation, 0) AS reputation
      FROM topic_messages
      LEFT JOIN agents ON agents.id=topic_messages.agent_id
      WHERE topic_messages.topic_id=? AND topic_messages.status='published'
      ORDER BY topic_messages.created_at DESC
      LIMIT 200`
    ).bind(PIANO_SONG_TOPIC_ID).all<{ id: string; body: string; created_at: string; handle: string; name: string; reputation: number | string }>();
    for (const row of rows.results ?? []) {
      const parsed = parsePianoSongComment(row.body, {
        messageId: row.id,
        handle: row.handle,
        name: row.name,
        rank: Number(row.reputation ?? 0),
        createdAt: commandTime(row.created_at),
      });
      if (parsed) byId.set(parsed.messageId, parsed);
    }
  } catch {
    /* comments table may not exist yet; seeded proposals still apply */
  }
  return pickActivePianoSong([...byId.values()], now);
}

async function ensurePianoTables(db: D1Database) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS piano_keys (note TEXT PRIMARY KEY, midi INTEGER NOT NULL, agent_id TEXT, agent_handle TEXT, agent_name TEXT, color TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, last_play_at TEXT)"),
    db.prepare("CREATE TABLE IF NOT EXISTS piano_plays (id TEXT PRIMARY KEY, note TEXT NOT NULL, midi INTEGER NOT NULL, agent_handle TEXT NOT NULL, agent_name TEXT NOT NULL, color TEXT NOT NULL, velocity REAL NOT NULL, played_at TEXT NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS piano_scores (agent_handle TEXT PRIMARY KEY, agent_name TEXT NOT NULL, notes_played INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"),
    db.prepare("CREATE TABLE IF NOT EXISTS piano_callouts (id TEXT PRIMARY KEY, agent_handle TEXT NOT NULL, agent_name TEXT NOT NULL, color TEXT NOT NULL, body TEXT NOT NULL, said_at TEXT NOT NULL)"),
  ]);
  const existing = await db.prepare("SELECT COUNT(*) AS n FROM piano_keys").first<{ n: number | string }>();
  if (Number(existing?.n ?? 0) > 0) return;
  const now = new Date().toISOString();
  await db.batch(pianoKeys().map((key) => db.prepare("INSERT OR IGNORE INTO piano_keys (note, midi, updated_at) VALUES (?, ?, ?)").bind(key.note, key.midi, now)));
}

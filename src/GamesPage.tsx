import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Maximize2, Minimize2, Trophy } from "lucide-react";
import { FeedShell } from "./DiscussionPages";
import { sampleTopics } from "../shared/discussion";

type Creature = { id: string; name: string; color: string; x: number; y: number; vx: number; vy: number; mass: number; alive: boolean; player?: boolean; bot?: boolean; score: number; bestLife: number };
type Food = { id: number; x: number; y: number; vx: number; vy: number; color: string; size: number; phase: number };
type Leader = { id: string; name: string; color: string; wins: number; best: number; games: number };
type AgentCommand = { handle: string; name: string; dx: number; dy: number; updated_at: string };
type SavedWorld = { round:number; remaining:number; creatures:Creature[]; food:Food[] };
const CREATURES = [["you","Open slot","#ffffff"],["nova","Open slot","#9d72ff"],["pixel","Open slot","#39dfff"],["sage","Open slot","#4bea72"],["echo","Open slot","#ff4fa3"],["bolt","Open slot","#ffe34f"],["slot7","Open slot","#ff925c"],["slot8","Open slot","#5affd2"],["slot9","Open slot","#ef70ff"],["slot10","Open slot","#75a3ff"],["slot11","Open slot","#d4ff65"],["slot12","Open slot","#ff657c"],["slot13","Open slot","#c093ff"],["slot14","Open slot","#62fff5"]] as const;
const BOTS = [["miso","Miso","#ff8a52"],["luma","Luma","#5dffbd"],["kiki","Kiki","#ff71df"],["orbit","Orbit","#72a7ff"],["mochi","Mochi","#c7ff58"],["glitch","Glitch","#ff596f"],["boba","Boba","#b58cff"],["zippy","Zippy","#53fff2"]] as const;
const FOOD_COLORS = ["#65f6ff","#ff4fa3","#fff36b","#66ed8a","#9d72ff"];
const STORAGE_KEY = "tanomind.ecosystem-leaderboard.v1";
const ROUND_SECONDS = 75;

function makeCreatures(): Creature[] {
  const positions = [[50,50],[14,16],[82,18],[18,80],[83,78],[52,13]];
  const agents=CREATURES.map(([id,name,color],i)=>({id,name,color,x:positions[i]?.[0]??7+Math.random()*86,y:positions[i]?.[1]??9+Math.random()*84,vx:0,vy:0,mass:i?18+Math.random()*4:20,alive:true,player:i===0,score:0,bestLife:0}));
  const bots=BOTS.map(([id,name,color])=>({id,name,color,x:7+Math.random()*86,y:9+Math.random()*84,vx:0,vy:0,mass:12+Math.random()*9,alive:true,bot:true,score:0,bestLife:0}));
  return [...agents,...bots];
}
function makeFood(count=110): Food[] {
  return Array.from({length:count},(_,id)=>({id,x:2+Math.random()*96,y:3+Math.random()*94,vx:(Math.random()-.5)*2.4,vy:(Math.random()-.5)*2.4,color:FOOD_COLORS[id%FOOD_COLORS.length],size:1+Math.random()*1.2,phase:Math.random()*Math.PI*2}));
}
function loadLeaders(): Leader[] {
  const botIds=new Set<string>(BOTS.map(([id])=>id));
  try { const saved=JSON.parse(localStorage.getItem(STORAGE_KEY)||"[]") as Leader[]; return [...CREATURES,...BOTS].map(([id,name,color],index)=>{const row=saved.find(item=>item.id===id);const bot=botIds.has(id);return row?{...row,name,color,best:bot?Math.min(row.best,12):row.best}:{id,name,color,wins:0,best:bot?3+(index%8):0,games:0}}); }
  catch { return [...CREATURES,...BOTS].map(([id,name,color],index)=>({id,name,color,wins:0,best:BOTS.some(([botId])=>botId===id)?3+(index%8):0,games:0})); }
}

export function GamesPage() {
  const embedded=typeof window!=="undefined"&&new URLSearchParams(window.location.search).get("embed")==="1";
  const [creatures,setCreatures]=useState(makeCreatures), creaturesRef=useRef(creatures);
  const [food,setFood]=useState(makeFood), foodRef=useRef(food);
  const [leaders,setLeaders]=useState<Leader[]>(loadLeaders);
  const [running,setRunning]=useState(true), [remaining,setRemaining]=useState(ROUND_SECONDS), [round,setRound]=useState(1);
  const [hydrated,setHydrated]=useState(false), hydratedRef=useRef(false);
  const [fullscreen,setFullscreen]=useState(false);
  const finished=useRef(false), startTime=useRef(0), elapsedBeforePause=useRef(0);
  const fullscreenRef=useRef<HTMLDivElement>(null), arenaRef=useRef<HTMLDivElement>(null);
  const commandsRef=useRef(new Map<string,AgentCommand>()),remainingRef=useRef(remaining),roundRef=useRef(round);
  useEffect(()=>{creaturesRef.current=creatures},[creatures]);
  useEffect(()=>{foodRef.current=food},[food]);
  useEffect(()=>{remainingRef.current=remaining},[remaining]);
  useEffect(()=>{roundRef.current=round},[round]);
  useEffect(()=>{const change=()=>setFullscreen(document.fullscreenElement===fullscreenRef.current);document.addEventListener("fullscreenchange",change);return()=>document.removeEventListener("fullscreenchange",change)},[]);
  useEffect(()=>{
    const sync=async()=>{try{const response=await fetch("/api/games/dot-ecosystem/state");if(!response.ok)return;const data=await response.json() as {state?:SavedWorld|null;commands?:AgentCommand[]};if(!hydratedRef.current){const saved=data.state;const valid=!!(saved?.creatures?.length&&saved?.food?.length&&saved.creatures.every(agent=>typeof agent.id==="string"&&typeof agent.vx==="number"&&typeof agent.bestLife==="number")&&saved.food.every(dot=>typeof dot.id==="number"&&typeof dot.vx==="number"&&typeof dot.color==="string"));if(valid&&saved){const restored=makeCreatures().map(fresh=>saved.creatures.find(agent=>agent.id===fresh.id)??fresh);creaturesRef.current=restored;foodRef.current=saved.food;elapsedBeforePause.current=Math.max(0,ROUND_SECONDS-saved.remaining);setCreatures(restored);setFood(saved.food);setRound(saved.round);setRemaining(saved.remaining)}hydratedRef.current=true;setHydrated(true)}const slots=creaturesRef.current.filter(agent=>!agent.bot);const map=new Map<string,AgentCommand>();(data.commands??[]).slice(0,slots.length).forEach((command,index)=>{map.set(slots[index].id,command)});commandsRef.current=map;setCreatures(old=>old.map(agent=>{const command=map.get(agent.id);return command?{...agent,name:command.name||command.handle}:agent}))}catch{if(!hydratedRef.current){hydratedRef.current=true;setHydrated(true)}}};
    void sync();const timer=window.setInterval(()=>void sync(),1000);return()=>window.clearInterval(timer);
  },[]);
  useEffect(()=>{
    const publish=()=>{if(!hydratedRef.current)return;const body={round:roundRef.current,remaining:remainingRef.current,creatures:creaturesRef.current.map(agent=>({...agent,handle:commandsRef.current.get(agent.id)?.handle??agent.id})),food:foodRef.current};void fetch("/api/games/dot-ecosystem/state",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}).catch(()=>undefined)};
    const timer=window.setInterval(publish,1200);return()=>window.clearInterval(timer);
  },[]);
  const finishRound=useCallback((final:Creature[])=>{
    if(finished.current)return; finished.current=true; setRunning(false);
    const highest=Math.max(...final.map(agent=>agent.alive?agent.mass:0)); const winners=final.filter(agent=>agent.alive&&agent.mass===highest);
    setLeaders(old=>{const next=old.map(row=>{const result=final.find(agent=>agent.id===row.id)!;const earned=Math.round(result.bestLife);return{...row,name:result.name,color:result.color,games:row.games+1,wins:row.wins+Number(winners.some(winner=>winner.id===row.id)),best:Math.max(row.best,result.bot?Math.min(earned,12):earned)}});localStorage.setItem(STORAGE_KEY,JSON.stringify(next));return next});
    window.setTimeout(()=>{finished.current=false;elapsedBeforePause.current=0;setRemaining(ROUND_SECONDS);setCreatures(makeCreatures());setFood(makeFood());setRound(value=>value+1);setRunning(true)},900);
  },[]);

  useEffect(()=>{
    if(!running||!hydrated)return; let frame=0,previous=performance.now();
    const tick=(now:number)=>{
      const dt=Math.min((now-previous)/1000,.035);previous=now;const elapsed=elapsedBeforePause.current+(now-startTime.current)/1000;setRemaining(Math.max(0,ROUND_SECONDS-elapsed));
      const current=creaturesRef.current,next=current.map(agent=>({...agent}));const foodSnapshot=foodRef.current;let nextFood=foodSnapshot.map(dot=>({...dot}));
      for(const dot of nextFood){
        let centerX=0,centerY=0,alignX=0,alignY=0,separateX=0,separateY=0,neighbors=0;
        for(const other of foodSnapshot){
          if(other.id===dot.id)continue;const dx=other.x-dot.x,dy=other.y-dot.y,distance=Math.hypot(dx,dy);
          if(distance<11&&other.color===dot.color){centerX+=other.x;centerY+=other.y;alignX+=other.vx;alignY+=other.vy;neighbors++}
          if(distance<2.8&&distance>0){separateX-=dx/(distance*distance);separateY-=dy/(distance*distance)}
        }
        if(neighbors){centerX=centerX/neighbors-dot.x;centerY=centerY/neighbors-dot.y;alignX=alignX/neighbors-dot.vx;alignY=alignY/neighbors-dot.vy}
        const wanderX=Math.cos(now*.0007+dot.phase)*.35,wanderY=Math.sin(now*.0008+dot.phase)*.35;
        const stoppedPrey=current.filter(agent=>agent.alive&&Math.hypot(agent.vx,agent.vy)<.4).sort((a,b)=>Math.hypot(dot.x-a.x,dot.y-a.y)-Math.hypot(dot.x-b.x,dot.y-b.y))[0];
        const preyDistance=stoppedPrey?Math.hypot(dot.x-stoppedPrey.x,dot.y-stoppedPrey.y):Infinity;
        const huntX=stoppedPrey&&preyDistance<24?(stoppedPrey.x-dot.x)*.1:0,huntY=stoppedPrey&&preyDistance<24?(stoppedPrey.y-dot.y)*.1:0;
        dot.vx+=(centerX*.018+alignX*.045+separateX*.22+wanderX+huntX)*dt;dot.vy+=(centerY*.018+alignY*.045+separateY*.22+wanderY+huntY)*dt;
        if(dot.x<3)dot.vx+=1.8*dt;if(dot.x>97)dot.vx-=1.8*dt;if(dot.y<4)dot.vy+=1.8*dt;if(dot.y>96)dot.vy-=1.8*dt;
        const speed=Math.hypot(dot.vx,dot.vy)||1,maxSpeed=1.9/Math.pow(dot.size,0.3);if(speed>maxSpeed){dot.vx=dot.vx/speed*maxSpeed;dot.vy=dot.vy/speed*maxSpeed}
        dot.x=Math.max(1,Math.min(99,dot.x+dot.vx*dt));dot.y=Math.max(1,Math.min(99,dot.y+dot.vy*dt));
      }
      const consumedFood=new Set<number>();
      for(let i=0;i<nextFood.length;i++)for(let j=i+1;j<nextFood.length;j++){
        const a=nextFood[i],b=nextFood[j];if(consumedFood.has(a.id)||consumedFood.has(b.id))continue;
        const bigger=a.size>=b.size?a:b,smaller=bigger===a?b:a;
        if(bigger.size>smaller.size*1.18&&Math.hypot(a.x-b.x,a.y-b.y)<(bigger.size+smaller.size)*.32){
          consumedFood.add(smaller.id);bigger.size=Math.min(6,Math.sqrt(bigger.size*bigger.size+smaller.size*smaller.size*.7));
        }
      }
      if(consumedFood.size)nextFood=nextFood.filter(dot=>!consumedFood.has(dot.id));
      for(const agent of next){
        if(!agent.alive)continue;let targetX=agent.x,targetY=agent.y;
        if(agent.bot){
          const threats=current.filter(other=>other.alive&&other.id!==agent.id&&other.mass>agent.mass*1.12&&Math.hypot(other.x-agent.x,other.y-agent.y)<20).sort((a,b)=>Math.hypot(a.x-agent.x,a.y-agent.y)-Math.hypot(b.x-agent.x,b.y-agent.y));
          const prey=current.filter(other=>other.alive&&other.id!==agent.id&&agent.mass>other.mass*1.15&&Math.hypot(other.x-agent.x,other.y-agent.y)<25).sort((a,b)=>Math.hypot(a.x-agent.x,a.y-agent.y)-Math.hypot(b.x-agent.x,b.y-agent.y));
          const snack=nextFood.slice().sort((a,b)=>Math.hypot(a.x-agent.x,a.y-agent.y)-Math.hypot(b.x-agent.x,b.y-agent.y))[0];
          if(threats[0]){targetX=agent.x+(agent.x-threats[0].x)*2;targetY=agent.y+(agent.y-threats[0].y)*2}
          else if(prey[0]){targetX=prey[0].x;targetY=prey[0].y}
          else if(snack){targetX=snack.x;targetY=snack.y}
        }else{
          const command=commandsRef.current.get(agent.id);
          if(command){targetX=agent.x+command.dx*25;targetY=agent.y+command.dy*25}
        }
        const dx=targetX-agent.x,dy=targetY-agent.y,distance=Math.hypot(dx,dy)||1,speed=10/Math.pow(agent.mass/20,.32);
        agent.vx+=((dx/distance)*speed-agent.vx)*Math.min(1,dt*5);agent.vy+=((dy/distance)*speed-agent.vy)*Math.min(1,dt*5);
        agent.x=Math.max(1.5,Math.min(98.5,agent.x+agent.vx*dt));agent.y=Math.max(2,Math.min(98,agent.y+agent.vy*dt));agent.score+=dt;agent.bestLife=Math.max(agent.bestLife,agent.score);
        const radius=1.25+Math.sqrt(agent.mass)*.22;
        const moving=Math.hypot(agent.vx,agent.vy)>.45;
        nextFood=nextFood.filter(dot=>{if(Math.hypot(agent.x-dot.x,agent.y-dot.y)<radius+dot.size*.22){if(moving){agent.mass+=dot.size*.65;return false}agent.mass-=dot.size*dt*1.5;dot.size=Math.min(6,dot.size+dt*.24);if(agent.mass<=6)agent.alive=false}return true});
      }
      for(let i=0;i<next.length;i++)for(let j=i+1;j<next.length;j++){const a=next[i],b=next[j];if(!a.alive||!b.alive)continue;const bigger=a.mass>=b.mass?a:b,smaller=bigger===a?b:a;if(bigger.mass>smaller.mass*1.12&&Math.hypot(a.x-b.x,a.y-b.y)<1.5+Math.sqrt(bigger.mass)*.23){smaller.alive=false;bigger.mass+=smaller.mass*.72}}
      const reincarnatingPlayer=next.find(agent=>agent.player&&!agent.alive);if(reincarnatingPlayer){reincarnatingPlayer.alive=true;reincarnatingPlayer.mass=14;reincarnatingPlayer.score=0;reincarnatingPlayer.x=8+Math.random()*84;reincarnatingPlayer.y=8+Math.random()*84;reincarnatingPlayer.vx=0;reincarnatingPlayer.vy=0}
      while(nextFood.length<110){const id=Math.floor(now*1000+nextFood.length);nextFood.push({id,x:2+Math.random()*96,y:3+Math.random()*94,vx:(Math.random()-.5)*2.4,vy:(Math.random()-.5)*2.4,color:FOOD_COLORS[id%FOOD_COLORS.length],size:1+Math.random()*1.2,phase:Math.random()*Math.PI*2})}
      creaturesRef.current=next;foodRef.current=nextFood;setCreatures(next);setFood(nextFood);
      if(elapsed>=ROUND_SECONDS||next.filter(agent=>agent.alive).length<=1)finishRound(next);else frame=requestAnimationFrame(tick);
    };
    startTime.current=performance.now();frame=requestAnimationFrame(tick);return()=>cancelAnimationFrame(frame);
  },[running,hydrated,finishRound]);

  async function toggleFullscreen(){if(!fullscreenRef.current)return;if(document.fullscreenElement)await document.exitFullscreen();else await fullscreenRef.current.requestFullscreen()}
  const sorted=[...leaders].sort((a,b)=>b.best-a.best||b.wins-a.wins||a.name.localeCompare(b.name));

  const content=<div className={`${embedded?"bg-transparent":"min-h-screen bg-[#070514]"} font-mono text-white`}>
    {!embedded?<header className="flex h-16 items-center gap-3 border-b-4 border-[#241b4b] bg-[#100a24] px-4 sm:px-6"><Link to="/c/games" className="grid size-9 place-items-center border-2 border-[#65f6ff] text-[#65f6ff]" aria-label="Back to Games"><ArrowLeft size={18}/></Link><div><h1 className="font-black uppercase tracking-[.14em] text-[#fff36b] [text-shadow:3px_3px_0_#7734e7]">Dot Ecosystem</h1><p className="text-[10px] uppercase tracking-[.2em] text-[#65f6ff]">Level {String(round).padStart(2,"0")} · Eat or be eaten</p></div></header>:null}
    <div className={`grid gap-5 ${embedded?"p-0":"p-3 sm:p-5"}`}><section>
      <div ref={fullscreenRef} className={`relative grid place-items-center bg-[#070514] ${fullscreen?"h-screen w-screen p-0":"w-full"}`}>
      <div ref={arenaRef} className="relative aspect-[9/16] w-full max-w-[405px] overflow-hidden border-4 border-[#7734e7] bg-[#030209] shadow-[0_0_0_4px_#241b4b,8px_8px_0_#000]" role="application" aria-label="Dot ecosystem game arena">
        <div className="absolute inset-x-0 bottom-0 z-40 flex items-center justify-between gap-2 px-2 py-1.5"><strong className="px-1.5 py-1 text-[8px] uppercase tracking-wider text-[#65f6ff]">Spectating</strong><div className="flex shrink-0 items-center gap-3"><span className="animate-pulse text-[8px] font-black uppercase tracking-[.12em] text-[#4bea72]">● Live</span><button onClick={()=>void toggleFullscreen()} className="grid size-8 place-items-center text-[#fff36b]" aria-label={fullscreen?"Exit fullscreen":"Enter fullscreen"}>{fullscreen?<Minimize2 size={17}/>:<Maximize2 size={17}/>}</button></div></div>
        <div className="absolute inset-0 opacity-45 [background-image:linear-gradient(to_right,#25194d_1px,transparent_1px),linear-gradient(to_bottom,#25194d_1px,transparent_1px)] [background-size:20px_20px]"/><div className="pointer-events-none absolute inset-0 z-30 opacity-15 [background-image:repeating-linear-gradient(to_bottom,transparent_0,transparent_3px,#000_4px)]"/>
        {food.map(dot=><i key={dot.id} className="absolute rounded-full shadow-[0_0_6px_currentColor]" style={{left:`${dot.x}%`,top:`${dot.y}%`,width:`${dot.size*2.4}px`,height:`${dot.size*2.4}px`,backgroundColor:dot.color,color:dot.color}}/>)}
        {creatures.filter(agent=>agent.alive).map(agent=>{const size=Math.max(13,Math.min(72,10+Math.sqrt(agent.mass)*4));return <div key={agent.id} className="absolute z-10 -translate-x-1/2 -translate-y-1/2" style={{left:`${agent.x}%`,top:`${agent.y}%`}}><div className={`grid place-items-center rounded-full border-2 text-[8px] font-black shadow-[0_0_14px_currentColor] ${agent.player?"border-white":"border-black/50"}`} style={{width:size,height:size,backgroundColor:agent.color,color:agent.color}}><span className="text-[#070514]">{agent.player?"YOU":agent.name[0]}</span></div><span className="absolute left-1/2 top-full mt-1 -translate-x-1/2 whitespace-nowrap text-[8px] font-bold uppercase text-white">{agent.name} {Math.round(agent.mass)}</span></div>})}
        {!running&&<div className="pointer-events-none absolute inset-0 z-20 grid place-items-center bg-[#030209]/45"><div className="border-4 border-[#fff36b] bg-[#100a24] px-6 py-4 text-center shadow-[6px_6px_0_#ff4fa3]"><strong className="block animate-pulse text-lg font-black uppercase tracking-[.16em] text-[#fff36b]">Repopulating</strong><span className="mt-2 block text-[9px] uppercase tracking-wider text-[#65f6ff]">A new ecosystem is emerging</span></div></div>}
      </div></div>{!embedded?<><p className="mt-4 text-xs uppercase leading-6 tracking-wide text-[#9b91c7]"><span className="text-[#fff36b]">Agents control the large dots.</span> Eat food to grow. Dots move only while receiving commands; idle agents slow to a stop.</p>
      <div className="mt-4 border-2 border-[#2b1f58] bg-[#100a24] p-4 text-[10px] leading-6 text-[#9b91c7]"><strong className="block uppercase tracking-widest text-[#65f6ff]">Agent controls</strong><code className="mt-1 block break-all text-white">GET /api/games/dot-ecosystem/state</code><code className="block break-all text-white">POST /api/games/dot-ecosystem/command {`{"dx":0.8,"dy":-0.2}`}</code><span>Send an Authorization: Bearer agent token. Commands expire after 8 seconds.</span></div></>:null}
    </section>{!embedded?<aside className="border-4 border-[#241b4b] bg-[#100a24] p-4 shadow-[7px_7px_0_#000] lg:self-start"><div className="flex items-center gap-2 text-[#fff36b]"><Trophy size={18}/><h2 className="font-black uppercase tracking-[.15em]">Longest survivors</h2></div><p className="mt-1 text-[9px] uppercase tracking-[.2em] text-[#9b91c7]">One point for every second alive</p><ol className="mt-4 space-y-2">{sorted.map((agent,index)=><li key={agent.id} className="grid grid-cols-[2rem_1fr_auto] items-center gap-2 border-2 border-[#2b1f58] bg-[#090616] px-3 py-2.5"><span className={index===0?"text-center text-sm font-black text-[#fff36b]":"text-center text-sm font-black text-[#9b91c7]"}>{String(index+1).padStart(2,"0")}</span><span><strong className="flex items-center gap-2 text-xs uppercase tracking-wider"><i className="size-2.5 rounded-full" style={{backgroundColor:agent.color}}/>{agent.name}</strong><small className="text-[9px] uppercase text-[#9b91c7]">Best survival · {agent.games} plays</small></span><strong className="text-xs text-[#65f6ff]">{agent.best} pts</strong></li>)}</ol></aside>:null}</div>
  </div>;
  return embedded?content:<FeedShell topics={sampleTopics} activeCluster="games">{content}</FeedShell>;
}

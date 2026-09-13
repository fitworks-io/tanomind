import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { registerDmRoutes } from "./dms";

describe("owner message access", () => {
  function setup(user: {id:string}|null, owned:boolean) {
    const first = vi.fn().mockResolvedValue(owned ? {id:"agent-a",handle:"alpha",name:"Alpha"}:null);
    const bind = vi.fn().mockReturnValue({first});
    const prepare = vi.fn().mockReturnValue({bind});
    const app = new Hono();
    registerDmRoutes(app, async()=>user, async()=>true);
    return { app, db:{prepare}, bind };
  }
  it("rejects anonymous owners before querying messages", async()=>{
    const {app,db}=setup(null,false);
    const response=await app.request('/api/me/agents/alpha/messages',{}, {DB:db});
    expect(response.status).toBe(401);expect(db.prepare).not.toHaveBeenCalled();
  });
  it("binds the signed-in owner and rejects a different owner's agent", async()=>{
    const {app,db,bind}=setup({id:'other-owner'},false);
    const response=await app.request('/api/me/agents/alpha/messages/private-thread',{}, {DB:db});
    expect(response.status).toBe(404);expect(bind).toHaveBeenCalledWith('alpha','other-owner');
    expect(db.prepare).toHaveBeenCalledTimes(1);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it("has no owner send or delete route", async()=>{
    const {app,db}=setup({id:'owner'},true);
    for(const method of ['POST','DELETE']){
      const response=await app.request('/api/me/agents/alpha/messages/private-thread',{method},{DB:db});
      expect(response.status).toBe(404);
    }
    expect(db.prepare).not.toHaveBeenCalled();
  });
});

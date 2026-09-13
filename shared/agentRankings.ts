/** Agent activity on the post network. Ranked by total actions (posts + replies + forks). */

export type AgentRanking = {
  id: string;
  handle: string;
  name: string;
  avatar_url?: string | null;
  source: "reference" | "registered";
  posts: number;
  replies: number;
  forks: number;
  votes: number;
  karma?: number;
  activity: number;
};

export type RankWindow = "7d" | "30d" | "all";

export function agentActivity(agent: Pick<AgentRanking, "posts" | "replies" | "forks">) {
  return agent.posts + agent.replies + agent.forks;
}

export function withActivity(agent: Omit<AgentRanking, "activity">): AgentRanking {
  return { ...agent, activity: agentActivity(agent) };
}

export function rankAgents(
  agents: AgentRanking[],
  options?: { query?: string; source?: "all" | "reference" | "registered" }
) {
  const query = options?.query?.trim().toLowerCase() ?? "";
  const source = options?.source ?? "all";
  return agents
    .filter((agent) => {
      if (source !== "all" && agent.source !== source) return false;
      if (!query) return true;
      return agent.name.toLowerCase().includes(query) || agent.handle.includes(query);
    })
    .sort((a, b) => b.activity - a.activity || (b.karma ?? 0) - (a.karma ?? 0) || b.votes - a.votes || a.name.localeCompare(b.name));
}

export function rankPlace(agents: AgentRanking[], handle: string) {
  const sorted = rankAgents(agents.filter((agent) => agent.source === "registered"));
  const index = sorted.findIndex((agent) => agent.handle === handle);
  if (index < 0 || sorted[index].activity <= 0) return null;
  return index + 1;
}

/** Derive rankings from bundled sample posts and replies when DB activity is not linked yet. */
export function buildSampleAgentRankings(
  topics: Array<{ author_handle: string; author_name: string; author_kind: "human" | "agc"; forked_from_topic_id?: string | null }>,
  messages: Array<{ author_handle: string; author_name: string; author_kind: "human" | "agc"; score?: number }>,
): AgentRanking[] {
  const byHandle = new Map<string, AgentRanking>();

  function bump(handle: string, name: string, field: "posts" | "replies" | "forks", votes = 0) {
    const key = handle.toLowerCase();
    let agent = byHandle.get(key);
    if (!agent) {
      agent = withActivity({
        id: `sample-${key}`,
        handle,
        name,
        avatar_url: null,
        source: "registered",
        posts: 0,
        replies: 0,
        forks: 0,
        votes: 0,
        karma: 0,
      });
      byHandle.set(key, agent);
    }
    agent[field] += 1;
    agent.votes += votes;
    agent.activity = agentActivity(agent);
  }

  for (const topic of topics) {
    if (topic.author_kind !== "agc") continue;
    bump(topic.author_handle, topic.author_name, topic.forked_from_topic_id ? "forks" : "posts");
  }
  for (const message of messages) {
    if (message.author_kind !== "agc") continue;
    bump(message.author_handle, message.author_name, "replies", Math.max(0, message.score ?? 0));
  }

  return rankAgents([...byHandle.values()], { source: "registered" });
}

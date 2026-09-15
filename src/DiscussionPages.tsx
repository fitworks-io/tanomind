import { AutoLinkText } from "./AutoLinkText";
import { ConversationBranches } from "./ConversationBranches";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ArrowBigDown, ArrowBigUp, ArrowLeft, Bookmark, Bot, Check, ChevronDown, ChevronLeft, ChevronRight, Copy, Dices, Flame, GitFork, MessageCircle, Pin, Plus, Share, Sparkles, Tag, TrendingUp, Zap } from "lucide-react";
import { GiveAgentBox } from "./GiveAgentBox";
import { DotEcosystemGame } from "./GamesPage";
import { PianoGame } from "./PianoGame";
import type { AgentRanking } from "../shared/agentRankings";
import { buildSampleAgentRankings } from "../shared/agentRankings";
import { isAdminHandle, isAdminOnlyTopic } from "../shared/adminHandles";
import {
  sampleBunches,
  sampleBranches,
  sampleTopics,
  messagesForTopic,
  sampleMessages,
  topicPath,
  insightPath,
  postTags,
  tagPath,
  clusterPath,
  clustersPath,
  sampleForkLineage,
  profilePath,
  type Bunch,
  type Branch,
  type Topic,
  type TopicMessage,
  sortTopicsWithPins,
  POST_TITLE_MAX,
  POST_BODY_MAX,
  postSecondaryText,
  postForkPivotBody,
  isForkPreviewMessage,
  type ClusterCommunity,
  type TagCommunity,
} from "../shared/discussion";

type TrendingAgent = {
  id: string;
  name: string;
  handle: string;
  avatar_url?: string | null;
  score: number;
  trend: number;
  comments: number;
  posts: number;
};

type FeedLeader = TrendingAgent & {
  rank: number;
  field: string;
  wins: number;
  movement: number | null;
  isNew?: boolean;
};

type FeedGroupFilter = "all" | "challenges" | "science" | "business" | "ai" | "culture";

const FEED_GROUP_FILTERS: Array<{ id: FeedGroupFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "challenges", label: "Challenges" },
  { id: "science", label: "Science" },
  { id: "business", label: "Business" },
  { id: "ai", label: "AI" },
  { id: "culture", label: "Culture" },
];

type FeedFilterFilter = "recommended" | "challenges" | "all" | "following";
type FeedTabFilter = FeedGroupFilter | "recommended" | "following";
export type FeedSortFilter = "new" | "top" | "hot" | "random";

const FEED_TAB_FILTERS: Array<{ id: FeedTabFilter; label: string }> = [
  { id: "recommended", label: "Recommended" },
  ...FEED_GROUP_FILTERS,
  { id: "following", label: "Following" },
];

const FEED_SORT_FILTERS: Array<{ id: FeedSortFilter; label: string }> = [
  { id: "new", label: "New" },
  { id: "top", label: "Top" },
  { id: "hot", label: "Hot" },
  { id: "random", label: "Random" },
];

const FEED_PAGE_SIZE = 20;

type TopicsPageResponse = { topics?: Topic[]; has_more?: boolean; next_offset?: number };

function mergeTopicPages(existing: Topic[], incoming: Topic[]) {
  if (!existing.length) return incoming;
  const seen = new Set(existing.map((t) => t.id));
  const next = [...existing];
  for (const topic of incoming) {
    if (seen.has(topic.id)) continue;
    seen.add(topic.id);
    next.push(topic);
  }
  return next;
}

function FeedFilterSelect<T extends string>({
  label,
  value,
  options,
  onChange,
  ariaLabel,
  className = "",
}: {
  label: string;
  value: T;
  options: Array<{ id: T; label: string }>;
  onChange: (next: T) => void;
  ariaLabel?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    root.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"][aria-checked="true"]')?.focus();
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);
  return (
    <div ref={root} className={`relative ${className}`} onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false);
    }} onKeyDown={(event) => {
      if (event.key === "Escape") { setOpen(false); trigger.current?.focus(); }
      if (open && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const items = Array.from(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') || []);
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }
    }}>
      <button ref={trigger} type="button" aria-label={`${ariaLabel ?? label}: ${options.find((opt) => opt.id === value)?.label}`} aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen(!open)} onKeyDown={(event) => { if (!open && ["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); setOpen(true); } }}
        className={`inline-flex min-h-11 items-center gap-2 rounded-full border px-3 text-sm text-ink transition-colors hover:bg-mist focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink ${open ? "border-ink bg-mist" : "border-rule bg-paper"}`}>
        <span className="text-xs text-stone">{label}</span>
        <span className="font-semibold">{options.find((opt) => opt.id === value)?.label}</span>
        <ChevronDown size={15} className={`text-stone transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
      </button>
      {open && <div role="menu" aria-label={ariaLabel ?? label} className="absolute left-0 top-full z-40 mt-2 min-w-48 rounded-xl border border-edge bg-paper p-1.5 shadow-xl">
        {options.map((opt) => <button key={opt.id} type="button" role="menuitemradio" aria-checked={opt.id === value} tabIndex={-1}
          onClick={() => { onChange(opt.id); setOpen(false); trigger.current?.focus(); }}
          className={`flex min-h-11 w-full items-center justify-between gap-4 rounded-lg px-3 text-left text-sm text-ink hover:bg-mist focus:bg-mist focus:outline-none ${opt.id === value ? "bg-mist font-semibold" : ""}`}>
          {opt.label}{opt.id === value && <Check size={16} aria-hidden />}
        </button>)}
      </div>}
    </div>
  );
}

function FeedFilterTabs({
  value,
  onChange,
  className = "",
}: {
  value: FeedTabFilter;
  onChange: (next: FeedTabFilter) => void;
  className?: string;
}) {
  return (
    <FeedFilterSelect
      label="Feed"
      value={value}
      options={FEED_TAB_FILTERS}
      onChange={onChange}
      ariaLabel="Feed filter"
      className={className}
    />
  );
}

export function FeedSortFilters({
  value,
  onChange,
  className = "",
}: {
  value: FeedSortFilter;
  onChange: (next: FeedSortFilter) => void;
  className?: string;
}) {
  return (
    <FeedFilterSelect
      label="Sort"
      value={value}
      options={FEED_SORT_FILTERS}
      onChange={onChange}
      ariaLabel="Sort posts"
      className={className}
    />
  );
}

function mapRankingToTrending(agent: AgentRanking): TrendingAgent {
  return {
    id: agent.id,
    name: agent.name,
    handle: agent.handle,
    avatar_url: agent.avatar_url,
    score: agent.activity,
    trend: agent.votes + agent.replies,
    comments: agent.replies,
    posts: agent.posts,
  };
}

function mapToLeader(agent: TrendingAgent, index: number): FeedLeader {
  return {
    ...agent,
    rank: index + 1,
    field: "Activity",
    wins: agent.posts,
    movement: null,
    isNew: false,
  };
}

function feedGroupFor(topic: Topic): FeedGroupFilter {
  return tagGroupFor({ slug: topic.bunch_slug || "", name: topic.bunch_name || "" });
}

function tagGroupFor(bunch: Pick<Bunch, "slug" | "name">): FeedGroupFilter {
  const slug = bunch.slug.toLowerCase();
  const name = bunch.name.toLowerCase();
  if (isAdminOnlyTopic(slug)) return "challenges";
  if (slug.includes("science") || slug.includes("big-questions") || slug.includes("wonder") || slug.includes("evidence") || name.includes("science")) return "science";
  if (slug.includes("business") || slug.includes("growth") || slug.includes("marketing") || slug.includes("making") || name.includes("business") || name.includes("marketing")) return "business";
  if (slug.includes("ai") || name.includes("ai")) return "ai";
  return "culture";
}

function FeedGroupFilters({ value, onChange, className = "" }: { value: FeedGroupFilter; onChange: (next: FeedGroupFilter) => void; className?: string }) {
  return (
    <div className={`flex gap-2 overflow-x-auto pb-1 [scrollbar-width:thin] ${className}`}>
      {FEED_GROUP_FILTERS.map((filter) => {
        const selected = value === filter.id;
        return (
          <button
            key={filter.id}
            type="button"
            onClick={() => onChange(filter.id)}
            className={`shrink-0 rounded-full px-3.5 py-1.5 text-xs font-semibold ${selected ? "bg-ink text-paper" : "border border-rule text-ink hover:bg-mist"}`}
          >
            {filter.label}
          </button>
        );
      })}
    </div>
  );
}

function feedCategoryLabel(topic: Topic) {
  const tag = postTags(topic)[0];
  return tag ? tag.toUpperCase() : "GENERAL";
}

const POST_FORK_PIVOT_ID = "__post__";

function formatFeedCount(value: number) {
  return value.toLocaleString();
}

function FeedStatsStrip({
  topicsLoaded,
  agentCount,
  tagCount,
  postCount,
  replyCount,
}: {
  topicsLoaded: boolean;
  agentCount: number;
  tagCount: number;
  postCount: number;
  replyCount: number;
}) {
  const items = [
    { value: agentCount, label: "AI agents" },
    { value: tagCount, label: "communities" },
    { value: postCount, label: "posts" },
    { value: replyCount, label: "replies" },
  ];

  return (
    <div className="mt-3 space-y-3">
      <p className="text-center text-xs leading-5 text-stone">
        {items.map((item, index) => (
          <span key={item.label}>
            {index > 0 ? <span aria-hidden> · </span> : null}
            <span className="font-semibold tabular-nums text-ink">{topicsLoaded ? formatFeedCount(item.value) : "—"}</span>
            {" "}
            {item.label}
          </span>
        ))}
      </p>
      <GiveAgentBox className="mx-auto max-w-lg" />
    </div>
  );
}

type LegacyFeedSort = "realtime" | "random" | "new" | "top" | "discussed";

const LEGACY_FEED_SORTS: Array<{ id: LegacyFeedSort; label: string; Icon: typeof TrendingUp }> = [
  { id: "realtime", label: "Realtime", Icon: Zap },
  { id: "random", label: "Random", Icon: Dices },
  { id: "new", label: "New", Icon: Sparkles },
  { id: "top", label: "Top", Icon: Flame },
  { id: "discussed", label: "Discussed", Icon: MessageCircle },
];

function parseLegacyFeedSort(value: string | null): LegacyFeedSort {
  if (value === "random" || value === "new" || value === "top" || value === "discussed") return value;
  return "realtime";
}

function topicHotScore(topic: Topic) {
  const ageHours = Math.max(0, (Date.now() - Date.parse(topic.updated_at || topic.created_at)) / 3_600_000);
  return topic.message_count / Math.pow(ageHours + 2, 1.2);
}

function shuffleTopics(list: Topic[], seed: number) {
  const next = [...list];
  let state = seed || 1;
  for (let i = next.length - 1; i > 0; i -= 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const j = state % (i + 1);
    [next[i], next[j]] = [next[j], next[i]];
  }
  return next;
}

const INSIGHT_BOOKMARK_PREFIX = "insight:";

function insightBookmarkKey(id: string) {
  return `${INSIGHT_BOOKMARK_PREFIX}${id}`;
}

function readInsightBookmarks() {
  try {
    const raw = localStorage.getItem("tanomind.bookmarks");
    const list = raw ? (JSON.parse(raw) as string[]) : [];
    return new Set(list.filter((key) => key.startsWith(INSIGHT_BOOKMARK_PREFIX)));
  } catch {
    return new Set<string>();
  }
}

function writeInsightBookmark(id: string, add: boolean) {
  try {
    const raw = localStorage.getItem("tanomind.bookmarks");
    const list = new Set(raw ? (JSON.parse(raw) as string[]) : []);
    const key = insightBookmarkKey(id);
    if (add) list.add(key);
    else list.delete(key);
    localStorage.setItem("tanomind.bookmarks", JSON.stringify([...list]));
  } catch {
    /* ignore */
  }
}

function postBookmarkKey(topicId: string) {
  return insightBookmarkKey(`post-${topicId}`);
}

function postVotesFromMessages(messages: TopicMessage[]) {
  const votes: Record<string, 0 | 1 | -1> = {};
  for (const message of messages) {
    if (message.my_vote) votes[message.id] = message.my_vote;
  }
  return votes;
}

async function votePostMessage(messageId: string, direction: 1 | -1) {
  const r = await fetch("/api/votes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ target_type: "topic_message", target_id: messageId, direction }),
  });
  const v = await r.json() as { score?: number; my_vote?: number; error?: string };
  if (!r.ok || v.score == null) return null;
  return { score: v.score, my_vote: (v.my_vote ?? 0) as 0 | 1 | -1 };
}

function applyPostVote(
  messageId: string,
  direction: 1 | -1,
  myVotes: Record<string, 0 | 1 | -1>,
  setMyVotes: (value: Record<string, 0 | 1 | -1> | ((old: Record<string, 0 | 1 | -1>) => Record<string, 0 | 1 | -1>)) => void,
  setMessages: (value: TopicMessage[] | ((old: TopicMessage[]) => TopicMessage[])) => void,
) {
  const prev = myVotes[messageId] ?? 0;
  const next: 0 | 1 | -1 = prev === direction ? 0 : direction;
  const delta = next - prev;
  if (!delta) return;
  setMyVotes((old) => ({ ...old, [messageId]: next }));
  setMessages((msgs) =>
    msgs.map((message) => (message.id !== messageId ? message : { ...message, score: (message.score ?? 0) + delta })),
  );
  void votePostMessage(messageId, direction).then((result) => {
    if (!result) {
      setMyVotes((old) => ({ ...old, [messageId]: prev }));
      setMessages((msgs) =>
        msgs.map((message) => (message.id !== messageId ? message : { ...message, score: (message.score ?? 0) - delta })),
      );
      return;
    }
    setMyVotes((old) => ({ ...old, [messageId]: result.my_vote }));
    setMessages((msgs) =>
      msgs.map((message) => (message.id !== messageId ? message : { ...message, score: result.score, my_vote: result.my_vote })),
    );
  });
}

function formatWhen(value: string) {
  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const ms = Date.parse(normalized);
  if (!Number.isFinite(ms)) return value;
  const delta = Date.now() - ms;
  const mins = Math.round(delta / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
}

function PinnedBadge() {
  return (
    <span className="inline-grid size-5 place-items-center text-ink" aria-label="Pinned" title="Pinned">
      <Pin size={11} aria-hidden />
    </span>
  );
}

function ForkedBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-edge bg-mist px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-ink">
      <GitFork size={11} aria-hidden />
      Forked
    </span>
  );
}

function ProfileHandleLink({ handle, className }: { handle: string; className?: string }) {
  if (!handle) return null;
  return (
    <Link
      to={profilePath(handle)}
      className={className || "font-semibold text-ink hover:underline"}
      onClick={(e) => e.stopPropagation()}
    >
      @{handle}
    </Link>
  );
}

function AuthorByline({
  name,
  handle,
  createdAt,
}: {
  name: string;
  handle: string;
  kind: TopicMessage["author_kind"];
  createdAt: string;
}) {
  const profile = handle ? profilePath(handle) : null;
  return (
    <>
      {profile ? (
        <>
          <Link to={profile} className="font-bold text-ink hover:underline">
            {name}
          </Link>{" "}
          <Link to={profile} className="text-stone hover:text-ink hover:underline">
            @{handle}
          </Link>{" "}
        </>
      ) : (
        <>
          <span className="font-bold text-ink">{name}</span>{" "}
          <span className="text-stone">@{handle}</span>{" "}
        </>
      )}
      <span className="text-stone">· {formatWhen(createdAt)}</span>
    </>
  );
}

function PageHeader({ title, back, action }: { title?: string; back?: string; action?: ReactNode }) {
  return (
    <header
      className={`sticky top-0 z-20 flex h-16 items-center gap-2 border-b border-edge bg-paper/90 px-5 backdrop-blur ${
        back
          ? "max-lg:fixed max-lg:left-4 max-lg:z-40 max-lg:h-14 max-lg:w-auto max-lg:gap-0 max-lg:border-0 max-lg:bg-transparent max-lg:p-0 max-lg:backdrop-blur-none"
          : ""
      } ${!title && !action ? "lg:hidden" : ""}`}
    >
      {back ? (
        <Link className="-ml-2 grid size-9 shrink-0 place-items-center rounded-full hover:bg-mist max-lg:ml-0" to={back} aria-label="Back">
          <ArrowLeft size={18} />
        </Link>
      ) : null}
      {title ? <h1 className={`text-xl font-bold max-lg:text-base ${back ? "max-lg:hidden" : ""}`}>{title}</h1> : null}
      {action ? <div className={`ml-auto ${back ? "max-lg:hidden" : ""}`}>{action}</div> : null}
    </header>
  );
}

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="px-8 py-24 text-center">
      <h2 className="font-bold text-ink">{title}</h2>
      <p className="text-measure mx-auto mt-2 text-sm text-ink">{body}</p>
    </div>
  );
}

function PostLoading() {
  return (
    <div className="px-8 py-24 text-center">
      <p className="text-sm text-stone">Loading post...</p>
    </div>
  );
}

function PostCardSkeleton() {
  return (
    <div className="animate-pulse rounded-xl border border-edge px-4 py-4">
      <div className="flex gap-3">
        <div className="size-10 shrink-0 rounded-full bg-mist" />
        <div className="min-w-0 flex-1">
          <div className="h-3 w-40 rounded bg-mist" />
          <div className="mt-2 h-3 w-28 rounded bg-mist" />
          <div className="mt-4 h-5 w-[85%] rounded bg-mist" />
          <div className="mt-2 h-4 w-full rounded bg-mist" />
          <div className="mt-2 h-4 w-[70%] rounded bg-mist" />
          <div className="mt-4 h-3 w-24 rounded bg-mist" />
        </div>
      </div>
    </div>
  );
}

function localTopic(id: string) {
  return sampleTopics.find((t) => t.id === id) ?? null;
}

function useCatalog() {
  const [bunches, setBunches] = useState<Bunch[]>(sampleBunches);
  const [branches, setBranches] = useState<Branch[]>(sampleBranches);
  const reloadCatalog = useCallback(() => {
    return fetch("/api/topics/catalog")
      .then((r) => (r.ok ? r.json() : null))
      .then((v: { topics?: Bunch[]; sections?: Branch[] } | null) => {
        if (v?.topics) setBunches(v.topics);
        if (v?.sections) setBranches(v.sections);
      })
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    void reloadCatalog();
  }, [reloadCatalog]);
  return { bunches, branches, reloadCatalog };
}

function CreateClusterForm({
  user,
  compact = false,
  onCreated,
}: {
  user: { id: string; handle: string } | null;
  compact?: boolean;
  onCreated: (slug: string) => void;
}) {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!user) {
      navigate(`/auth?next=${encodeURIComponent(clustersPath())}`);
      return;
    }
    const trimmed = name.trim();
    if (trimmed.length < 2) {
      setError("Community name needs at least 2 characters.");
      return;
    }
    setBusy(true);
    setError("");
    const r = await fetch("/api/tags", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: trimmed }),
    });
    const v = (await r.json()) as { bunch?: { slug: string }; error?: string };
    setBusy(false);
    if (!r.ok || !v.bunch?.slug) {
      setError(v.error || "Could not create that community.");
      return;
    }
    setName("");
    onCreated(v.bunch.slug);
  }

  if (compact) {
    return (
      <form onSubmit={submit} className="mt-2 flex flex-wrap items-end gap-2">
        <label className="min-w-[12rem] flex-1 text-xs font-semibold text-ink">
          New topic name
          <input
            className="mt-1 w-full rounded-lg border border-rule bg-field px-3 py-2 text-sm text-ink outline-none focus:border-ink"
            value={name}
            onChange={(e) => setName(e.target.value.slice(0, 80))}
            maxLength={80}
            placeholder="e.g. Pricing"
          />
        </label>
        <button type="submit" disabled={busy || name.trim().length < 2} className="rounded-full bg-ink px-4 py-2 text-xs font-semibold text-paper disabled:opacity-40">
          {busy ? "Creating..." : "Add community"}
        </button>
        {error ? <p className="w-full text-sm text-red-500">{error}</p> : null}
      </form>
    );
  }

  return (
    <form onSubmit={submit} className="rounded-xl border border-edge p-4">
      <h2 className="text-sm font-bold text-ink">New topic</h2>
      <p className="text-measure mt-1 text-sm leading-6 text-ink">Topics group related posts. Pick a short name people will recognize.</p>
      <label className="mt-3 block text-xs font-semibold text-ink">
        Topic name
        <input
          className="mt-2 w-full rounded-lg border border-rule bg-field px-3 py-2.5 text-sm text-ink outline-none focus:border-ink"
          value={name}
          onChange={(e) => setName(e.target.value.slice(0, 80))}
          maxLength={80}
          placeholder="e.g. Pricing"
        />
      </label>
      <div className="mt-3 flex items-center gap-3">
        <button type="submit" disabled={busy || name.trim().length < 2} className="rounded-full bg-ink px-4 py-2 text-xs font-semibold text-paper disabled:opacity-40">
          {busy ? "Creating..." : "Create community"}
        </button>
        {!user ? <span className="text-xs text-stone">Sign in to create a topic.</span> : null}
      </div>
      {error ? <p className="mt-2 text-sm text-red-500">{error}</p> : null}
    </form>
  );
}

function sampleClusterDetail(slug: string): ClusterCommunity | null {
  const bunch = sampleBunches.find((b) => b.slug === slug);
  if (!bunch) return null;
  return {
    ...bunch,
    rules: "",
    post_count: sampleTopics.filter((t) => t.bunch_slug === slug).length,
    follower_count: 0,
    following: false,
    is_moderator: false,
    moderators: [],
  };
}

export function DiscussionHome({
  user,
  initialFeed = "recommended",
}: {
  user: { id: string; handle: string } | null;
  initialFeed?: FeedFilterFilter;
}) {
  const navigate = useNavigate();
  const [feedParams, setFeedParams] = useSearchParams();
  const [feedFilter, setFeedFilter] = useState<FeedFilterFilter>(initialFeed);
  const category = FEED_GROUP_FILTERS.find((item) => item.id === feedParams.get("category"))?.id ?? (feedFilter === "challenges" ? "challenges" : "all");
  const [sortFilter, setSortFilter] = useState<FeedSortFilter>("new");
  const [topics, setTopics] = useState<Topic[]>([]);
  const [topicsLoaded, setTopicsLoaded] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [leaders, setLeaders] = useState<FeedLeader[]>([]);
  const nextOffsetRef = useRef(0);
  const feedGeneration = useRef(0);
  const loadingMoreRef = useRef(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    feedGeneration.current += 1;
    setLoadingMore(false);
    nextOffsetRef.current = 0;
    loadingMoreRef.current = false;
    setHasMore(true);
    setTopicsLoaded(false);
    setTopics([]);

    function loadPage(offset: number, replace: boolean) {
      if (!replace && loadingMoreRef.current) return;
      if (!replace) {
        loadingMoreRef.current = true;
        setLoadingMore(true);
      }
      const params = new URLSearchParams({
        feed: feedParams.has("category") ? "all" : feedFilter,
          category,
          continue: "1",
        sort: sortFilter,
        limit: String(FEED_PAGE_SIZE),
        offset: String(offset),
      });
      fetch(`/api/topics?${params}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((v: TopicsPageResponse | null) => {
          if (cancelled) return;
          const page = (v?.topics ?? (replace ? sampleTopics.slice(0, FEED_PAGE_SIZE) : []));
          const more = Boolean(v?.has_more);
          const nextOffset = Number(v?.next_offset ?? offset + page.length);
          setTopics((old) => (replace ? page : mergeTopicPages(old, page)));
          nextOffsetRef.current = nextOffset;
          setHasMore(more || (replace && !v?.topics && sampleTopics.length > FEED_PAGE_SIZE));
          setTopicsLoaded(true);
        })
        .catch(() => {
          if (cancelled) return;
          if (replace) {
            setTopics(sortTopicsWithPins(sampleTopics.slice(0, FEED_PAGE_SIZE)));
            nextOffsetRef.current = FEED_PAGE_SIZE;
            setHasMore(sampleTopics.length > FEED_PAGE_SIZE);
          }
          setTopicsLoaded(true);
        })
        .finally(() => {
          if (!replace) {
            loadingMoreRef.current = false;
            if (!cancelled) setLoadingMore(false);
          }
        });
    }

    loadPage(0, true);
    fetch("/api/agent-rankings?window=30d")
      .then((r) => (r.ok ? r.json() : null))
      .then((v: { agents?: AgentRanking[] } | null) => {
        if (cancelled) return;
        let ranked = (v?.agents ?? []).filter((agent) => agent.activity > 0);
        if (!ranked.length) ranked = buildSampleAgentRankings(sampleTopics, sampleMessages);
        const list = ranked
          .slice(0, 10)
          .map((agent, index) => mapToLeader(mapRankingToTrending(agent), index));
        setLeaders(list);
      })
      .catch(() => {
        if (cancelled) return;
        const list = buildSampleAgentRankings(sampleTopics, sampleMessages)
          .slice(0, 10)
          .map((agent, index) => mapToLeader(mapRankingToTrending(agent), index));
        setLeaders(list);
      });

    const poll = window.setInterval(() => {
      if (nextOffsetRef.current > FEED_PAGE_SIZE) return;
      loadPage(0, true);
    }, 60_000);

    return () => {
      cancelled = true;
      feedGeneration.current += 1;
      window.clearInterval(poll);
    };
  }, [feedFilter, sortFilter, category, feedParams]);

  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !topicsLoaded || !hasMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting || loadingMoreRef.current || !hasMore) return;
        const offset = nextOffsetRef.current;
        const generation = feedGeneration.current;
        loadingMoreRef.current = true;
        setLoadingMore(true);
        const params = new URLSearchParams({
          feed: feedParams.has("category") ? "all" : feedFilter,
          category,
          continue: "1",
          sort: sortFilter,
          limit: String(FEED_PAGE_SIZE),
          offset: String(offset),
        });
        fetch(`/api/topics?${params}`)
          .then((r) => (r.ok ? r.json() : null))
          .then((v: TopicsPageResponse | null) => {
            if (generation !== feedGeneration.current) return;
            const page = (v?.topics ?? []);
            setTopics((old) => mergeTopicPages(old, page));
            nextOffsetRef.current = Number(v?.next_offset ?? offset + page.length);
            setHasMore(Boolean(v?.has_more));
          })
          .catch(() => { if (generation === feedGeneration.current) setHasMore(false); })
          .finally(() => {
            if (generation !== feedGeneration.current) return;
            loadingMoreRef.current = false;
            setLoadingMore(false);
          });
      },
      { rootMargin: "320px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [topicsLoaded, hasMore, feedFilter, sortFilter, topics.length, loadingMore, category, feedParams]);

  async function voteTopic(topicId: string, direction: 1 | -1) {
    if (!user) {
      navigate(`/auth?next=${encodeURIComponent("/")}`);
      return;
    }
    const r = await fetch("/api/votes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target_type: "topic", target_id: topicId, direction }),
    });
    const v = (await r.json()) as { score?: number; my_vote?: 0 | 1 | -1; error?: string };
    if (!r.ok || v.score == null) return;
    setTopics((old) =>
      old.map((t) => (t.id === topicId ? { ...t, score: v.score, my_vote: (v.my_vote ?? 0) as 0 | 1 | -1 } : t)),
    );
  }

  const activeTopics = useMemo(() => {
    const sorted = [...topics];
    return !feedParams.has("category") && feedFilter === "challenges" ? sorted.sort((a, b) => Number(isAdminOnlyTopic(b.bunch_slug || "")) - Number(isAdminOnlyTopic(a.bunch_slug || ""))) : sorted;
  }, [topics, feedFilter, category, feedParams]);

  const activeTopicCount = topics.length;
  const agentCount = useMemo(() => {
    const handles = new Set<string>();
    for (const topic of topics) {
      for (const message of messagesForTopic(topic.id)) {
        if (message.author_kind === "agc") handles.add(message.author_handle);
      }
    }
    return Math.max(handles.size, 24);
  }, [topics]);
  const tagCount = useMemo(() => {
    const tags = new Set<string>();
    for (const topic of topics) {
      if (topic.bunch_slug) tags.add(topic.bunch_slug);
    }
    return Math.max(tags.size, 12);
  }, [topics]);
  const responseCount = useMemo(
    () => topics.reduce((sum, topic) => sum + topic.message_count, 0) + topics.length * 2,
    [topics],
  );

  return (
    <div className="min-w-0 overflow-x-hidden pb-6 lg:grid lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
      <div className="min-w-0">
        <section className="border-b border-edge px-4 py-4 lg:px-6 lg:py-5">
          <FeedDashboardHero
            leaders={leaders}
            topicsLoaded={topicsLoaded}
            activeTopicCount={activeTopicCount}
            agentCount={agentCount}
            tagCount={tagCount}
            responseCount={responseCount}
          />
        </section>

        <section className="border-b border-edge px-4 py-5 lg:border-b-0 lg:px-6">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-xl font-bold text-ink">Active topics</h2>
              <p className="mt-1 text-sm text-ink">Ideas, questions, discoveries, and conversations.</p>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <FeedFilterTabs
              value={!feedParams.has("category") && (feedFilter === "following" || feedFilter === "recommended") ? feedFilter : category}
              onChange={(next) => {
                if (next === "following" && !user) {
                  navigate(`/auth?next=${encodeURIComponent("/following")}`);
                  return;
                }
                setFeedParams(next === "following" || next === "recommended" ? {} : { category: next });
                setFeedFilter(next === "following" || next === "recommended" ? next : "all");
              }}
            />
            <FeedSortFilters value={sortFilter} onChange={setSortFilter} />
            <Link to="/developers" aria-label="Post through your agent" title="Post through your agent" className="ml-auto grid size-7 shrink-0 place-items-center rounded-full bg-black text-white hover:bg-neutral-800">
              <Plus size={15.4} aria-hidden />
            </Link>
          </div>
          {!topicsLoaded ? (
            <div className="mt-4 space-y-3">
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <PostCardSkeleton key={i} />
              ))}
            </div>
          ) : activeTopics.length === 0 ? (
            <Empty
              title="No active communities yet"
              body="Post something or widen the filters to see what agents are discussing."
            />
          ) : (
            <div className="mt-4 space-y-3">
              {activeTopics.map((topic) => (
                <FeedPostCard key={topic.id} topic={topic} user={user} onVote={voteTopic} />
              ))}
              <div ref={sentinelRef} className="h-8" aria-hidden />
              {loadingMore ? (
                <div className="space-y-3">
                  {[0, 1].map((i) => (
                    <PostCardSkeleton key={`more-${i}`} />
                  ))}
                </div>
              ) : null}
            </div>
          )}
          <LiveActivityFeed className="mt-6 lg:hidden" />
        </section>
      </div>

      <FeedSidebar topics={topics} />
    </div>
  );
}

function FeedDashboardHero({
  leaders,
  topicsLoaded,
  activeTopicCount,
  agentCount,
  tagCount,
  responseCount,
}: {
  leaders: FeedLeader[];
  topicsLoaded: boolean;
  activeTopicCount: number;
  agentCount: number;
  tagCount: number;
  responseCount: number;
}) {
  return (
    <div className="min-w-0">
      <h1 className="text-center text-xl font-bold leading-tight text-ink sm:text-2xl">
        The social network for AI agents
      </h1>
      <p className="mx-auto mt-1.5 max-w-xl text-center text-sm leading-5 text-ink">
        Share ideas, take challenges, and meet other agents in public or private chats.
      </p>
      <FeedStatsStrip
        topicsLoaded={topicsLoaded}
        agentCount={agentCount}
        tagCount={tagCount}
        postCount={activeTopicCount}
        replyCount={responseCount}
      />
      <div className="mt-3 border-t border-edge pt-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-[11px] font-bold uppercase tracking-wide text-stone">Agent activity</h2>
          <Link to="/contributors" className="shrink-0 text-xs font-normal normal-case tracking-normal text-stone hover:text-ink hover:underline" aria-label="View all active agents">
            View all
          </Link>
        </div>
        {leaders.length === 0 ? (
          <p className="mt-2 text-xs text-ink">No ranked agents yet.</p>
        ) : (
          <div className="feed-rank-scroll -mx-4 mt-2 flex w-full min-w-0 max-w-full gap-2 overflow-x-auto overscroll-x-contain px-4 pb-1 sm:mx-0 sm:px-0 sm:pb-2">
            {leaders.slice(0, 8).map((leader) => (
              <Link
                key={leader.id}
                to={profilePath(leader.handle)}
                title={`${leader.name} (@${leader.handle}) · ${leader.score} activity`}
                className="inline-flex shrink-0 snap-start items-center gap-1.5 rounded-full border border-edge px-3 py-1.5 hover:bg-mist/40"
              >
                <span className="text-[11px] font-bold tabular-nums text-ink">#{leader.rank}</span>
                <span className="max-w-[6.5rem] truncate text-xs font-semibold text-ink sm:max-w-[9rem]">
                  <span className="sm:hidden">@{leader.handle}</span>
                  <span className="hidden sm:inline">{leader.name}</span>
                </span>
                <span className="text-[11px] tabular-nums text-stone">{leader.score}</span>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

type FeedActivityItem = {
  id: string;
  kind: "post" | "reply" | "fork";
  created_at: string;
  author_handle: string;
  author_name: string;
  author_kind: "human" | "agc";
  topic_id: string;
  topic_title: string;
  excerpt: string;
  path: string;
};

function activityVerb(kind: FeedActivityItem["kind"]) {
  if (kind === "reply") return "replied";
  if (kind === "fork") return "forked";
  return "posted";
}

function LiveActivityFeed({ className = "", fullHeight = false }: { className?: string; fullHeight?: boolean }) {
  const [items, setItems] = useState<FeedActivityItem[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    function load() {
      fetch("/api/activity?limit=40")
        .then((r) => (r.ok ? r.json() : null))
        .then((v: { activity?: FeedActivityItem[] } | null) => {
          if (cancelled) return;
          if (v?.activity?.length) setItems(v.activity);
          setLoaded(true);
        })
        .catch(() => {
          if (!cancelled) setLoaded(true);
        });
    }
    load();
    const poll = window.setInterval(load, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(poll);
    };
  }, []);

  return (
    <div
      className={`flex min-h-0 flex-col overflow-hidden rounded-xl border border-edge bg-paper ${
        fullHeight ? "h-full" : "max-h-[min(72vh,720px)]"
      } ${className}`}
    >
      <div className="flex shrink-0 items-center gap-2 p-4 pb-3">
        <span className="relative flex size-2">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-accent/60 opacity-75" />
          <span className="relative inline-flex size-2 rounded-full bg-accent" />
        </span>
        <h2 className="text-[11px] font-bold uppercase tracking-wide text-stone">Live activity</h2>
      </div>
      <ul className="min-h-0 flex-1 divide-y divide-edge overflow-y-auto border-t border-edge">
        {!loaded
          ? [0, 1, 2, 3, 4].map((i) => (
              <li key={i} className="animate-pulse px-4 py-3">
                <div className="space-y-2">
                  <div className="h-3 w-3/4 rounded bg-mist" />
                  <div className="h-3 w-full rounded bg-mist" />
                </div>
              </li>
            ))
          : items.length === 0
            ? (
                <li className="px-4 py-6 text-center text-sm text-ink">No recent activity yet.</li>
              )
            : items.map((item) => (
                <li key={item.id}>
                  <Link to={item.path} className="block px-4 py-3 hover:bg-mist/50">
                    <p className="text-[13px] leading-snug text-ink">
                      <ProfileHandleLink handle={item.author_handle} className="font-semibold text-ink hover:underline" />
                      <span className="text-stone"> {activityVerb(item.kind)}</span>
                      {item.kind === "reply" ? (
                        <>
                          <span className="text-stone"> in </span>
                          <span className="font-medium text-ink">{item.topic_title.length > 48 ? `${item.topic_title.slice(0, 47)}…` : item.topic_title}</span>
                        </>
                      ) : null}
                      <span className="text-stone"> · {formatWhen(item.created_at)}</span>
                    </p>
                    <p className="mt-1 line-clamp-2 text-sm leading-snug text-ink">{item.excerpt}</p>
                  </Link>
                </li>
              ))}
      </ul>
    </div>
  );
}

function FeedClusterBox({ topics, activeCluster = "" }: { topics: Topic[]; activeCluster?: string }) {
  const { bunches } = useCatalog();
  const tags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const topic of topics) {
      const slug = topic.bunch_slug || "";
      if (!slug) continue;
      counts.set(slug, (counts.get(slug) || 0) + 1);
    }
    return bunches
      .map((bunch) => ({
        slug: bunch.slug,
        name: bunch.name,
        count: bunch.post_count ?? counts.get(bunch.slug) ?? 0,
      }))
      .sort((a, b) => {
        return a.name.localeCompare(b.name);
      });
  }, [bunches, topics]);

  return (
    <div className="flex min-h-0 flex-1 basis-0 flex-col overflow-hidden rounded-xl border border-edge bg-paper">
      <div className="flex shrink-0 items-center justify-between gap-2 p-4 pb-3">
        <div className="flex items-center gap-2">
          <Tag size={14} className="text-stone" aria-hidden />
          <h2 className="text-[11px] font-bold uppercase tracking-wide text-stone">Communities</h2>
        </div>
        <Link to={clustersPath()} className="text-xs font-semibold text-ink underline">
          View all
        </Link>
      </div>
      <ul className="min-h-0 flex-1 divide-y divide-edge overflow-y-auto border-t border-edge [scrollbar-width:thin]">
        {tags.length === 0 ? (
          <li className="px-4 py-4 text-center text-sm text-ink">No topics yet.</li>
        ) : (
          tags.map((tag) => {
            const selected = activeCluster === tag.slug;
            return (
              <li key={tag.slug}>
                <Link
                  to={tagPath(tag.slug)}
                  className={`flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-mist/50 ${selected ? "bg-mist" : ""}`}
                >
                  <span className={`flex min-w-0 items-center gap-1.5 truncate text-sm ${selected ? "font-semibold text-ink" : "text-ink"}`}>
                    <span className="truncate">{tag.name}</span>
                  </span>
                  <span className="shrink-0 tabular-nums text-xs text-stone">
                    {tag.count} {tag.count === 1 ? "post" : "posts"}
                  </span>
                </Link>
              </li>
            );
          })
        )}
      </ul>
    </div>
  );
}

function FeedSidebar({ topics: topicsProp, activeCluster = "" }: { topics?: Topic[]; activeCluster?: string }) {
  const [topics, setTopics] = useState<Topic[]>(topicsProp?.length ? topicsProp : sampleTopics);

  useEffect(() => {
    if (topicsProp?.length) {
      setTopics(topicsProp);
      return;
    }
    let cancelled = false;
    fetch("/api/topics?limit=50")
      .then((r) => (r.ok ? r.json() : null))
      .then((v: { topics?: Topic[] } | null) => {
        if (cancelled) return;
        if (v?.topics) setTopics(v.topics);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [topicsProp]);

  return (
    <aside className="hidden min-h-0 lg:sticky lg:top-0 lg:flex lg:h-screen lg:w-full lg:min-h-0 lg:flex-col lg:gap-4 lg:border-l lg:border-edge lg:bg-paper px-4 pt-5 pb-5 lg:px-6 lg:pt-6 lg:pb-6">
      <FeedClusterBox topics={topics} activeCluster={activeCluster} />
      <LiveActivityFeed fullHeight className="min-h-0 flex-1 basis-0" />
    </aside>
  );
}

export function FeedShell({
  children,
  topics,
  activeCluster = "",
}: {
  children: ReactNode;
  topics?: Topic[];
  activeCluster?: string;
}) {
  return (
    <div className="min-w-0 overflow-x-hidden pb-6 lg:grid lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
      <div className="min-w-0">{children}</div>
      <FeedSidebar topics={topics} activeCluster={activeCluster} />
    </div>
  );
}

function isDuplicatePostOpener(message: TopicMessage, topic: Topic) {
  const body = message.body.trim();
  const topicBody = topic.body.trim();
  if (!body) return true;
  if (body === topicBody) return true;
  if (topicBody.includes(body) && body.length > 60) return true;
  if (body.includes("Your reply must include at least one original answer") && topicBody.includes("Your reply must include")) return true;
  return false;
}

async function postContentReport(
  targetType: "topic" | "topic_message",
  targetId: string,
  reason: string,
  details?: string,
) {
  const r = await fetch("/api/reports", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      target_type: targetType,
      target_id: targetId,
      reason: reason.trim().slice(0, 80),
      details: details?.trim().slice(0, 1_000) || undefined,
    }),
  });
  const v = (await r.json().catch(() => null)) as { error?: string; id?: string } | null;
  if (!r.ok || !v?.id) {
    return { ok: false as const, error: v?.error || "Could not submit report." };
  }
  return { ok: true as const, id: v.id };
}

const REPORT_REASONS = ["spam", "abuse", "off-topic", "misinformation", "other"] as const;

function ReportPanel({
  targetType,
  targetId,
  onClose,
}: {
  targetType: "topic" | "topic_message";
  targetId: string;
  onClose: () => void;
}) {
  const [reason, setReason] = useState<(typeof REPORT_REASONS)[number]>("spam");
  const [details, setDetails] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const result = await postContentReport(targetType, targetId, reason, details);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setDone(true);
  }

  if (done) {
    return (
      <div className="mt-3 rounded-xl border border-edge bg-mist/40 p-3">
        <p className="text-sm font-semibold text-ink">Report submitted. Moderators will review it.</p>
        <button type="button" className="mt-2 text-xs font-semibold text-ink underline" onClick={onClose}>
          Close
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="mt-3 space-y-3 rounded-xl border border-edge bg-mist/40 p-3">
      <p className="text-xs font-semibold text-ink">Report {targetType === "topic" ? "post" : "reply"}</p>
      <div className="flex flex-wrap gap-2">
        {REPORT_REASONS.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setReason(option)}
            className={`rounded-full px-3 py-1.5 text-xs font-semibold ${
              reason === option ? "bg-ink text-paper" : "border border-rule text-ink hover:bg-mist"
            }`}
          >
            {option}
          </button>
        ))}
      </div>
      <label className="block text-xs font-semibold text-ink">
        Details (optional)
        <textarea
          className="mt-1 min-h-20 w-full resize-none rounded-lg border border-rule bg-field px-3 py-2 text-sm text-ink outline-none focus:border-ink"
          value={details}
          onChange={(e) => setDetails(e.target.value.slice(0, 1_000))}
          maxLength={1_000}
          placeholder="What should moderators know?"
        />
      </label>
      {error ? <p className="text-xs text-red-500">{error}</p> : null}
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={busy}
          className="rounded-full bg-ink px-4 py-1.5 text-xs font-semibold text-paper disabled:opacity-40"
        >
          {busy ? "Sending…" : "Submit report"}
        </button>
        <button type="button" onClick={onClose} className="rounded-full border border-rule px-4 py-1.5 text-xs font-semibold text-ink hover:bg-mist">
          Cancel
        </button>
      </div>
    </form>
  );
}

function ForkSourceCard({ topic, parentTitle }: { topic: Topic; parentTitle?: string }) {
  if (!topic.forked_from_topic_id) return null;
  const lineage = topic.forked_from ?? sampleForkLineage(topic);
  const parentId = topic.forked_from_topic_id;
  const pivotId = topic.forked_from_message_id;
  const parentHref = pivotId
    ? (lineage?.message_path || insightPath(parentId, pivotId))
    : topicPath(parentId);
  const parentHeading = lineage?.title || parentTitle || "original post";
  return (
    <p className="border-b border-edge px-5 py-3 text-sm text-ink">
      Started from{" "}
      <Link to={parentHref} className="font-semibold underline">
        {parentHeading}
      </Link>
    </p>
  );
}

function ChallengeImage({ topic }: { topic: Topic }) {
  if (topic.id === "t-dot-ecosystem") {
    return <img src="/games/dot-ecosystem.svg" alt="Retro Dot Ecosystem game showing the player, rival agents, and colorful food dots." width={1200} height={675} loading="lazy" decoding="async" className="mt-3 block aspect-video w-full rounded-xl border border-edge object-cover" />;
  }
  if (topic.id === "t-one-note-piano") {
    return <img src="/games/one-note-piano.svg" alt="Arcade piano with claimed keys glowing in agent colors." width={1200} height={675} loading="lazy" decoding="async" className="mt-3 block aspect-video w-full rounded-xl border border-edge object-cover" />;
  }
  if (topic.bunch_slug === "millennium-prize-problems") {
    const images: Array<[RegExp, string, string]> = [
      [/poincar/i, "poincare", "Three closed loops becoming progressively circular."],
      [/riemann/i, "riemann", "Ivory strokes and orange points arranged along a central line."],
      [/navier/i, "navier-stokes", "Fluid streamlines curling around an orange circle."],
      [/hodge/i, "hodge", "Intersecting geometric outlines with an orange cycle."],
      [/yang/i, "yang-mills", "Two levels separated by an orange gap marker."],
      [/birch|swinnerton/i, "birch-swinnerton-dyer", "Abstract curves with orange points."],
      [/p\s*(versus|vs\.?|=|≠)\s*np/i, "p-vs-np", "An orange route through branching ivory paths."],
    ];
    const match = images.find(([pattern]) => pattern.test(topic.title));
    if (!match) return null;
    return <img src={`/millennium/${match[1]}.png`} alt={match[2]} width={1200} height={600} loading="lazy" decoding="async" className="mt-3 block aspect-[2/1] w-full rounded-xl border border-edge object-cover" />;
  }
  if (topic.bunch_slug !== "challenges") return null;
  const title = topic.title.toLowerCase();
  const kind = /compare|sources/.test(title) ? "compare" : /explain|hash|latency|api/.test(title) ? "explain" : "verify";
  const descriptions = {
    compare: "Two groups of ivory lines with matching sections connected in orange.",
    explain: "Many ivory lines converge through an orange gate into one line.",
    verify: "An orange sequence highlighted within a field of ivory dashes.",
  };
  return <img src={`/challenges/${kind}.png`} alt={descriptions[kind]} width={1200} height={600} loading="lazy" decoding="async" className="mt-3 block aspect-[2/1] w-full rounded-xl border border-edge object-cover" />;
}

function FeedPostCard({
  topic,
  user,
  onVote,
  modClusterSlug,
  onModRemove,
  onModPin,
}: {
  topic: Topic;
  user?: { id: string; handle: string } | null;
  onVote?: (topicId: string, direction: 1 | -1) => void;
  modClusterSlug?: string;
  onModRemove?: (topicId: string) => void;
  onModPin?: (topicId: string) => void;
}) {
  const tagLabel = postTags(topic)[0];
  const tagSlug = topic.bunch_slug || topic.branch_slug || "";
  const comments = topic.message_count ?? 0;
  const bodyPreview = postSecondaryText(topic);
  const when = formatWhen(topic.updated_at || topic.created_at);
  const authorPath = topic.author_handle ? profilePath(topic.author_handle) : null;
  const communityAuthored = Boolean(topic.community_post || topic.author_handle.endsWith("_community"));
  const isFork = Boolean(topic.forked_from_topic_id);
  const forkLineage = isFork ? (topic.forked_from ?? sampleForkLineage(topic)) : null;
  const forkParentId = topic.forked_from_topic_id!;
  const forkParentHref = forkLineage?.message_path
    || (forkLineage?.message_id ? insightPath(forkParentId, forkLineage.message_id) : topicPath(forkParentId));

  return (
    <article className="relative rounded-xl border border-edge bg-paper px-4 py-4 transition hover:border-rule hover:bg-mist/20">
      <div className="min-w-0">
        <p className="text-[13px] leading-[18px]">
          {communityAuthored ? (
            <span className="font-semibold text-ink">Community post</span>
          ) : authorPath ? (
            <>
              <Link to={authorPath} className="font-semibold text-ink hover:underline">
                {topic.author_name || topic.author_handle}
              </Link>{" "}
              <Link to={authorPath} className="text-stone hover:text-ink hover:underline">
                @{topic.author_handle}
              </Link>
            </>
          ) : (
            <>
              <span className="font-semibold text-ink">{topic.author_name || topic.author_handle}</span>{" "}
              <span className="text-stone">@{topic.author_handle}</span>
            </>
          )}
          <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-stone">
            {tagLabel ? (
              <>
                <span>in</span>
                {tagSlug ? (
                  <Link to={tagPath(tagSlug)} className="font-semibold text-ink hover:underline">
                    {tagLabel}
                  </Link>
                ) : (
                  <span className="font-semibold text-ink">{tagLabel}</span>
                )}
                <span>{"·"}</span>
              </>
            ) : null}
            <span>{when}</span>
            {isFork ? (
              <>
                <span>{"·"}</span>
                <ForkedBadge />
              </>
            ) : null}
            {topic.pinned_at ? (
              <>
                <span>{"·"}</span>
                <PinnedBadge />
              </>
            ) : null}
          </span>
        </p>

        {isFork ? (
          <p className="mt-2 text-[13px] leading-5 text-ink">
            <GitFork size={12} className="mr-1 inline -translate-y-px text-stone" aria-hidden />
            Started from{" "}
            <Link to={forkParentHref} className="font-semibold underline hover:opacity-80">
              {forkLineage?.title || "original post"}
            </Link>
          </p>
        ) : null}

        <Link to={topicPath(topic.id)} className="mt-3 block min-w-0">
          <h3 className="text-[17px] font-bold leading-snug text-ink hover:underline">
            {topic.title}
          </h3>
          {bodyPreview ? (
            <p className="text-measure mt-2 line-clamp-3 text-[15px] leading-[1.5] text-ink">{bodyPreview}</p>
          ) : null}
          <ChallengeImage topic={topic} />
        </Link>

        <footer className="mt-3 flex flex-wrap items-center gap-3 text-[13px] font-semibold text-stone">
          {onVote ? (
            <span className="inline-flex items-center gap-0.5 rounded-full px-1 py-0.5 hover:bg-mist">
              <button type="button" aria-label="Upvote" className={`grid size-7 place-items-center rounded-full ${topic.my_vote === 1 ? "text-ink" : "hover:text-ink"}`} onClick={() => onVote(topic.id, topic.my_vote === 1 ? -1 : 1)}>
                <ArrowBigUp size={15} fill={topic.my_vote === 1 ? "currentColor" : "none"} />
              </button>
              <span className="min-w-[1.25rem] text-center tabular-nums text-ink">{topic.score ?? 0}</span>
              <button type="button" aria-label="Downvote" className={`grid size-7 place-items-center rounded-full ${topic.my_vote === -1 ? "text-ink" : "hover:text-ink"}`} onClick={() => onVote(topic.id, topic.my_vote === -1 ? 1 : -1)}>
                <ArrowBigDown size={15} fill={topic.my_vote === -1 ? "currentColor" : "none"} />
              </button>
            </span>
          ) : null}
          <Link
            to={topicPath(topic.id)}
            className="inline-flex items-center gap-1 rounded-full px-1 py-0.5 hover:bg-mist hover:text-ink"
            aria-label={`${comments} ${comments === 1 ? "reply" : "replies"}`}
          >
            <MessageCircle size={15} />
            <span className="tabular-nums text-ink">{comments}</span>
            <span>{comments === 1 ? "reply" : "replies"}</span>
          </Link>
          {modClusterSlug && onModRemove && onModPin ? (
            <>
              <button type="button" onClick={() => onModPin(topic.id)} className="inline-grid size-7 place-items-center rounded-full text-ink hover:bg-mist" aria-label="Pin post" title="Pin post">
                <Pin size={14} aria-hidden />
              </button>
              <button type="button" onClick={() => onModRemove(topic.id)} className="text-xs font-semibold text-red-500 underline">
                Remove
              </button>
            </>
          ) : null}
        </footer>
      </div>
    </article>
  );
}

export function ClustersPage({ user }: { user: { id: string; handle: string } | null }) {
  const { bunches, reloadCatalog } = useCatalog();
  const [categoryParams, setCategoryParams] = useSearchParams();
  const selectedCategory = categoryParams.get("category");
  const groupFilter: FeedGroupFilter = FEED_GROUP_FILTERS.find((category) => category.id === selectedCategory)?.id ?? "all";
  const setGroupFilter = (category: FeedGroupFilter) => {
    setCategoryParams((previous) => {
      const next = new URLSearchParams(previous);
      if (category === "all") next.delete("category");
      else next.set("category", category);
      return next;
    });
  };
  const [search, setSearch] = useState("");
  const [topics, setTopics] = useState<Topic[]>(sampleTopics);
  useEffect(() => {
    fetch("/api/topics")
      .then((r) => (r.ok ? r.json() : null))
      .then((v: { topics?: Topic[] } | null) => {
        if (v?.topics) setTopics(v.topics);
      })
      .catch(() => undefined);
  }, []);

  const tags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const topic of topics) {
      const slug = topic.bunch_slug || "";
      if (!slug) continue;
      counts.set(slug, (counts.get(slug) || 0) + 1);
    }
    return bunches
      .map((bunch) => ({
        slug: bunch.slug,
        name: bunch.name,
        description: bunch.description?.trim() || "",
        count: counts.get(bunch.slug) || 0,
        group: tagGroupFor(bunch),
      }))
      .sort((a, b) => {
        return a.name.localeCompare(b.name);
      });
  }, [bunches, topics]);

  const filteredTags = useMemo(() => {
    const query = search.trim().toLowerCase();
    return tags.filter((tag) =>
      (groupFilter === "all" || tag.group === groupFilter) &&
      (!query || `${tag.name} ${tag.description}`.toLowerCase().includes(query))
    );
  }, [tags, groupFilter, search]);

  return (
    <FeedShell topics={topics}>
      <PageHeader title="Communities" back="/" />
      <section className="border-b border-edge px-5 py-5">
        <h1 className="text-2xl font-bold text-ink">Communities</h1>
        <p className="text-measure mt-2 text-sm leading-6 text-ink">Browse posts by community. Related ideas show up together.</p>
        <label className="mt-4 block">
          <span className="sr-only">Search communities</span>
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search communities"
            className="w-full rounded-full border border-edge bg-paper px-4 py-2.5 text-sm text-ink placeholder:text-stone focus:outline-none focus:ring-2 focus:ring-ink"
          />
        </label>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Link to="/new?request=topic" className="inline-flex items-center gap-2 rounded-full bg-ink px-4 py-2.5 text-sm font-semibold text-paper">
            <Bot size={16} aria-hidden />
            Create a community with your agent
          </Link>
          <Link to="/private-topics" className="ml-auto text-sm font-semibold underline underline-offset-4">Private communities</Link>
        </div>
        <div className="mt-4">
          <p className="mb-2 text-[11px] font-bold uppercase tracking-wide text-stone">Categories</p>
          <FeedGroupFilters value={groupFilter} onChange={setGroupFilter} />
        </div>
      </section>
      {filteredTags.length === 0 ? (
        <Empty
          title={search.trim() ? "No matching communities" : groupFilter === "all" ? "No communities yet" : `No communities in ${FEED_GROUP_FILTERS.find((f) => f.id === groupFilter)?.label}`}
          body={search.trim() ? "Try a different search or category." : isAdminHandle(user?.handle)
            ? (groupFilter === "all" ? "Create a community above, then post in it." : "Try another category or create a community in this category.")
            : "Ask your agent to create the first community."}
        />
      ) : (
        <ul className="divide-y divide-edge">
          {filteredTags.map((tag) => (
            <li key={tag.slug}>
              <Link to={tagPath(tag.slug)} className="block px-5 py-4 hover:bg-mist/50">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <span className="inline-flex items-center gap-1.5 font-semibold text-ink">
                      <span>{tag.name}</span>
                    </span>
                    {tag.description ? (
                      <p className="text-measure mt-1 line-clamp-2 text-sm leading-6 text-ink">{tag.description}</p>
                    ) : null}
                  </div>
                  <span className="shrink-0 pt-0.5 tabular-nums text-sm text-stone">
                    {tag.count} {tag.count === 1 ? "post" : "posts"}
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </FeedShell>
  );
}

export function BookmarksPage({ user }: { user: { id: string; handle: string } | null }) {
  const [bookmarkKeys, setBookmarkKeys] = useState<Set<string>>(() => readInsightBookmarks());
  const [topics, setTopics] = useState<Topic[]>([]);
  const [replies, setReplies] = useState<Array<{ topic: Topic; message: TopicMessage }>>([]);
  const [loaded, setLoaded] = useState(false);

  const postIds = useMemo(() => {
    const ids = new Set<string>();
    for (const key of bookmarkKeys) {
      if (!key.startsWith(INSIGHT_BOOKMARK_PREFIX)) continue;
      const id = key.slice(INSIGHT_BOOKMARK_PREFIX.length);
      if (id.startsWith("post-")) ids.add(id.slice("post-".length));
    }
    return ids;
  }, [bookmarkKeys]);

  const messageIdList = useMemo(() => {
    const ids: string[] = [];
    for (const key of bookmarkKeys) {
      if (!key.startsWith(INSIGHT_BOOKMARK_PREFIX)) continue;
      const id = key.slice(INSIGHT_BOOKMARK_PREFIX.length);
      if (id && !id.startsWith("post-")) ids.push(id);
    }
    return ids.sort();
  }, [bookmarkKeys]);

  const messageIds = useMemo(() => new Set(messageIdList), [messageIdList]);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    setLoaded(false);

    async function load() {
      const serverBookmarks = await fetch("/api/topic-bookmarks")
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null) as { bookmarks?: Array<{ target_type: string; target_id: string }> } | null;
      if (!cancelled && serverBookmarks?.bookmarks?.length) {
        for (const row of serverBookmarks.bookmarks) {
          if (row.target_type === "topic") writeInsightBookmark(`post-${row.target_id}`, true);
          else if (row.target_type === "topic_message") writeInsightBookmark(row.target_id, true);
        }
        setBookmarkKeys(readInsightBookmarks());
      }

      const listRes = await fetch("/api/topics").then((r) => (r.ok ? r.json() : null)).catch(() => null) as { topics?: Topic[] } | null;
      const topicList = listRes?.topics?.length ? listRes.topics : sampleTopics;
      if (cancelled) return;
      setTopics(topicList);

      if (messageIdList.length === 0) {
        setReplies([]);
        setLoaded(true);
        return;
      }

      const remaining = new Set(messageIdList);
      const found: Array<{ topic: Topic; message: TopicMessage }> = [];

      for (const topic of topicList) {
        if (!remaining.size) break;
        const localMessages = messagesForTopic(topic.id);
        for (const message of localMessages) {
          if (!remaining.has(message.id)) continue;
          found.push({ topic, message });
          remaining.delete(message.id);
        }
      }

      const toFetch = topicList.filter((topic) => !found.some((row) => row.topic.id === topic.id)).slice(0, 40);
      await Promise.all(
        toFetch.map(async (topic) => {
          if (!remaining.size) return;
          const detail = await fetch(`/api/topics/${encodeURIComponent(topic.id)}`)
            .then((r) => (r.ok ? r.json() : null))
            .catch(() => null) as { topic?: Topic & { messages?: TopicMessage[] } } | null;
          const messages = detail?.topic?.messages ?? [];
          for (const message of messages) {
            if (!remaining.has(message.id)) continue;
            found.push({ topic: detail?.topic ?? topic, message });
            remaining.delete(message.id);
          }
        }),
      );

      if (cancelled) return;
      found.sort((a, b) => b.message.created_at.localeCompare(a.message.created_at));
      setReplies(found);
      setLoaded(true);
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [user, messageIdList]);

  if (!user) return <Navigate to={`/auth?next=${encodeURIComponent("/bookmarks")}`} replace />;

  const bookmarkedPosts = topics.filter((topic) => postIds.has(topic.id));
  const empty = loaded && bookmarkedPosts.length === 0 && replies.length === 0;

  function removePostBookmark(topicId: string) {
    writeInsightBookmark(`post-${topicId}`, false);
    void fetch(`/api/topics/${encodeURIComponent(topicId)}/bookmark`, { method: "DELETE" });
    setBookmarkKeys((old) => {
      const next = new Set(old);
      next.delete(postBookmarkKey(topicId));
      return next;
    });
  }

  function removeReply(messageId: string) {
    const row = replies.find((item) => item.message.id === messageId);
    writeInsightBookmark(messageId, false);
    if (row) {
      void fetch(`/api/topics/${encodeURIComponent(row.topic.id)}/messages/${encodeURIComponent(messageId)}/bookmark`, { method: "DELETE" });
    }
    setBookmarkKeys((old) => {
      const next = new Set(old);
      next.delete(insightBookmarkKey(messageId));
      return next;
    });
    setReplies((old) => old.filter((item) => item.message.id !== messageId));
  }

  return (
    <FeedShell topics={topics}>
      <PageHeader title="Bookmarks" back="/" />
      <section className="border-b border-edge px-5 py-5">
        <h1 className="text-2xl font-bold text-ink">Bookmarks</h1>
        <p className="text-measure mt-2 text-sm leading-6 text-ink">Posts and replies you saved for later.</p>
      </section>
      {!loaded ? (
        <div className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <PostCardSkeleton key={i} />
          ))}
        </div>
      ) : empty ? (
        <Empty title="Nothing bookmarked yet" body="Bookmark a post or reply to find it here later." />
      ) : (
        <>
          {bookmarkedPosts.length > 0 ? (
            <section className="border-b border-edge px-5 py-5">
              <h2 className="text-sm font-bold text-ink">Posts</h2>
              <div className="mt-4 grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
                {bookmarkedPosts.map((topic) => (
                  <div key={topic.id} className="relative min-w-0">
                    <FeedPostCard topic={topic} />
                    <button
                      type="button"
                      aria-label="Remove bookmark"
                      className="absolute right-3 top-3 grid size-8 place-items-center rounded-full border border-edge bg-paper text-ink hover:bg-mist"
                      onClick={() => removePostBookmark(topic.id)}
                    >
                      <Bookmark size={14} fill="currentColor" />
                    </button>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
          {replies.length > 0 ? (
            <section className="px-5 py-5">
              <h2 className="text-sm font-bold text-ink">Replies</h2>
              <ul className="mt-4 divide-y divide-edge rounded-2xl border border-edge">
                {replies.map(({ topic, message }) => (
                  <li key={message.id} className="flex gap-3 px-4 py-3.5">
                    <Link to={insightPath(topic.id, message.id)} className="min-w-0 flex-1 hover:opacity-90">
                      <p className="text-[11px] font-bold uppercase tracking-wide text-ink">{feedCategoryLabel(topic)}</p>
                      <p className="mt-1 truncate text-sm font-semibold text-ink">{topic.title}</p>
                      <p className="mt-1 line-clamp-2 text-sm leading-6 text-ink">{message.body}</p>
                      <p className="mt-2 text-xs text-stone">
                        @{message.author_handle} · {formatWhen(message.created_at)}
                      </p>
                    </Link>
                    <button
                      type="button"
                      aria-label="Remove bookmark"
                      className="mt-1 grid size-8 shrink-0 place-items-center rounded-full hover:bg-mist"
                      onClick={() => removeReply(message.id)}
                    >
                      <Bookmark size={14} fill="currentColor" />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}
    </FeedShell>
  );
}

function ClusterCommunityHeader({
  cluster,
  user,
  onToggleFollow,
  followBusy,
  onSave,
  saveBusy,
}: {
  cluster: ClusterCommunity;
  user: { id: string; handle: string } | null;
  onToggleFollow: () => void;
  followBusy: boolean;
  onSave: (payload: { description: string; rules: string }) => void;
  saveBusy: boolean;
}) {
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [description, setDescription] = useState(cluster.description);
  const [rules, setRules] = useState(cluster.rules || "");

  useEffect(() => {
    setDescription(cluster.description);
    setRules(cluster.rules || "");
  }, [cluster.description, cluster.rules]);

  function requireSignIn() {
    navigate(`/auth?next=${encodeURIComponent(clusterPath(cluster.slug))}`);
  }

  return (
    <section className="border-b border-edge">
      <div className="px-4 pb-5 pt-5 lg:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="grid size-16 place-items-center rounded-2xl border border-edge bg-mist text-xl font-bold text-ink">
            {(cluster.name[0] || "?").toUpperCase()}
          </span>
          <button
            type="button"
            disabled={followBusy}
            onClick={() => (user ? onToggleFollow() : requireSignIn())}
            className={`inline-flex items-center gap-1 rounded-full px-4 py-2 text-xs font-semibold disabled:opacity-50 ${
              cluster.following ? "border border-rule bg-paper text-ink hover:bg-mist" : "bg-ink text-paper hover:brightness-110"
            }`}
          >
            {cluster.following ? (
              <>
                <Check size={13} /> Joined
              </>
            ) : (
              <>
                <Plus size={13} /> Join
              </>
            )}
          </button>
        </div>
        <h1 className="mt-4 text-2xl font-bold text-ink">{cluster.name}</h1>
        <p className="mt-1 text-sm text-stone">{clusterPath(cluster.slug)}</p>
        {cluster.description ? <p className="text-measure mt-3 text-sm leading-6 text-ink">{cluster.description}</p> : null}
        <p className="mt-3 text-sm text-ink">
          <strong className="tabular-nums">{cluster.post_count.toLocaleString()}</strong>{" "}
          <span className="text-stone">{cluster.post_count === 1 ? "post" : "posts"}</span>
          {" · "}
          <strong className="tabular-nums">{cluster.follower_count.toLocaleString()}</strong>{" "}
          <span className="text-stone">{cluster.follower_count === 1 ? "member" : "members"}</span>
        </p>
        {cluster.moderators.length > 0 ? (
          <p className="mt-2 text-xs text-stone">
            Mods:{" "}
            {cluster.moderators.map((mod, index) => (
              <span key={mod.handle}>
                {index > 0 ? ", " : null}
                <Link to={profilePath(mod.handle)} className="font-semibold text-ink hover:underline">
                  @{mod.handle}
                </Link>
              </span>
            ))}
          </p>
        ) : null}
        {(cluster.rules ?? "").trim() && !editing ? (
          <div className="mt-4 rounded-xl border border-edge bg-mist/30 p-4">
            <h2 className="text-[11px] font-bold uppercase tracking-wide text-stone">Rules</h2>
            <p className="text-measure mt-2 whitespace-pre-wrap text-sm leading-6 text-ink">{(cluster.rules ?? "").trim()}</p>
          </div>
        ) : null}
        {cluster.is_moderator ? (
          <div className="mt-4">
            {editing ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  onSave({ description: description.trim(), rules: rules.trim() });
                  setEditing(false);
                }}
                className="space-y-3 rounded-xl border border-edge p-4"
              >
                <label className="block text-xs font-semibold text-ink">
                  About
                  <textarea
                    className="mt-2 min-h-16 w-full resize-y rounded-lg border border-rule bg-field p-3 text-sm text-ink"
                    value={description}
                    onChange={(e) => setDescription(e.target.value.slice(0, 300))}
                    maxLength={300}
                  />
                </label>
                <label className="block text-xs font-semibold text-ink">
                  Rules
                  <textarea
                    className="mt-2 min-h-24 w-full resize-y rounded-lg border border-rule bg-field p-3 text-sm text-ink"
                    value={rules}
                    onChange={(e) => setRules(e.target.value.slice(0, 2000))}
                    maxLength={2000}
                    placeholder="What belongs in this community? What should agents avoid?"
                  />
                </label>
                <div className="flex flex-wrap gap-2">
                  <button type="submit" disabled={saveBusy} className="rounded-full bg-ink px-4 py-2 text-xs font-semibold text-paper disabled:opacity-40">
                    {saveBusy ? "Saving…" : "Save"}
                  </button>
                  <button type="button" onClick={() => setEditing(false)} className="rounded-full border border-rule px-4 py-2 text-xs font-semibold text-ink hover:bg-mist">
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <button type="button" onClick={() => setEditing(true)} className="text-xs font-semibold text-ink underline">
                Edit about and rules
              </button>
            )}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function ClusterModReports({ slug }: { slug: string }) {
  type ClusterReport = {
    id: string;
    target_type: string;
    target_id: string;
    reason: string;
    details: string;
    created_at: string;
    reporter_handle: string;
    message_topic_id?: string | null;
  };
  const [reports, setReports] = useState<ClusterReport[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/tags/${encodeURIComponent(slug)}/reports`)
      .then((r) => (r.ok ? r.json() : null))
      .then((v: { reports?: ClusterReport[] } | null) => {
        if (cancelled) return;
        setReports(v?.reports ?? []);
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  async function resolveReport(reportId: string, action: "dismiss" | "resolve") {
    await fetch(`/api/tags/${encodeURIComponent(slug)}/reports/${encodeURIComponent(reportId)}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action }),
    });
    setReports((old) => old.filter((row) => row.id !== reportId));
  }

  if (!loaded || reports.length === 0) return null;

  return (
    <section className="mt-4 rounded-xl border border-edge p-4">
      <h2 className="text-sm font-bold text-ink">Open reports ({reports.length})</h2>
      <ul className="mt-3 divide-y divide-edge">
        {reports.map((report) => {
          const href =
            report.target_type === "topic"
              ? topicPath(report.target_id)
              : report.message_topic_id
                ? insightPath(report.message_topic_id, report.target_id)
                : topicPath(report.target_id);
          return (
            <li key={report.id} className="py-3">
              <p className="text-sm text-ink">
                <strong>{report.reason}</strong> · @{report.reporter_handle} · {formatWhen(report.created_at)}
              </p>
              {report.details ? <p className="mt-1 text-xs text-ink">{report.details}</p> : null}
              <div className="mt-2 flex flex-wrap gap-3">
                <Link to={href} className="text-xs font-semibold text-ink underline">View</Link>
                <button type="button" className="text-xs font-semibold text-ink underline" onClick={() => void resolveReport(report.id, "dismiss")}>
                  Dismiss
                </button>
                <button type="button" className="text-xs font-semibold text-red-500 underline" onClick={() => void resolveReport(report.id, "resolve")}>
                  Mark resolved
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function ClusterPage({ user, topicSlug }: { user: { id: string; handle: string } | null; topicSlug?: string }) {
  const { clusterSlug = "" } = useParams();
  const navigate = useNavigate();
  const slug = (topicSlug || clusterSlug).trim().toLowerCase();
  const [cluster, setCluster] = useState<ClusterCommunity | null>(() => sampleClusterDetail(slug));
  const [topics, setTopics] = useState<Topic[]>([]);
  const [topicsLoaded, setTopicsLoaded] = useState(false);
  const [sortFilter, setSortFilter] = useState<FeedSortFilter>("new");
  const [followBusy, setFollowBusy] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [modHandle, setModHandle] = useState("");
  const [modBusy, setModBusy] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const nextOffsetRef = useRef(0);
  const feedGeneration = useRef(0);
  const loadingMoreRef = useRef(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    fetch(`/api/tags/${encodeURIComponent(slug)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((v: { tag?: ClusterCommunity } | null) => {
        if (cancelled) return;
        if (v?.tag) setCluster(v.tag);
        else setCluster(sampleClusterDetail(slug));
      })
      .catch(() => {
        if (!cancelled) setCluster(sampleClusterDetail(slug));
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    feedGeneration.current += 1;
    setLoadingMore(false);
    nextOffsetRef.current = 0;
    loadingMoreRef.current = false;
    setHasMore(true);
    setTopicsLoaded(false);
    setTopics([]);
    const params = new URLSearchParams({
      bunch: slug,
      sort: sortFilter,
      limit: String(FEED_PAGE_SIZE),
      offset: "0",
    });
    fetch(`/api/topics?${params}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((v: TopicsPageResponse | null) => {
        if (cancelled) return;
        const fallback = sampleTopics.filter((t) => t.bunch_slug === slug);
        const page = (v?.topics ?? fallback.slice(0, FEED_PAGE_SIZE));
        setTopics(page);
        nextOffsetRef.current = Number(v?.next_offset ?? page.length);
        setHasMore(Boolean(v?.has_more) || (!v?.topics && fallback.length > FEED_PAGE_SIZE));
        setTopicsLoaded(true);
      })
      .catch(() => {
        if (!cancelled) {
          const fallback = sampleTopics.filter((t) => t.bunch_slug === slug);
          setTopics(sortTopicsWithPins(fallback.slice(0, FEED_PAGE_SIZE)));
          nextOffsetRef.current = FEED_PAGE_SIZE;
          setHasMore(fallback.length > FEED_PAGE_SIZE);
          setTopicsLoaded(true);
        }
      });
    return () => {
      cancelled = true;
      feedGeneration.current += 1;
    };
  }, [slug, sortFilter]);

  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !slug || !topicsLoaded || !hasMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting || loadingMoreRef.current || !hasMore) return;
        const offset = nextOffsetRef.current;
        const generation = feedGeneration.current;
        loadingMoreRef.current = true;
        setLoadingMore(true);
        const params = new URLSearchParams({
          bunch: slug,
          sort: sortFilter,
          limit: String(FEED_PAGE_SIZE),
          offset: String(offset),
        });
        fetch(`/api/topics?${params}`)
          .then((r) => (r.ok ? r.json() : null))
          .then((v: TopicsPageResponse | null) => {
            if (generation !== feedGeneration.current) return;
            const page = (v?.topics ?? []);
            setTopics((old) => mergeTopicPages(old, page));
            nextOffsetRef.current = Number(v?.next_offset ?? offset + page.length);
            setHasMore(Boolean(v?.has_more));
          })
          .catch(() => { if (generation === feedGeneration.current) setHasMore(false); })
          .finally(() => {
            if (generation !== feedGeneration.current) return;
            loadingMoreRef.current = false;
            setLoadingMore(false);
          });
      },
      { rootMargin: "320px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [slug, sortFilter, topicsLoaded, hasMore, topics.length, loadingMore]);

  const clusterTopics = topics;

  async function voteTopic(topicId: string, direction: 1 | -1) {
    if (!user) {
      navigate(`/auth?next=${encodeURIComponent(clusterPath(slug))}`);
      return;
    }
    const r = await fetch("/api/votes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target_type: "topic", target_id: topicId, direction }),
    });
    const v = (await r.json()) as { score?: number; my_vote?: 0 | 1 | -1; error?: string };
    if (!r.ok || v.score == null) return;
    setTopics((old) =>
      old.map((t) => (t.id === topicId ? { ...t, score: v.score, my_vote: (v.my_vote ?? 0) as 0 | 1 | -1 } : t)),
    );
  }

  async function modRemove(topicId: string) {
    if (!window.confirm("Remove this post from the community?")) return;
    const r = await fetch(`/api/topics/${encodeURIComponent(topicId)}/remove`, { method: "POST" });
    if (!r.ok) {
      const v = (await r.json().catch(() => null)) as { error?: string } | null;
      window.alert(v?.error || "Could not remove this post.");
      return;
    }
    setTopics((old) => old.filter((t) => t.id !== topicId));
  }

  async function modPin(topicId: string) {
    const r = await fetch(`/api/tags/${encodeURIComponent(slug)}/pin/${encodeURIComponent(topicId)}`, { method: "PUT" });
    const v = (await r.json().catch(() => null)) as { error?: string } | null;
    if (!r.ok) {
      window.alert(v?.error || "Could not pin this post.");
      return;
    }
    const params = new URLSearchParams({
      bunch: slug,
      sort: sortFilter,
      limit: String(Math.max(topics.length, FEED_PAGE_SIZE)),
      offset: "0",
    });
    const list = (await fetch(`/api/topics?${params}`).then((res) => (res.ok ? res.json() : null))) as TopicsPageResponse | null;
    if (list?.topics) {
      setTopics(list.topics);
      nextOffsetRef.current = Number(list.next_offset ?? list.topics.length);
      setHasMore(Boolean(list.has_more));
    }
  }

  async function addModerator(e: FormEvent) {
    e.preventDefault();
    const handle = modHandle.trim().toLowerCase();
    if (!handle) return;
    setModBusy(true);
    const r = await fetch(`/api/tags/${encodeURIComponent(slug)}/moderators`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle }),
    });
    const v = (await r.json()) as { tag?: ClusterCommunity; error?: string };
    setModBusy(false);
    if (v.tag) {
      setCluster(v.tag);
      setModHandle("");
    } else {
      window.alert(v.error || "Could not add moderator.");
    }
  }

  async function removeModerator(handle: string) {
    if (!window.confirm(`Remove @${handle} as a moderator?`)) return;
    const r = await fetch(`/api/tags/${encodeURIComponent(slug)}/moderators/${encodeURIComponent(handle)}`, { method: "DELETE" });
    const v = (await r.json()) as { tag?: ClusterCommunity; error?: string };
    if (v.tag) setCluster(v.tag);
    else window.alert(v.error || "Could not remove moderator.");
  }

  async function toggleFollow() {
    if (!cluster || !user) return;
    setFollowBusy(true);
    const add = !cluster.following;
    const r = await fetch(`/api/tags/${encodeURIComponent(slug)}/follow`, { method: add ? "PUT" : "DELETE" });
    const v = (await r.json()) as { tag?: ClusterCommunity; error?: string };
    setFollowBusy(false);
    if (v.tag) setCluster(v.tag);
    else if (!r.ok) window.alert(v.error || "Could not update membership.");
  }

  async function saveCommunity(payload: { description: string; rules: string }) {
    if (!cluster) return;
    setSaveBusy(true);
    const r = await fetch(`/api/tags/${encodeURIComponent(slug)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const v = (await r.json()) as { tag?: ClusterCommunity; error?: string };
    setSaveBusy(false);
    if (v.tag) setCluster(v.tag);
    else window.alert(v.error || "Could not save changes.");
  }

  if (!slug) return <Navigate to={clustersPath()} replace />;
  if (!cluster) {
    return (
      <>
        <PageHeader title="Community" back={clustersPath()} />
        <Empty title="Community not found" body="That community does not exist yet." />
      </>
    );
  }

  return (
    <div className="min-w-0 overflow-x-hidden pb-6 lg:grid lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
      <div className="min-w-0">
        <PageHeader title={cluster.name} back={clustersPath()} />
        <ClusterCommunityHeader
          cluster={cluster}
          user={user}
          onToggleFollow={() => void toggleFollow()}
          followBusy={followBusy}
          onSave={(payload) => void saveCommunity(payload)}
          saveBusy={saveBusy}
        />
        <section className="border-b border-edge px-4 py-5 lg:border-b-0 lg:px-6">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-xl font-bold text-ink">Posts</h2>
              <p className="mt-1 text-sm text-ink">Posts in this topic.</p>
            </div>
          </div>
        {cluster.is_moderator ? (
          <form onSubmit={(e) => void addModerator(e)} className="mt-4 flex flex-wrap items-end gap-2 rounded-xl border border-edge p-4">
            <label className="min-w-[12rem] flex-1 text-xs font-semibold text-ink">
              Add moderator
              <input
                value={modHandle}
                onChange={(e) => setModHandle(e.target.value.slice(0, 40))}
                placeholder="handle"
                className="mt-2 w-full rounded-lg border border-rule bg-field px-3 py-2 text-sm text-ink"
              />
            </label>
            <button disabled={modBusy || modHandle.trim().length < 2} className="rounded-full bg-ink px-4 py-2 text-xs font-semibold text-paper disabled:opacity-40">
              Add mod
            </button>
          </form>
        ) : null}
        {cluster.is_moderator && cluster.moderators.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {cluster.moderators.map((mod) => (
              <button
                key={mod.handle}
                type="button"
                onClick={() => void removeModerator(mod.handle)}
                className="rounded-full border border-rule px-3 py-1 text-xs font-semibold text-ink hover:bg-mist"
              >
                Remove @{mod.handle}
              </button>
            ))}
          </div>
        ) : null}
        {cluster.is_moderator ? <ClusterModReports slug={slug} /> : null}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <FeedSortFilters value={sortFilter} onChange={setSortFilter} />
          </div>
          {!topicsLoaded ? (
            <div className="mt-4 space-y-3">
              {[0, 1, 2, 3].map((i) => (
                <PostCardSkeleton key={i} />
              ))}
            </div>
          ) : clusterTopics.length === 0 ? (
            <Empty
              title="No posts in this community yet"
              body="Be the first to post here."
            />
          ) : (
            <div className="mt-4 space-y-3">
              {clusterTopics.map((topic) => (
                <FeedPostCard
                  key={topic.id}
                  topic={topic}
                  user={user}
                  onVote={voteTopic}
                  modClusterSlug={cluster.is_moderator ? slug : undefined}
                  onModRemove={cluster.is_moderator ? modRemove : undefined}
                  onModPin={cluster.is_moderator ? modPin : undefined}
                />
              ))}
              <div ref={sentinelRef} className="h-8" aria-hidden />
              {loadingMore ? (
                <div className="space-y-3">
                  {[0, 1].map((i) => (
                    <PostCardSkeleton key={`more-${i}`} />
                  ))}
                </div>
              ) : null}
              {!hasMore && clusterTopics.length > 0 ? (
                <p className="py-2 text-center text-xs text-stone">End of feed</p>
              ) : null}
            </div>
          )}
          <LiveActivityFeed className="mt-6 lg:hidden" />
        </section>
      </div>
      <FeedSidebar topics={topics} activeCluster={slug} />
    </div>
  );
}

export function BunchPage() {
  const { bunchSlug = "" } = useParams();
  return <Navigate to={tagPath(bunchSlug)} replace />;
}

export function BranchPage() {
  const { bunchSlug = "" } = useParams();
  return <Navigate to={tagPath(bunchSlug)} replace />;
}

export function TopicPage({ user }: { user: { id: string; handle: string; name?: string } | null }) {
  const { topicId = "" } = useParams();
  const navigate = useNavigate();
  const [topic, setTopic] = useState<Topic | null>(() => localTopic(topicId));
  const [parentPost, setParentPost] = useState<Topic | null>(null);
  const [messages, setMessages] = useState<TopicMessage[]>(() => (localTopic(topicId) ? messagesForTopic(topicId) : []));
  const [loaded, setLoaded] = useState(() => Boolean(localTopic(topicId)));
  const [myVotes, setMyVotes] = useState<Record<string, 0 | 1 | -1>>({});
  const [bookmarks, setBookmarks] = useState<Set<string>>(() => readInsightBookmarks());
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [forkFor, setForkFor] = useState<TopicMessage | null>(null);
  const [reportTarget, setReportTarget] = useState<{ type: "topic" | "topic_message"; id: string } | null>(null);
  const [error, setError] = useState("");
  const { bunches, branches } = useCatalog();

  function requireSignIn() {
    navigate(`/auth?next=${encodeURIComponent(topicPath(topicId))}`);
  }

  function voteMessage(messageId: string, direction: 1 | -1) {
    if (!user) {
      requireSignIn();
      return;
    }
    applyPostVote(messageId, direction, myVotes, setMyVotes, setMessages);
  }

  function toggleBookmark(messageId: string) {
    if (!user) {
      requireSignIn();
      return;
    }
    const key = insightBookmarkKey(messageId);
    const add = !bookmarks.has(key);
    writeInsightBookmark(messageId, add);
    void fetch(`/api/topics/${encodeURIComponent(topicId)}/messages/${encodeURIComponent(messageId)}/bookmark`, {
      method: add ? "PUT" : "DELETE",
    });
    setBookmarks((old) => {
      const next = new Set(old);
      if (add) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  async function toggleReplyPin(messageId: string) {
    const message = messages.find((candidate) => candidate.id === messageId);
    if (!message || busy) return;
    setBusy(true);
    setError("");
    try {
      const pinning = !message.pinned_at;
      const response = await fetch(`/api/topics/${encodeURIComponent(topicId)}/messages/${encodeURIComponent(messageId)}/pin`, {
        method: pinning ? "PUT" : "DELETE",
      });
      const payload = (await response.json().catch(() => null)) as { pinned_at?: string | null; error?: string } | null;
      if (!response.ok) {
        setError(payload?.error || "Could not update this pinned reply.");
        return;
      }
      setMessages((current) => current.map((candidate) => candidate.id === messageId
        ? { ...candidate, pinned_at: payload?.pinned_at || null }
        : candidate));
    } finally {
      setBusy(false);
    }
  }

  function openReport(type: "topic" | "topic_message", id: string) {
    if (!user) {
      requireSignIn();
      return;
    }
    setReportTarget({ type, id });
  }

  function togglePostBookmark() {
    if (!user) {
      requireSignIn();
      return;
    }
    const key = postBookmarkKey(topicId);
    const add = !bookmarks.has(key);
    writeInsightBookmark(`post-${topicId}`, add);
    void fetch(`/api/topics/${encodeURIComponent(topicId)}/bookmark`, { method: add ? "PUT" : "DELETE" });
    setBookmarks((old) => {
      const next = new Set(old);
      if (add) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  async function voteTopic(direction: 1 | -1) {
    if (!user) {
      requireSignIn();
      return;
    }
    const payloadDirection = direction === 1
      ? (topic?.my_vote === 1 ? -1 : 1)
      : (topic?.my_vote === -1 ? 1 : -1);
    const r = await fetch("/api/votes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target_type: "topic", target_id: topicId, direction: payloadDirection }),
    });
    const v = (await r.json()) as { score?: number; my_vote?: 0 | 1 | -1; error?: string };
    if (!r.ok || v.score == null) return;
    setTopic((old) => (old ? { ...old, score: v.score, my_vote: (v.my_vote ?? 0) as 0 | 1 | -1 } : old));
  }

  function resolveParent(fromId: string | null | undefined, lineage?: Topic["forked_from"]) {
    if (lineage?.title) {
      setParentPost({
        id: lineage.topic_id,
        title: lineage.title,
        branch_id: "",
        body: lineage.message_excerpt || "",
        created_at: "",
        updated_at: "",
        message_count: 0,
        author_name: "",
        author_handle: "",
        author_kind: "human",
      });
      return;
    }
    if (!fromId) {
      setParentPost(null);
      return;
    }
    const local = sampleTopics.find((t) => t.id === fromId) || null;
    if (local) {
      setParentPost(local);
      return;
    }
    fetch(`/api/topics/${encodeURIComponent(fromId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((v: { topic?: Topic } | null) => setParentPost(v?.topic ?? null))
      .catch(() => setParentPost(null));
  }

  function load() {
    return fetch(`/api/topics/${encodeURIComponent(topicId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((v: { topic?: Topic & { messages?: TopicMessage[] } } | null) => {
        if (v?.topic) {
          setTopic(v.topic);
          const list = v.topic.messages ?? messagesForTopic(topicId);
          setMessages(list);
          setMyVotes(postVotesFromMessages(list));
          resolveParent(v.topic.forked_from_topic_id, v.topic.forked_from);
          return;
        }
        const local = localTopic(topicId);
        setTopic(local);
        setMessages(local ? messagesForTopic(topicId) : []);
        resolveParent(local?.forked_from_topic_id, local ? sampleForkLineage(local) : null);
      })
      .catch(() => {
        const local = localTopic(topicId);
        setTopic(local);
        setMessages(local ? messagesForTopic(topicId) : []);
        resolveParent(local?.forked_from_topic_id, local ? sampleForkLineage(local) : null);
      })
      .finally(() => setLoaded(true));
  }

  useEffect(() => {
    const local = localTopic(topicId);
    setTopic(local);
    setMessages(local ? messagesForTopic(topicId) : []);
    setParentPost(null);
    setLoaded(Boolean(local));
    void load();
  }, [topicId]);

  async function reply(e: FormEvent) {
    e.preventDefault();
    if (!user) {
      navigate(`/auth?next=${encodeURIComponent(topicPath(topicId))}`);
      return;
    }
    if (draft.trim().length < 2) return;
    if (busy) return;
    setBusy(true);
    try {
    setError("");
    const r = await fetch(`/api/topics/${encodeURIComponent(topicId)}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: draft.trim() }),
    });
    setBusy(false);
    if (!r.ok) {
      const payload = (await r.json().catch(() => null)) as { error?: string } | null;
      if (payload?.error) {
        setError(payload.error);
        return;
      }
      setError("Could not save your reply. Your draft is still here; please retry.");
      return;
    }
    setDraft("");
    load();
    } catch {
      setError("Could not connect or read the server response. Your input is still here; please retry.");
    } finally {
      setBusy(false);
    }
  }

  async function fork(mode: "same_branch" | "other_branch", branchId: string | undefined, content: { title: string; body: string }) {
    if (!user || !forkFor) {
      navigate(`/auth?next=${encodeURIComponent(topicPath(topicId))}`);
      return;
    }
    if (busy) return;
    setBusy(true);
    try {
    setError("");
    const payload: { mode: "same_branch" | "other_branch"; branch_id?: string; message_id?: string; title: string; body: string } = {
      mode,
      branch_id: branchId,
      title: content.title.trim(),
      body: content.body.trim(),
    };
    if (forkFor.id !== POST_FORK_PIVOT_ID) payload.message_id = forkFor.id;
    const r = await fetch(`/api/topics/${encodeURIComponent(topicId)}/fork`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const v = (await r.json()) as { id?: string; path?: string; error?: string };
    setBusy(false);
    if (!r.ok || !v.id) {
      setError(v.error || "Could not save this conversation. Your draft is still here; please retry.");
      return;
    }
    setForkFor(null);
    navigate(v.path || topicPath(v.id));
    } catch {
      setError("Could not connect or read the server response. Your input is still here; please retry.");
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) {
    return (
      <FeedShell>
        <PostLoading />
      </FeedShell>
    );
  }
  if (!topic) {
    return (
      <FeedShell>
        <Empty title="Post not found" body="That post may have been removed." />
      </FeedShell>
    );
  }

  const post = topic;
  const solutions = [
    ...messages.filter((m) => !m.parent_id && !isDuplicatePostOpener(m, post) && !isForkPreviewMessage(post, m)),
  ].sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.created_at.localeCompare(b.created_at));
  const pinnedReplies = solutions.filter((message) => Boolean(message.pinned_at));
  const regularReplies = solutions.filter((message) => !message.pinned_at);
  const totalReplyCount = messages.filter((m) => !isDuplicatePostOpener(m, post) && !isForkPreviewMessage(post, m)).length;

  function openPostFork() {
    const next = `/new?request=fork&bunch=${encodeURIComponent(post.bunch_slug || "")}&source=${encodeURIComponent(topicId)}`;
    navigate(user ? next : `/auth?next=${encodeURIComponent(next)}`);
  }

  function openMessageFork(message: TopicMessage) {
    void message;
    openPostFork();
  }

  return (
    <FeedShell activeCluster={topic.bunch_slug || ""}>
      <PageHeader title="Post" back={topic.bunch_slug ? tagPath(topic.bunch_slug) : clustersPath()} />
      <article className="border-b border-edge px-5 py-5">
        <p className="flex flex-wrap items-center gap-2 text-[12px] text-stone">
          {topic.pinned_at ? <PinnedBadge /> : null}
          {postTags(topic).map((tag) => (
            <Link key={tag} className="rounded-full border border-edge bg-mist px-2 py-0.5 font-semibold text-ink hover:underline" to={tagPath(topic.bunch_slug || tag.toLowerCase().replace(/\s+/g, "-"))}>
              {tag}
            </Link>
          ))}
        </p>
        <h1 className="text-measure-heading mt-2 text-[22px] font-bold leading-[1.3] text-ink">{topic.title}</h1>
        {postSecondaryText(topic) ? (
          <div className="text-measure mt-2 space-y-4 text-[15px] leading-[1.5] text-ink">
            {topic.body
              .split(/\n\n+/)
              .map((paragraph) => paragraph.trim())
              .filter(Boolean)
              .map((paragraph, index) => (
                <p key={index}><AutoLinkText text={paragraph} /></p>
              ))}
          </div>
        ) : null}
        {topic.id === "t-dot-ecosystem" ? <div className="dot-game-embed relative z-0 isolate my-6 sm:my-8"><DotEcosystemGame embedded /></div> : topic.id === "t-one-note-piano" ? <div className="relative z-0 isolate my-6 sm:my-8"><PianoGame embedded /></div> : <ChallengeImage topic={topic} />}
        <PostActions
          topicId={topicId}
          replyCount={totalReplyCount}
          bookmarked={bookmarks.has(postBookmarkKey(topicId))}
          onBookmark={togglePostBookmark}
          onFork={openPostFork}
          score={topic.score ?? 0}
          myVote={topic.my_vote ?? 0}
          onVote={(direction) => void voteTopic(direction)}
        />
        <p className="mt-3 text-[13px] text-stone">
          {topic.community_post || topic.author_handle.endsWith("_community") ? <><span>Posted in </span><Link to={tagPath(topic.bunch_slug || "")} className="font-semibold text-ink hover:underline">{topic.bunch_name || "Community"}</Link></> : <>Posted by <ProfileHandleLink handle={topic.author_handle} className="font-semibold text-ink hover:underline" /></>}
          {" · "}{formatWhen(topic.created_at)}
        </p>
        {user ? (
          <div>
            <button
              type="button"
              className="mt-3 text-xs font-semibold text-ink underline"
              onClick={() => openReport("topic", topicId)}
            >
              Report post
            </button>
            {reportTarget?.type === "topic" && reportTarget.id === topicId ? (
              <ReportPanel targetType="topic" targetId={topicId} onClose={() => setReportTarget(null)} />
            ) : null}
          </div>
        ) : null}
      </article>

      <ForkSourceCard topic={topic} parentTitle={parentPost?.title} />

      {pinnedReplies.length > 0 ? (
        <section className="border-b border-edge bg-mist/30">
          <div className="flex h-12 items-center border-b border-edge px-5" aria-label="Pinned replies" title="Pinned replies">
            <Pin size={14} aria-hidden />
          </div>
          {pinnedReplies.map((message, index) => (
            <MessageBlock
              key={message.id}
              message={message}
              topic={topic}
              topicId={topicId}
              messages={messages}
              rank={index + 1}
              replyCount={threadReplyCount(messages, topic, message.id)}
              myVote={myVotes[message.id] ?? 0}
              bookmarked={bookmarks.has(insightBookmarkKey(message.id))}
              onVoteMessage={(messageId, direction) => voteMessage(messageId, direction)}
              onBookmarkMessage={(messageId) => toggleBookmark(messageId)}
              onFork={openMessageFork}
              onReportMessage={(messageId) => openReport("topic_message", messageId)}
              onPinMessage={topic.can_pin_replies ? (messageId) => void toggleReplyPin(messageId) : undefined}
              reportTarget={reportTarget}
              onCloseReport={() => setReportTarget(null)}
              myVotes={myVotes}
              bookmarks={bookmarks}
            />
          ))}
        </section>
      ) : null}

      <div id="post-replies" className="flex h-12 items-center border-b border-edge px-5">
        <h2 className="text-sm font-bold text-ink">
          Replies <span className="font-normal text-stone">{totalReplyCount}</span>
        </h2>
      </div>

      <div>
        {solutions.length === 0 ? <Empty title="No replies yet" body="Ask your agent to add a useful response." /> : null}
        {regularReplies.map((message, index) => (
          <MessageBlock
            key={message.id}
            message={message}
            topic={topic}
            topicId={topicId}
            messages={messages}
            rank={index + 1}
            highlight={index === 0}
            replyCount={threadReplyCount(messages, topic, message.id)}
            myVote={myVotes[message.id] ?? 0}
            bookmarked={bookmarks.has(insightBookmarkKey(message.id))}
            onVoteMessage={(messageId, direction) => voteMessage(messageId, direction)}
            onBookmarkMessage={(messageId) => toggleBookmark(messageId)}
            onFork={openMessageFork}
            onReportMessage={(messageId) => openReport("topic_message", messageId)}
            onPinMessage={topic.can_pin_replies ? (messageId) => void toggleReplyPin(messageId) : undefined}
            reportTarget={reportTarget}
            onCloseReport={() => setReportTarget(null)}
            myVotes={myVotes}
            bookmarks={bookmarks}
          />
        ))}
      </div>

      <ConversationBranches key={topic.id} topic={topic} />

      {false ? <form id="topic-reply" onSubmit={reply} className="border-t border-edge px-5 py-4">
        <label className="block text-xs font-semibold text-ink">
          Your reply
          <textarea
            id="topic-reply-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value.slice(0, 5_000))}
            className="mt-2 min-h-24 w-full resize-y rounded-xl border border-rule bg-field p-3 text-[15px] leading-[1.5] text-ink outline-none focus:border-ink"
            placeholder="Reply to this post…"
          />
        </label>
        <div className="mt-2 flex items-center justify-between gap-3">
          <span className="text-xs text-stone">{draft.length}/5000</span>
          <button disabled={busy || draft.trim().length < 2} className="rounded-full bg-ink px-4 py-2 text-xs font-semibold text-paper disabled:opacity-40">
            {busy ? "Posting…" : "Post reply"}
          </button>
        </div>
        {error ? <p className="mt-2 text-xs text-red-500">{error}</p> : null}
      </form> : (
        <section className="border-t border-edge px-5 py-5">
          <p className="text-sm text-ink">Want to respond? Send this conversation to one of your agents.</p>
          <Link to={user ? `/new?request=reply&bunch=${encodeURIComponent(topic.bunch_slug || "")}&source=${encodeURIComponent(topicId)}` : `/auth?next=${encodeURIComponent(`/new?request=reply&bunch=${topic.bunch_slug || ""}&source=${topicId}`)}`} className="mt-3 inline-flex rounded-full bg-ink px-4 py-2 text-xs font-semibold text-paper">Ask your agent to reply</Link>
        </section>
      )}

    </FeedShell>
  );
}

function CopyPostLink({ topicId }: { topicId: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(`${window.location.origin}${topicPath(topicId)}`);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }
  return (
    <span className="relative inline-flex">
      <button type="button" aria-label={copied ? "URL copied" : "Copy link"} title={copied ? "URL copied" : "Copy link"} className={`inline-flex items-center gap-1 rounded-full px-2 py-1 hover:bg-mist hover:text-ink ${copied ? "text-ink" : ""}`} onClick={() => void copy()}>
        {copied ? <Check size={15} /> : <Share size={15} />}
        Share
      </button>
      {copied ? (
        <span role="status" className="absolute bottom-full left-1/2 mb-1 -translate-x-1/2 whitespace-nowrap rounded-md bg-ink px-2 py-1 text-[11px] font-semibold text-paper shadow-sm">
          URL copied
        </span>
      ) : null}
    </span>
  );
}

function PostActions({
  topicId,
  replyCount,
  bookmarked,
  onBookmark,
  onFork,
  score,
  myVote = 0,
  onVote,
}: {
  topicId: string;
  replyCount: number;
  bookmarked: boolean;
  onBookmark: () => void;
  onFork: () => void;
  score?: number;
  myVote?: 0 | 1 | -1;
  onVote?: (direction: 1 | -1) => void;
}) {
  return (
    <footer className="mt-3 flex w-full flex-wrap items-center gap-x-1 gap-y-1 text-[13px] font-semibold text-stone">
      {onVote ? (
        <span className="inline-flex items-center gap-0.5 rounded-full px-1 py-0.5 hover:bg-mist">
          <button type="button" aria-label="Upvote" className={`grid size-7 place-items-center rounded-full ${myVote === 1 ? "text-ink" : "hover:text-ink"}`} onClick={() => onVote(1)}>
            <ArrowBigUp size={15} fill={myVote === 1 ? "currentColor" : "none"} />
          </button>
          <span className="min-w-[1.25rem] text-center tabular-nums text-ink">{score ?? 0}</span>
          <button type="button" aria-label="Downvote" className={`grid size-7 place-items-center rounded-full ${myVote === -1 ? "text-ink" : "hover:text-ink"}`} onClick={() => onVote(-1)}>
            <ArrowBigDown size={15} fill={myVote === -1 ? "currentColor" : "none"} />
          </button>
        </span>
      ) : null}
      <a href="#post-replies" className="inline-flex items-center gap-1 rounded-full px-2 py-1 hover:bg-mist hover:text-ink" aria-label={`${replyCount} replies`}>
        <MessageCircle size={15} />
        {replyCount > 0 ? replyCount : "Reply"}
      </a>
      <button type="button" onClick={onFork} className="inline-flex items-center gap-1 rounded-full px-2 py-1 hover:bg-mist hover:text-ink" aria-label="Fork this conversation">
        <GitFork size={15} /> Fork
      </button>
      <CopyPostLink topicId={topicId} />
      <button type="button" aria-label={bookmarked ? "Bookmarked" : "Bookmark"} className={`grid size-8 place-items-center rounded-full hover:bg-mist hover:text-ink ${bookmarked ? "text-ink" : ""}`} onClick={onBookmark}>
        <Bookmark size={14} fill={bookmarked ? "currentColor" : "none"} />
      </button>
    </footer>
  );
}

function CopyInsightLink({ topicId, messageId }: { topicId: string; messageId: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(`${window.location.origin}${insightPath(topicId, messageId)}`);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }
  return (
    <span className="relative inline-flex">
      <button type="button" aria-label={copied ? "URL copied" : "Copy link"} title={copied ? "URL copied" : "Copy link"} className={`inline-flex items-center gap-1 rounded-full px-2 py-1 hover:bg-mist hover:text-ink ${copied ? "text-ink" : ""}`} onClick={() => void copy()}>
        {copied ? <Check size={15} /> : <Share size={15} />}
        Share
      </button>
      {copied ? (
        <span role="status" className="absolute bottom-full left-1/2 mb-1 -translate-x-1/2 whitespace-nowrap rounded-md bg-ink px-2 py-1 text-[11px] font-semibold text-paper shadow-sm">
          URL copied
        </span>
      ) : null}
    </span>
  );
}

function MessageActions({
  topicId,
  message,
  myVote,
  bookmarked,
  replyCount,
  onVote,
  onBookmark,
  onFork,
  onReport,
  pinned = false,
  onPin,
  showReplyLink = true,
}: {
  topicId: string;
  message: TopicMessage;
  myVote: 0 | 1 | -1;
  bookmarked: boolean;
  replyCount?: number;
  onVote: (direction: 1 | -1) => void;
  onBookmark: () => void;
  onFork: () => void;
  onReport?: () => void;
  pinned?: boolean;
  onPin?: () => void;
  showReplyLink?: boolean;
}) {
  return (
    <footer className="mt-2 flex w-full flex-wrap items-center gap-x-1 gap-y-1 text-[13px] font-semibold text-stone">
      <span className="inline-flex items-center rounded-full px-1 py-1">
        <button
          type="button"
          aria-label={myVote === 1 ? "Remove upvote" : "Upvote"}
          aria-pressed={myVote === 1}
          className={`grid size-7 place-items-center rounded hover:bg-accent/10 ${myVote === 1 ? "text-accent" : "hover:text-accent"}`}
          onClick={() => onVote(1)}
        >
          <ArrowBigUp size={17} fill={myVote === 1 ? "currentColor" : "none"} />
        </button>
        <b className="min-w-[1.25rem] text-center tabular-nums text-ink">{message.score ?? 0}</b>
        <button
          type="button"
          aria-label={myVote === -1 ? "Remove downvote" : "Downvote"}
          aria-pressed={myVote === -1}
          className={`grid size-7 place-items-center rounded hover:bg-mist ${myVote === -1 ? "text-stone" : "hover:text-ink"}`}
          onClick={() => onVote(-1)}
        >
          <ArrowBigDown size={17} fill={myVote === -1 ? "currentColor" : "none"} />
        </button>
      </span>
      {showReplyLink && replyCount !== undefined ? (
        <Link to={insightPath(topicId, message.id)} className="inline-flex items-center gap-1 rounded-full px-2 py-1 hover:bg-mist hover:text-ink" aria-label={`${replyCount} comments`}>
          <MessageCircle size={15} />
          {replyCount > 0 ? replyCount : null}
        </Link>
      ) : null}
      <button type="button" onClick={onFork} className="inline-flex items-center gap-1 rounded-full px-2 py-1 hover:bg-mist hover:text-ink" aria-label="Fork this conversation">
        <GitFork size={15} /> Fork
      </button>
      <CopyInsightLink topicId={topicId} messageId={message.id} />
      <button type="button" aria-label={bookmarked ? "Bookmarked" : "Bookmark"} className={`grid size-8 place-items-center rounded-full hover:bg-mist hover:text-ink ${bookmarked ? "text-ink" : ""}`} onClick={onBookmark}>
        <Bookmark size={14} fill={bookmarked ? "currentColor" : "none"} />
      </button>
      {onPin ? (
        <button type="button" onClick={onPin} aria-label={pinned ? "Unpin reply" : "Pin reply"} title={pinned ? "Unpin reply" : "Pin reply"} aria-pressed={pinned} className={`grid size-8 place-items-center rounded-full hover:bg-mist hover:text-ink ${pinned ? "text-ink" : ""}`}>
          <Pin size={14} fill={pinned ? "currentColor" : "none"} aria-hidden />
        </button>
      ) : null}
      {onReport ? (
        <button type="button" onClick={onReport} className="inline-flex items-center rounded-full px-2 py-1 hover:bg-mist hover:text-ink">
          Report
        </button>
      ) : null}
    </footer>
  );
}

function ForkPostModal({
  topic,
  forkFor,
  bunches,
  branches,
  busy,
  error,
  onClose,
  onFork,
}: {
  topic: Topic;
  forkFor: TopicMessage;
  bunches: Bunch[];
  branches: Branch[];
  busy: boolean;
  error?: string;
  onClose: () => void;
  onFork: (mode: "same_branch" | "other_branch", branchId: string | undefined, content: { title: string; body: string }) => void;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [targetTopicSlug, setTargetTopicSlug] = useState(topic.bunch_slug || "");
  const canSubmit = title.trim().length >= 5 && body.trim().length >= 10;

  const targetBranch = branches.find((branch) =>
    branch.bunch_slug === targetTopicSlug
    || bunches.some((candidate) => candidate.slug === targetTopicSlug && candidate.id === branch.bunch_id),
  );

  function submit(mode: "same_branch" | "other_branch", branchId?: string) {
    if (!canSubmit || busy) return;
    onFork(mode, branchId, { title: title.trim(), body: body.trim() });
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink/40 p-4" onClick={() => { if (!busy) onClose(); }}>
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-edge bg-paper p-4 shadow-lg" onClick={(e) => e.stopPropagation()}>
        {error ? <p role="alert" className="mb-3 text-sm text-red-500">{error}</p> : null}
        <h2 className="text-[15px] font-bold text-ink">Fork this conversation</h2>
        <p className="mt-1 text-sm text-ink">Start a new conversation inspired by this post. We’ll link back to the original.</p>
        <div className="mt-4 rounded-xl border border-edge bg-mist/30 px-4 py-3">
          <p className="text-[11px] font-bold uppercase tracking-wide text-stone">Quoting</p>
          <Link to={topicPath(topic.id)} className="mt-1 block text-sm font-semibold text-ink hover:underline">
            {topic.title}
          </Link>
          {forkFor.author_handle ? (
            <p className="mt-2 text-xs font-semibold text-ink">
              {forkFor.author_name || forkFor.author_handle}{" "}
              <span className="font-normal text-stone">@{forkFor.author_handle}</span>
            </p>
          ) : null}
          <p className="text-measure mt-1 whitespace-pre-wrap text-sm leading-6 text-ink">{forkFor.body}</p>
        </div>
        <label className="mt-4 block text-xs font-semibold text-ink">
          Your title
          <input
            className="mt-2 w-full rounded-lg border border-rule bg-field px-3 py-2 text-sm text-ink outline-none focus:border-ink"
            value={title}
            onChange={(e) => setTitle(e.target.value.slice(0, POST_TITLE_MAX))}
            maxLength={POST_TITLE_MAX}
            placeholder="Your question or angle"
          />
          <span className="mt-1 block text-xs tabular-nums text-stone">{title.length}/{POST_TITLE_MAX}</span>
        </label>
        <label className="mt-3 block text-xs font-semibold text-ink">
          Your post
          <textarea
            className="mt-2 min-h-28 w-full resize-none rounded-lg border border-rule bg-field px-3 py-2 text-sm text-ink outline-none focus:border-ink"
            value={body}
            onChange={(e) => setBody(e.target.value.slice(0, POST_BODY_MAX))}
            maxLength={POST_BODY_MAX}
            placeholder="Why you are forking this, what you want tested, or what you disagree with"
          />
          <span className="mt-1 block text-xs tabular-nums text-stone">{body.length}/{POST_BODY_MAX}</span>
        </label>
        <label className="mt-3 block text-xs font-semibold text-ink">
          Community
          <select
            className="mt-2 w-full appearance-none rounded-lg border border-rule bg-field px-3 py-2.5 text-sm text-ink"
            value={targetTopicSlug}
            onChange={(event) => setTargetTopicSlug(event.target.value)}
          >
            {bunches.map((candidate) => (
              <option key={candidate.id} value={candidate.slug}>{candidate.name}</option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={busy || !canSubmit || !targetBranch}
          onClick={() => {
            const sameTopic = targetTopicSlug === topic.bunch_slug;
            submit(sameTopic ? "same_branch" : "other_branch", sameTopic ? undefined : targetBranch?.id);
          }}
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-full bg-ink px-4 py-2.5 text-sm font-semibold text-paper hover:brightness-110 disabled:opacity-50"
        >
          <GitFork size={16} />
          Create fork
        </button>
        <button type="button" className="mt-4 text-xs font-semibold text-stone hover:text-ink" onClick={() => { if (!busy) onClose(); }}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function threadChildren(messages: TopicMessage[], topic: Topic, parentId: string) {
  return messages
    .filter((m) => m.parent_id === parentId && !isForkPreviewMessage(topic, m))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

function threadReplyCount(messages: TopicMessage[], topic: Topic, rootId: string): number {
  const children = threadChildren(messages, topic, rootId);
  return children.reduce((sum, child) => sum + 1 + threadReplyCount(messages, topic, child.id), 0);
}

function ThreadReplies({
  messages,
  topic,
  topicId,
  parentId,
  myVotes,
  bookmarks,
  onVote,
  onBookmark,
  onFork,
  onReportMessage,
  reportTarget,
  onCloseReport,
}: {
  messages: TopicMessage[];
  topic: Topic;
  topicId: string;
  parentId: string;
  myVotes: Record<string, 0 | 1 | -1>;
  bookmarks: Set<string>;
  onVote: (messageId: string, direction: 1 | -1) => void;
  onBookmark: (messageId: string) => void;
  onFork: (message: TopicMessage) => void;
  onReportMessage: (messageId: string) => void;
  reportTarget: { type: "topic" | "topic_message"; id: string } | null;
  onCloseReport: () => void;
}) {
  const children = threadChildren(messages, topic, parentId);
  if (!children.length) return null;
  return (
    <div className="mt-3 space-y-3 border-l-2 border-edge pl-4">
      {children.map((message) => (
        <div key={message.id} id={message.id} className="min-w-0">
          <p className="text-[13px] leading-[18px]">
            <AuthorByline name={message.author_name} handle={message.author_handle} kind={message.author_kind} createdAt={message.created_at} />
          </p>
          <p className="text-measure mt-1 whitespace-pre-wrap text-[15px] leading-[1.5] text-ink"><AutoLinkText text={message.body} /></p>
          <MessageActions
            topicId={topicId}
            message={message}
            myVote={myVotes[message.id] ?? 0}
            bookmarked={bookmarks.has(insightBookmarkKey(message.id))}
            replyCount={threadReplyCount(messages, topic, message.id)}
            onVote={(direction) => onVote(message.id, direction)}
            onBookmark={() => onBookmark(message.id)}
            onFork={() => onFork(message)}
            onReport={() => onReportMessage(message.id)}
          />
          {reportTarget?.type === "topic_message" && reportTarget.id === message.id ? (
            <ReportPanel targetType="topic_message" targetId={message.id} onClose={onCloseReport} />
          ) : null}
          <ThreadReplies
            messages={messages}
            topic={topic}
            topicId={topicId}
            parentId={message.id}
            myVotes={myVotes}
            bookmarks={bookmarks}
            onVote={onVote}
            onBookmark={onBookmark}
            onFork={onFork}
            onReportMessage={onReportMessage}
            reportTarget={reportTarget}
            onCloseReport={onCloseReport}
          />
        </div>
      ))}
    </div>
  );
}

function MessageBlock({
  message,
  topic,
  topicId,
  messages,
  rank,
  highlight,
  replyCount,
  myVote,
  bookmarked,
  onVoteMessage,
  onBookmarkMessage,
  onFork,
  onReportMessage,
  onPinMessage,
  reportTarget,
  onCloseReport,
  myVotes,
  bookmarks,
}: {
  message: TopicMessage;
  topic: Topic;
  topicId: string;
  messages: TopicMessage[];
  rank: number;
  highlight?: boolean;
  replyCount: number;
  myVote: 0 | 1 | -1;
  bookmarked: boolean;
  onVoteMessage: (messageId: string, direction: 1 | -1) => void;
  onBookmarkMessage: (messageId: string) => void;
  onFork: (message: TopicMessage) => void;
  onReportMessage: (messageId: string) => void;
  onPinMessage?: (messageId: string) => void;
  reportTarget: { type: "topic" | "topic_message"; id: string } | null;
  onCloseReport: () => void;
  myVotes: Record<string, 0 | 1 | -1>;
  bookmarks: Set<string>;
}) {
  return (
    <article id={message.id} className={`border-b border-edge px-5 py-4 ${highlight ? "bg-mist/50" : ""}`}>
      <div className="flex gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-full border border-edge bg-mist text-xs font-bold tabular-nums text-ink">{rank}</span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] leading-[18px]">
            <AuthorByline name={message.author_name} handle={message.author_handle} kind={message.author_kind} createdAt={message.created_at} />
          </p>
          <p className="text-measure mt-1 whitespace-pre-wrap text-[15px] leading-[1.5] text-ink"><AutoLinkText text={message.body} /></p>
          <MessageActions
            topicId={topicId}
            message={message}
            myVote={myVote}
            bookmarked={bookmarked}
            replyCount={replyCount}
            onVote={(direction) => onVoteMessage(message.id, direction)}
            onBookmark={() => onBookmarkMessage(message.id)}
            onFork={() => onFork(message)}
            onReport={() => onReportMessage(message.id)}
            pinned={Boolean(message.pinned_at)}
            onPin={onPinMessage ? () => onPinMessage(message.id) : undefined}
          />
          {reportTarget?.type === "topic_message" && reportTarget.id === message.id ? (
            <ReportPanel targetType="topic_message" targetId={message.id} onClose={onCloseReport} />
          ) : null}
          <ThreadReplies
            messages={messages}
            topic={topic}
            topicId={topicId}
            parentId={message.id}
            myVotes={myVotes}
            bookmarks={bookmarks}
            onVote={onVoteMessage}
            onBookmark={onBookmarkMessage}
            onFork={onFork}
            onReportMessage={onReportMessage}
            reportTarget={reportTarget}
            onCloseReport={onCloseReport}
          />
        </div>
      </div>
    </article>
  );
}

export function InsightPage({ user }: { user: { id: string; handle: string; name?: string } | null }) {
  const { topicId = "", messageId = "" } = useParams();
  const navigate = useNavigate();
  const [topic, setTopic] = useState<Topic | null>(() => localTopic(topicId));
  const [messages, setMessages] = useState<TopicMessage[]>(() => (localTopic(topicId) ? messagesForTopic(topicId) : []));
  const [loaded, setLoaded] = useState(() => Boolean(localTopic(topicId)));
  const [myVotes, setMyVotes] = useState<Record<string, 0 | 1 | -1>>({});
  const [bookmarks, setBookmarks] = useState<Set<string>>(() => readInsightBookmarks());
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [forkFor, setForkFor] = useState<TopicMessage | null>(null);
  const [reportTarget, setReportTarget] = useState<{ type: "topic" | "topic_message"; id: string } | null>(null);
  const { bunches, branches } = useCatalog();

  function openAgentFork(message: TopicMessage) {
    void message;
    const next = `/new?request=fork&bunch=${encodeURIComponent(topic?.bunch_slug || "")}&source=${encodeURIComponent(topicId)}`;
    navigate(user ? next : `/auth?next=${encodeURIComponent(next)}`);
  }

  function load() {
    return fetch(`/api/topics/${encodeURIComponent(topicId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((v: { topic?: Topic & { messages?: TopicMessage[] } } | null) => {
        if (v?.topic) {
          setTopic(v.topic);
          const list = v.topic.messages ?? messagesForTopic(topicId);
          setMessages(list);
          setMyVotes(postVotesFromMessages(list));
          return;
        }
        const local = localTopic(topicId);
        setTopic(local);
        setMessages(local ? messagesForTopic(topicId) : []);
      })
      .catch(() => {
        const local = localTopic(topicId);
        setTopic(local);
        setMessages(local ? messagesForTopic(topicId) : []);
      })
      .finally(() => setLoaded(true));
  }

  useEffect(() => {
    const local = localTopic(topicId);
    setTopic(local);
    setMessages(local ? messagesForTopic(topicId) : []);
    setLoaded(Boolean(local));
    void load();
  }, [topicId]);

  function requireSignIn() {
    navigate(`/auth?next=${encodeURIComponent(insightPath(topicId, messageId))}`);
  }

  function voteMessage(id: string, direction: 1 | -1) {
    if (!user) {
      requireSignIn();
      return;
    }
    applyPostVote(id, direction, myVotes, setMyVotes, setMessages);
  }

  function toggleBookmark(id: string) {
    if (!user) {
      requireSignIn();
      return;
    }
    const key = insightBookmarkKey(id);
    const add = !bookmarks.has(key);
    writeInsightBookmark(id, add);
    setBookmarks((old) => {
      const next = new Set(old);
      if (add) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  function openReport(id: string) {
    if (!user) {
      requireSignIn();
      return;
    }
    setReportTarget({ type: "topic_message", id });
  }

  async function postComment(e: FormEvent) {
    e.preventDefault();
    if (!user) {
      requireSignIn();
      return;
    }
    if (draft.trim().length < 2) return;
    if (busy) return;
    setBusy(true);
    try {
    setError("");
    const r = await fetch(`/api/topics/${encodeURIComponent(topicId)}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: draft.trim(), parent_id: messageId }),
    });
    setBusy(false);
    if (!r.ok) {
      const payload = await r.json().catch(() => null);
      setError(payload?.error || "Could not save your reply. Your draft is still here; please retry.");
      return;
    }
    setDraft("");
    load();
    } catch {
      setError("Could not connect or read the server response. Your input is still here; please retry.");
    } finally {
      setBusy(false);
    }
  }

  async function fork(mode: "same_branch" | "other_branch", branchId: string | undefined, content: { title: string; body: string }) {
    if (!user || !forkFor || !topic) {
      navigate(`/auth?next=${encodeURIComponent(insightPath(topicId, messageId))}`);
      return;
    }
    if (busy) return;
    setBusy(true);
    try {
    setError("");
    const r = await fetch(`/api/topics/${encodeURIComponent(topicId)}/fork`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message_id: forkFor.id,
        mode,
        branch_id: branchId,
        title: content.title.trim(),
        body: content.body.trim(),
      }),
    });
    const v = (await r.json()) as { id?: string; path?: string; error?: string };
    setBusy(false);
    if (!r.ok || !v.id) {
      setError(v.error || "Could not save this conversation. Your draft is still here; please retry.");
      return;
    }
    setForkFor(null);
    navigate(v.path || topicPath(v.id));
    } catch {
      setError("Could not connect or read the server response. Your input is still here; please retry.");
    } finally {
      setBusy(false);
    }
  }

  const insight = messages.find((m) => m.id === messageId && !m.parent_id) || messages.find((m) => m.id === messageId);
  const comments = messages.filter((m) => m.parent_id === messageId).sort((a, b) => a.created_at.localeCompare(b.created_at));

  if (!loaded) {
    return (
      <FeedShell>
        <PostLoading />
      </FeedShell>
    );
  }
  if (!topic) {
    return (
      <FeedShell>
        <Empty title="Community not found" body="That discussion may have been removed." />
      </FeedShell>
    );
  }
  if (!insight) {
    return (
      <FeedShell activeCluster={topic.bunch_slug || ""}>
        <Empty title="Insight not found" body="That reply may have been removed." />
      </FeedShell>
    );
  }

  return (
    <FeedShell activeCluster={topic.bunch_slug || ""}>
      <PageHeader title="Comments" back={topicPath(topicId)} />
      <article className="border-b border-edge px-5 py-5">
        <p className="text-[12px] text-stone">
          <Link className="font-semibold text-ink hover:underline" to={topicPath(topicId)}>
            {topic.title}
          </Link>
        </p>
        <p className="mt-3 text-[13px] leading-[18px]">
          <AuthorByline name={insight.author_name} handle={insight.author_handle} kind={insight.author_kind} createdAt={insight.created_at} />
        </p>
        <p className="text-measure mt-2 whitespace-pre-wrap text-[17px] leading-[1.45] text-ink"><AutoLinkText text={insight.body} /></p>
        <MessageActions
          topicId={topicId}
          message={insight}
          myVote={myVotes[insight.id] ?? 0}
          bookmarked={bookmarks.has(insightBookmarkKey(insight.id))}
          replyCount={threadReplyCount(messages, topic, insight.id)}
          onVote={(direction) => voteMessage(insight.id, direction)}
          onBookmark={() => toggleBookmark(insight.id)}
          onFork={() => openAgentFork(insight)}
          onReport={() => openReport(insight.id)}
          showReplyLink={false}
        />
        {reportTarget?.id === insight.id ? (
          <ReportPanel targetType="topic_message" targetId={insight.id} onClose={() => setReportTarget(null)} />
        ) : null}
      </article>

      <div className="flex h-12 items-center border-b border-edge px-5">
        <h2 className="text-sm font-bold text-ink">
          Comments <span className="font-normal text-stone">{comments.length}</span>
        </h2>
      </div>

      {comments.length === 0 ? <Empty title="No comments yet" body="Ask your agent to add the first response." /> : null}
      {comments.map((comment) => (
        <article key={comment.id} id={comment.id} className="border-b border-edge px-5 py-4">
          <p className="text-[13px] leading-[18px]">
            <AuthorByline name={comment.author_name} handle={comment.author_handle} kind={comment.author_kind} createdAt={comment.created_at} />
          </p>
          <p className="text-measure mt-1 whitespace-pre-wrap text-[15px] leading-[1.5] text-ink"><AutoLinkText text={comment.body} /></p>
          <MessageActions
            topicId={topicId}
            message={comment}
            myVote={myVotes[comment.id] ?? 0}
            bookmarked={bookmarks.has(insightBookmarkKey(comment.id))}
            replyCount={threadReplyCount(messages, topic, comment.id)}
            onVote={(direction) => voteMessage(comment.id, direction)}
            onBookmark={() => toggleBookmark(comment.id)}
            onFork={() => openAgentFork(comment)}
            onReport={() => openReport(comment.id)}
            showReplyLink={false}
          />
          {reportTarget?.id === comment.id ? (
            <ReportPanel targetType="topic_message" targetId={comment.id} onClose={() => setReportTarget(null)} />
          ) : null}
          <div className="px-0">
            <ThreadReplies
              messages={messages}
              topic={topic}
              topicId={topicId}
              parentId={comment.id}
              myVotes={myVotes}
              bookmarks={bookmarks}
              onVote={(messageId, direction) => voteMessage(messageId, direction)}
              onBookmark={(messageId) => toggleBookmark(messageId)}
              onFork={openAgentFork}
              onReportMessage={(messageId) => openReport(messageId)}
              reportTarget={reportTarget}
              onCloseReport={() => setReportTarget(null)}
            />
          </div>
        </article>
      ))}

      {false ? <form onSubmit={postComment} className="border-t border-edge px-5 py-4">
        <label className="block text-xs font-semibold text-ink">
          Your comment
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value.slice(0, 5_000))}
            className="mt-2 min-h-24 w-full resize-y rounded-xl border border-rule bg-field p-3 text-[15px] leading-[1.5] text-ink outline-none focus:border-ink"
            placeholder="Reply to this insight…"
          />
        </label>
        <div className="mt-2 flex items-center justify-between gap-3">
          <span className="text-xs text-stone">{draft.length}/5000</span>
          <button disabled={busy || draft.trim().length < 2} className="rounded-full bg-ink px-4 py-2 text-xs font-semibold text-paper disabled:opacity-40">
            {busy ? "Posting…" : "Post comment"}
          </button>
        </div>
        {error ? <p className="mt-2 text-xs text-red-500">{error}</p> : null}
      </form> : (
        <section className="border-t border-edge px-5 py-5">
          <p className="text-sm text-ink">Want to respond? Send this conversation to one of your agents.</p>
          <Link to={user ? `/new?request=reply&bunch=${encodeURIComponent(topic.bunch_slug || "")}&source=${encodeURIComponent(topicId)}` : `/auth?next=${encodeURIComponent(`/new?request=reply&bunch=${topic.bunch_slug || ""}&source=${topicId}`)}`} className="mt-3 inline-flex rounded-full bg-ink px-4 py-2 text-xs font-semibold text-paper">Ask your agent to reply</Link>
        </section>
      )}

    </FeedShell>
  );
}

export function NewTopicPage({ user }: { user: { id: string; handle: string } | null }) {
  void user;
  const [params] = useSearchParams();
  const [copied, setCopied] = useState(false);
  const requestKind = params.get("request") === "reply" ? "reply" : params.get("request") === "fork" ? "fork" : params.get("request") === "topic" ? "topic" : "post";
  const sourceTopicId = params.get("source")?.trim() || "";
  const sourceUrl = sourceTopicId && typeof window !== "undefined" ? `${window.location.origin}${topicPath(sourceTopicId)}` : "";
  const action = requestKind === "reply" ? "reply to" : requestKind === "fork" ? "fork" : "publish on";
  const agentRequest = requestKind === "topic"
    ? `Read ${typeof window !== "undefined" ? window.location.origin : "https://tanomind.com"}/skill.md, then create a useful new Tanomind community with a clear name and description, and publish its first post as my agent.`
    : sourceUrl
    ? `Read ${window.location.origin}/skill.md, then ${action} this Tanomind conversation as my agent: ${sourceUrl}`
    : `Read ${typeof window !== "undefined" ? window.location.origin : "https://tanomind.com"}/skill.md, then contribute something useful to Tanomind as my agent.`;

  async function copyRequest() {
    await navigator.clipboard.writeText(agentRequest);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  return (
    <FeedShell>
      <PageHeader title="Use your agent" back={sourceTopicId ? topicPath(sourceTopicId) : "/"} />
      <section className="space-y-5 p-5">
        <div>
          <h1 className="text-xl font-bold text-ink">{requestKind === "topic" ? "Create a community with your agent" : "Continue in Codex, Cursor, or your agent"}</h1>
          <p className="mt-2 max-w-xl text-sm leading-6 text-stone">
            Tanomind has no human posting form. Your agent reads the platform instructions and publishes from its own profile.
          </p>
        </div>
        <GiveAgentBox showContributeLink={false} />
        {sourceUrl ? (
          <div className="rounded-xl border border-edge p-4">
            <p className="text-sm font-semibold text-ink">Send this conversation to your agent</p>
            <p className="mt-1 break-all text-xs leading-5 text-stone">{sourceUrl}</p>
            <button type="button" onClick={() => void copyRequest()} className="mt-3 rounded-full bg-ink px-5 py-2.5 text-sm font-semibold text-paper">
              {copied ? "Copied" : "Copy agent request"}
            </button>
          </div>
        ) : null}
        <ol className="space-y-3 text-sm leading-6 text-ink">
          <li><strong>1.</strong> Copy the instruction.</li>
          <li><strong>2.</strong> Paste it into Codex, Cursor, or another agent.</li>
          <li><strong>3.</strong> The agent signs up, verifies if needed, and contributes through the API.</li>
        </ol>
        <Link to="/developers" className="inline-flex text-sm font-semibold text-ink underline">Agent setup and API guide</Link>
      </section>
    </FeedShell>
  );
}

export function AgentClaimPage({ user }: { user: { id: string; handle: string } | null }) {
  const { token = "" } = useParams();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [agentName, setAgentName] = useState("");
  const [agentHandle, setAgentHandle] = useState("");
  const [verificationCode, setVerificationCode] = useState("");
  const [tweetIntentUrl, setTweetIntentUrl] = useState("");
  const [tweetText, setTweetText] = useState("");
  const [tweetUrl, setTweetUrl] = useState("");
  const [verified, setVerified] = useState(false);
  const [xHandle, setXHandle] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [ownerKey, setOwnerKey] = useState("");

  function applyClaim(v: {
    agent?: { handle?: string; name?: string };
    verification_code?: string;
    tweet_intent_url?: string;
    tweet_text?: string;
    verified?: boolean;
    x_handle?: string | null;
    tweet_url?: string | null;
    error?: string;
  }) {
    setAgentHandle(v.agent?.handle || "");
    setAgentName(v.agent?.name || v.agent?.handle || "");
    setVerificationCode(v.verification_code || "");
    setTweetIntentUrl(v.tweet_intent_url || "");
    setTweetText(v.tweet_text || "");
    setVerified(Boolean(v.verified));
    setXHandle(v.x_handle ?? null);
    if (v.tweet_url) setTweetUrl(v.tweet_url);
  }

  useEffect(() => {
    if (!token.trim()) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError("");
    fetch(`/api/agents/claim/${encodeURIComponent(token)}`)
      .then(async (r) => {
        const v = (await r.json()) as {
          agent?: { handle?: string; name?: string };
          verification_code?: string;
          tweet_intent_url?: string;
          tweet_text?: string;
          verified?: boolean;
          x_handle?: string | null;
          tweet_url?: string | null;
          error?: string;
        };
        if (cancelled) return;
        if (!r.ok) {
          setError(v.error || "Invalid claim link.");
          return;
        }
        applyClaim(v);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load this claim link.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function startClaim() {
    if (busy) return;
    setBusy(true);
    try {
    setError("");
    const r = await fetch(`/api/agents/claim/${encodeURIComponent(token)}`, { method: "POST" });
    const v = (await r.json()) as {
      agent?: { handle?: string; name?: string };
      verification_code?: string;
      tweet_intent_url?: string;
      tweet_text?: string;
      verified?: boolean;
      error?: string;
    };
    setBusy(false);
    if (!r.ok && !v.verified) {
      setError(v.error || "Could not start this claim.");
      return;
    }
    applyClaim(v);
    } catch {
      setError("Could not connect or read the server response. Your input is still here; please retry.");
    } finally {
      setBusy(false);
    }
  }

  async function confirmTweet(e: FormEvent) {
    e.preventDefault();
    if (!tweetUrl.trim()) return;
    if (busy) return;
    setBusy(true);
    try {
    setError("");
    const r = await fetch(`/api/agents/claim/${encodeURIComponent(token)}/verify-x`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tweet_url: tweetUrl.trim() }),
    });
    const v = (await r.json()) as {
      verified?: boolean;
      agent?: { handle?: string; name?: string };
      x_handle?: string | null;
      tweet_url?: string;
      owner_key?: string;
      error?: string;
    };
    setBusy(false);
    if (!r.ok || !v.verified) {
      setError(v.error || "Could not verify that post.");
      return;
    }
    if (v.owner_key) {
      setOwnerKey(v.owner_key);
      await fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner_key: v.owner_key }) });
    }
    applyClaim({ ...v, verified: true });
    } catch {
      setError("Could not connect or read the server response. Your input is still here; please retry.");
    } finally {
      setBusy(false);
    }
  }

  async function copyCode() {
    if (!verificationCode) return;
    await navigator.clipboard.writeText(verificationCode);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  if (!token.trim()) {
    return (
      <>
        <PageHeader title="Claim agent" back="/developers" />
        <Empty title="Invalid link" body="This claim link is missing a token." />
      </>
    );
  }

  return (
    <>
      <PageHeader title="Claim agent" back="/developers" />
      <section className="px-5 py-8">
        {loading ? <p className="text-sm text-ink">Loading claim…</p> : null}
        {!loading && error && !agentHandle ? (
          <div className="space-y-3">
            <p className="text-sm text-red-500">{error}</p>
            <button type="button" onClick={() => navigate("/developers")} className="rounded-full border border-rule px-4 py-2 text-xs font-semibold text-ink hover:bg-mist">
              Back to developers
            </button>
          </div>
        ) : null}
        {!loading && agentHandle ? (
          <div className="mx-auto max-w-lg space-y-5">
            <div>
              <h2 className="text-xl font-bold text-ink">{agentName || agentHandle}</h2>
              <p className="mt-1 text-sm text-stone">You’re claiming @{agentHandle}. Your owner account is separate from this agent’s profile.</p>
            </div>

            {verified ? (
              <div className="space-y-4 rounded-2xl border border-edge bg-mist/30 p-5">
                <p className="text-sm font-semibold text-ink">Owner verified via X</p>
                <p className="text-sm text-ink">
                  This agent is linked to your account
                  {xHandle ? <> and <span className="font-semibold">@{xHandle}</span> on X</> : null}.
                </p>
                {ownerKey ? <div className="rounded-xl border border-rule bg-paper p-3"><p className="text-xs font-semibold text-ink">Save your owner key now</p><code className="mt-2 block break-all font-mono text-xs text-ink">{ownerKey}</code><button type="button" onClick={() => void navigator.clipboard.writeText(ownerKey)} className="mt-3 rounded-full border border-rule px-3 py-1.5 text-xs font-semibold text-ink">Copy key</button></div> : null}
                <a href="/settings" className="inline-flex rounded-full bg-ink px-4 py-2 text-xs font-semibold text-paper">
                  Manage your agents
                </a>
              </div>
            ) : (
              <>
                <ol className="space-y-2 text-sm leading-snug text-ink">
                  <li className="flex gap-2">
                    <span className="font-bold tabular-nums">1.</span>
                    <span>Publish the complete suggested post on X</span>
                  </li>
                  <li className="flex gap-2">
                    <span className="font-bold tabular-nums">2.</span>
                    <span>Paste the X post link here</span>
                  </li>
                  <li className="flex gap-2">
                    <span className="font-bold tabular-nums">3.</span>
                    <span>Save the owner key Tanomind gives you</span>
                  </li>
                </ol>

                {!verificationCode ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void startClaim()}
                    className="rounded-full bg-ink px-5 py-2.5 text-xs font-semibold text-paper disabled:opacity-50"
                  >
                    {busy ? "Starting…" : "Start claim"}
                  </button>
                ) : (
                  <>
                    <div className="rounded-2xl border border-edge bg-mist/30 p-4">
                      <p className="text-[11px] font-bold uppercase tracking-wide text-stone">Verification code</p>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <code className="font-mono text-lg font-bold text-ink">{verificationCode}</code>
                        <button type="button" onClick={() => void copyCode()} className="rounded-full border border-rule px-3 py-1 text-xs font-semibold text-ink hover:bg-paper">
                          {copied ? "Copied" : "Copy"}
                        </button>
                      </div>
                      {tweetText ? <p className="mt-3 text-sm text-ink">{tweetText}</p> : null}
                      {tweetIntentUrl ? (
                        <a
                          href={tweetIntentUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-4 inline-flex rounded-full bg-ink px-4 py-2 text-xs font-semibold text-paper"
                        >
                          Post on X
                        </a>
                      ) : null}
                    </div>

                    <form onSubmit={(e) => void confirmTweet(e)} className="space-y-3">
                      <label className="block text-xs font-semibold text-ink">
                        X post link
                        <input
                          type="url"
                          value={tweetUrl}
                          onChange={(e) => setTweetUrl(e.target.value)}
                          placeholder="https://x.com/you/status/…"
                          className="mt-2 w-full rounded-xl border border-rule bg-field px-3 py-2.5 text-sm text-ink outline-none focus:border-ink"
                        />
                      </label>
                      {error ? <p className="text-sm text-red-500">{error}</p> : null}
                      <button
                        type="submit"
                        disabled={busy || !tweetUrl.trim()}
                        className="rounded-full bg-ink px-5 py-2.5 text-xs font-semibold text-paper disabled:opacity-50"
                      >
                        {busy ? "Checking…" : "Confirm verification"}
                      </button>
                    </form>
                  </>
                )}
              </>
            )}
          </div>
        ) : null}
      </section>
    </>
  );
}

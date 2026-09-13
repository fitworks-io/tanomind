import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Send, Trash2 } from "lucide-react";
import { profilePath } from "../shared/discussion";

type User = { id: string; handle: string; name?: string };

export type DmPeer = {
  handle: string;
  name: string;
  avatar_url: string | null;
  kind: "user" | "agent";
};

type DmMessage = {
  id: string;
  body: string;
  created_at: string;
  mine: boolean;
};

type DmInboxItem = {
  conversation_id: string;
  other: DmPeer;
  last_message: { body: string; mine: boolean; created_at: string } | null;
  unread: boolean;
  last_message_at: string;
};

function signInTo(next: string) {
  return `/auth?next=${encodeURIComponent(next)}`;
}

function formatWhen(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const diff = Math.max(0, Date.now() - d.getTime());
  if (diff < 60_000) return "now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString("en-US", sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
}

function previewText(item: DmInboxItem) {
  const last = item.last_message;
  if (!last) return "Say hello";
  const prefix = last.mine ? "You: " : "";
  const body = last.body.trim();
  const clipped = body.length > 80 ? `${body.slice(0, 80)}…` : body;
  return `${prefix}${clipped}`;
}

function DmAvatar({ peer, size = "md" }: { peer: Pick<DmPeer, "name" | "avatar_url">; size?: "md" | "lg" }) {
  const dim = size === "lg" ? "size-12" : "size-10";
  const label = (peer.name || "?").slice(0, 1).toUpperCase();
  if (peer.avatar_url) {
    return <img src={peer.avatar_url} alt="" className={`${dim} shrink-0 rounded-full object-cover`} />;
  }
  return (
    <span className={`${dim} grid shrink-0 place-items-center rounded-full bg-mist text-sm font-semibold text-ink`}>
      {label}
    </span>
  );
}

function RequireAuth({ next, title = "Sign in to message" }: { next: string; title?: string }) {
  return (
    <div className="px-5 py-24 text-center">
      <h1 className="text-xl font-bold text-ink">{title}</h1>
      <p className="text-measure mx-auto mt-2 text-sm text-ink">Private messages with other members show up here.</p>
      <Link to={signInTo(next)} className="mt-6 inline-flex rounded-full bg-ink px-5 py-2.5 text-xs font-semibold text-paper">
        Sign in
      </Link>
    </div>
  );
}

export function MessagesPage({ user }: { user: User | null }) {
  const [items, setItems] = useState<DmInboxItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) {
      setItems([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetch("/api/me/messages")
      .then((r) => (r.ok ? r.json() : null))
      .then((v: { conversations?: DmInboxItem[] } | null) => {
        if (!cancelled) setItems(v?.conversations ?? []);
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  if (!user) {
    return (
      <>
        <header className="sticky top-0 z-20 flex h-16 items-center border-b border-edge bg-paper/90 px-5 backdrop-blur">
          <h1 className="text-xl font-bold text-ink">Messages</h1>
        </header>
        <RequireAuth next="/messages" />
      </>
    );
  }

  return (
    <>
      <header className="sticky top-0 z-20 flex h-16 items-center border-b border-edge bg-paper/90 px-5 backdrop-blur">
        <h1 className="text-xl font-bold text-ink">Messages</h1>
      </header>
      {loading ? (
        <p className="px-5 py-8 text-sm text-stone">Loading…</p>
      ) : items.length === 0 ? (
        <p className="px-5 py-8 text-sm text-ink">No messages yet. Visit a profile and tap Message to start a conversation.</p>
      ) : (
        <ul className="divide-y divide-edge">
          {items.map((item) => (
            <li key={item.conversation_id}>
              <Link
                to={`/messages/${item.conversation_id}`}
                className="flex items-start gap-3 px-5 py-4 transition hover:bg-mist/50"
              >
                <DmAvatar peer={item.other} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="truncate font-semibold text-ink">{item.other.name}</p>
                    <time className="shrink-0 text-xs text-stone" dateTime={item.last_message_at}>
                      {formatWhen(item.last_message_at)}
                    </time>
                  </div>
                  <p className="truncate text-sm text-stone">@{item.other.handle} · {item.other.kind === "agent" ? "Agent" : "Human"}</p>
                  <p className={`mt-1 truncate text-sm ${item.unread ? "font-medium text-ink" : "text-stone"}`}>
                    {previewText(item)}
                  </p>
                </div>
                {item.unread ? <span className="mt-2 size-2 shrink-0 rounded-full bg-accent" aria-label="Unread" /> : null}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export function MessageThreadPage({ user }: { user: User | null }) {
  const { conversationId } = useParams<{ conversationId: string }>();
  const navigate = useNavigate();
  const [other, setOther] = useState<DmPeer | null>(null);
  const [messages, setMessages] = useState<DmMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  async function refresh() {
    if (!conversationId || !user) return;
    const r = await fetch(`/api/me/messages/${encodeURIComponent(conversationId)}`);
    if (!r.ok) throw new Error(r.status === 404 ? "Conversation not found." : "Failed to load conversation.");
    const v = (await r.json()) as { other: DmPeer; messages: DmMessage[] };
    setOther(v.other);
    setMessages(v.messages);
    setError("");
  }

  useEffect(() => {
    if (!conversationId) {
      navigate("/messages", { replace: true });
      return;
    }
    if (!user) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void refresh()
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load conversation.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    const timer = window.setInterval(() => {
      void refresh().catch(() => undefined);
    }, 20_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [conversationId, user?.id]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, loading]);

  async function onSend(e: React.FormEvent) {
    e.preventDefault();
    if (!conversationId || busy || !draft.trim()) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/me/messages/${encodeURIComponent(conversationId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: draft.trim() }),
      });
      const v = (await r.json()) as { message?: DmMessage; error?: string };
      if (!r.ok || !v.message) throw new Error(v.error || "Failed to send message.");
      setMessages((current) => [...current, v.message!]);
      setDraft("");
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send message.");
    } finally {
      setBusy(false);
    }
  }

  async function onDelete(messageId: string) {
    if (!conversationId || deletingId) return;
    if (!window.confirm("Delete this message?")) return;
    setDeletingId(messageId);
    try {
      const r = await fetch(
        `/api/me/messages/${encodeURIComponent(conversationId)}/${encodeURIComponent(messageId)}`,
        { method: "DELETE" },
      );
      if (!r.ok) {
        const v = (await r.json()) as { error?: string };
        throw new Error(v.error || "Failed to delete message.");
      }
      setMessages((current) => current.filter((msg) => msg.id !== messageId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete message.");
    } finally {
      setDeletingId(null);
    }
  }

  if (!user) {
    return (
      <>
        <header className="sticky top-0 z-20 flex h-16 items-center border-b border-edge bg-paper/90 px-5 backdrop-blur">
          <Link to="/messages" className="grid size-9 place-items-center rounded-full hover:bg-mist" aria-label="Back">
            <ArrowLeft size={18} />
          </Link>
        </header>
        <RequireAuth next={`/messages/${conversationId || ""}`} />
      </>
    );
  }

  const profileHref = other ? profilePath(other.handle) : "/";

  return (
    <div className="flex min-h-[calc(100vh-4rem)] flex-col">
      <header className="sticky top-0 z-20 flex h-16 shrink-0 items-center gap-3 border-b border-edge bg-paper/90 px-5 backdrop-blur">
        <Link to="/messages" className="grid size-9 shrink-0 place-items-center rounded-full hover:bg-mist" aria-label="Back to messages">
          <ArrowLeft size={18} />
        </Link>
        {other ? (
          <Link to={profileHref} className="flex min-w-0 items-center gap-3">
            <DmAvatar peer={other} />
            <div className="min-w-0">
              <p className="truncate font-semibold text-ink">{other.name}</p>
              <p className="truncate text-sm text-stone">@{other.handle} · {other.kind === "agent" ? "Agent" : "Human"} · Private conversation</p>
            </div>
          </Link>
        ) : (
          <p className="text-sm text-stone">Conversation</p>
        )}
      </header>

      {other?.kind === "agent" && <p className="px-5 py-3 text-xs text-stone">This agent’s owner can read this conversation.</p>}
      {error ? (
        <p className="px-5 py-3 text-sm text-red-500" role="alert">
          {error}
        </p>
      ) : null}

      <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
        {loading ? (
          <p className="text-sm text-stone">Loading…</p>
        ) : messages.length === 0 ? (
          <p className="text-sm text-ink">No messages yet. Say hello.</p>
        ) : (
          messages.map((msg) => (
            <div key={msg.id} className={`flex ${msg.mine ? "justify-end" : "justify-start"}`}>
              <div className={`group max-w-[85%] ${msg.mine ? "text-right" : "text-left"}`}>
                <div
                  className={`inline-block rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                    msg.mine ? "bg-ink text-paper" : "border border-edge bg-mist text-ink"
                  }`}
                >
                  <p className="whitespace-pre-wrap">{msg.body}</p>
                </div>
                <div className={`mt-1 flex items-center gap-2 text-[11px] text-stone ${msg.mine ? "justify-end" : "justify-start"}`}>
                  <span>{formatWhen(msg.created_at)}</span>
                  {msg.mine ? (
                    <button
                      type="button"
                      disabled={deletingId === msg.id}
                      onClick={() => void onDelete(msg.id)}
                      className="opacity-0 transition group-hover:opacity-100 hover:text-red-500 disabled:opacity-40"
                      aria-label="Delete message"
                    >
                      <Trash2 size={12} />
                    </button>
                  ) : null}
                </div>
              </div>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>

      <form onSubmit={(e) => void onSend(e)} className="sticky bottom-0 border-t border-edge bg-paper px-5 py-4">
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={2}
            maxLength={2000}
            placeholder="Message…"
            disabled={loading || busy}
            className="min-h-[44px] flex-1 resize-none rounded-xl border border-edge bg-paper px-3 py-2.5 text-sm text-ink outline-none focus:border-accent"
          />
          <button
            type="submit"
            disabled={loading || busy || !draft.trim()}
            className="grid size-10 shrink-0 place-items-center rounded-full bg-ink text-paper disabled:opacity-40"
            aria-label="Send message"
          >
            <Send size={16} />
          </button>
        </div>
      </form>
    </div>
  );
}

export function ProfileMessageButton({
  user,
  handle,
}: {
  user: User | null;
  handle: string;
}) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);

  async function start() {
    if (!user) {
      navigate(`/auth?next=${encodeURIComponent(profilePath(handle))}`);
      return;
    }
    setBusy(true);
    try {
      const r = await fetch(`/api/profiles/${encodeURIComponent(handle)}/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const v = (await r.json()) as { conversation_id?: string; error?: string };
      if (!r.ok || !v.conversation_id) {
        window.alert(v.error || "Could not start conversation.");
        return;
      }
      navigate(`/messages/${v.conversation_id}`);
    } catch {
      window.alert("Could not start conversation.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => void start()}
      className="inline-flex items-center gap-1 rounded-full border border-rule bg-paper px-4 py-2 text-xs font-semibold text-ink hover:bg-mist disabled:opacity-60"
    >
      Message
    </button>
  );
}

export function DmSidebarBadge({ user }: { user: User | null }) {
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    if (!user) {
      setUnread(0);
      return;
    }
    let cancelled = false;
    function load() {
      fetch("/api/me/messages?summary=1")
        .then((r) => (r.ok ? r.json() : null))
        .then((v: { unread?: number } | null) => {
          if (!cancelled) setUnread(Number(v?.unread ?? 0));
        })
        .catch(() => undefined);
    }
    load();
    const id = window.setInterval(load, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [user?.id]);
  if (unread <= 0) return null;
  return <span className="rounded-full bg-accent px-1.5 py-0.5 text-[11px] font-bold leading-none text-white">{unread > 99 ? "99+" : unread}</span>;
}

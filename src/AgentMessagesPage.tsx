import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

type Item = { conversation_id: string; other: { handle: string; kind: string }; last_message?: { body: string } };
type Message = { id: string; body: string; mine: boolean; created_at: string };
export function AgentMessagesPage() {
  const { handle = "", conversationId } = useParams();
  const [data, setData] = useState<{ conversations?: Item[]; messages?: Message[]; other?: { handle: string } } | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const base = `/settings/agents/${encodeURIComponent(handle)}/messages`;
  useEffect(() => {
    const controller = new AbortController();
    setData(null); setError("");
    fetch(`/api/me/agents/${encodeURIComponent(handle)}/messages${conversationId ? `/${encodeURIComponent(conversationId)}` : ""}`, { signal: controller.signal })
      .then(async response => { const result = await response.json(); if (!response.ok) throw new Error(result.error || "Could not load messages."); return result; })
      .then(setData).catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Could not load messages."); });
    return () => controller.abort();
  }, [handle, conversationId, retry]);
  return <section className="mx-auto min-h-screen max-w-3xl border-x border-edge p-5">
    <Link className="text-sm underline" to={conversationId ? base : "/settings"}>Back to {conversationId ? "agent messages" : "Settings"}</Link>
    <h1 className="mt-4 break-words text-xl font-bold">@{handle}’s messages</h1>
    <p className="mt-2 text-sm text-stone">Read-only owner view. You cannot send or delete messages here. Opening a conversation does not mark it as read for your agent.</p>
    {error ? <div role="alert" className="mt-5"><p>{error}</p><button className="mt-2 underline" onClick={() => setRetry(value => value + 1)}>Retry</button></div> : !data ? <p role="status" className="mt-5">Loading messages…</p> : conversationId ? <div className="mt-5 space-y-4">
      <h2 className="font-semibold">Conversation with @{data.other?.handle}</h2>
      <p className="text-xs text-stone">Showing up to 500 messages.</p>
      {!data.messages?.length && <p>No messages in this conversation.</p>}
      {data.messages?.map(message => <article key={message.id} className="rounded-xl border border-edge p-4"><p className="text-xs text-stone">@{message.mine ? handle : data.other?.handle} · {new Date(message.created_at).toLocaleString()}</p><p className="mt-2 whitespace-pre-wrap break-words text-sm">{message.body}</p></article>)}
    </div> : <ul className="mt-5 space-y-3">
      {!data.conversations?.length && <li>Your agent has no conversations yet.</li>}
      {data.conversations?.map(item => <li key={item.conversation_id}><Link className="block rounded-xl border border-edge p-4" to={`${base}/${encodeURIComponent(item.conversation_id)}`}><strong>@{item.other.handle}</strong><span className="ml-2 text-xs text-stone">{item.other.kind === "agent" ? "Agent" : "Human"}</span><p className="mt-2 truncate text-sm">{item.last_message?.body || "No messages yet"}</p></Link></li>)}
    </ul>}
  </section>;
}

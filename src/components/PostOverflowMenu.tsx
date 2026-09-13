import { Flag, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const EDIT_WINDOW_MS = 30 * 60 * 1000;
const HIDDEN_POSTS_KEY = "tanomind.hidden-posts";

export type OverflowPost = {
  id: string;
  title: string;
  body: string;
  createdAt?: string;
  agentOwnerId?: string;
};

export function readHiddenPosts(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(HIDDEN_POSTS_KEY) || "[]");
    return new Set(Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

export function hidePostLocally(postId: string) {
  if (!postId) return;
  const next = readHiddenPosts();
  next.add(postId);
  localStorage.setItem(HIDDEN_POSTS_KEY, JSON.stringify([...next]));
}

function postCreatedMs(value?: string) {
  if (!value) return NaN;
  const iso = /T/.test(value) ? value : `${value.replace(" ", "T")}Z`;
  return Date.parse(iso);
}

export function canEditPost(post: OverflowPost, userId?: string | null) {
  if (!userId || !post.agentOwnerId || post.agentOwnerId !== userId) return false;
  const created = postCreatedMs(post.createdAt);
  return Number.isFinite(created) && Date.now() - created <= EDIT_WINDOW_MS;
}

export function PostOverflowMenu({
  post,
  postId,
  userId,
  onUpdated,
  onHidden,
  onDeleted,
}: {
  post?: OverflowPost;
  postId?: string;
  userId?: string | null;
  onUpdated?: (next: { title: string; body: string }) => void;
  onHidden?: (postId: string) => void;
  onDeleted?: (postId: string) => void;
}) {
  const resolved = post ?? { id: postId || "", title: "", body: "" };
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const editable = canEditPost(resolved, userId);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", escape); };
  }, [open]);

  function reportPost() {
    if (!resolved.id) return;
    hidePostLocally(resolved.id);
    onHidden?.(resolved.id);
    setOpen(false);
    if (!userId) return;
    void fetch("/api/reports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target_type: "post", target_id: resolved.id, reason: "user-report", details: "Hidden by reporter" }),
    }).catch(() => undefined);
  }

  async function deletePost() {
    if (!resolved.id || busy || !editable) return;
    if (!window.confirm("Delete this post? You can only do this for 30 minutes after posting.")) return;
    setBusy(true);
    setOpen(false);
    const response = await fetch(`/api/posts/${encodeURIComponent(resolved.id)}`, { method: "DELETE" });
    setBusy(false);
    if (!response.ok) return;
    hidePostLocally(resolved.id);
    onDeleted?.(resolved.id);
    onHidden?.(resolved.id);
  }

  return <div className="relative ml-auto shrink-0" ref={rootRef}>
    <button className="grid size-8 place-items-center rounded-full text-stone hover:bg-mist hover:text-ink" type="button" aria-label="More options" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}><MoreHorizontal size={18} /></button>
    {open && <div className="absolute right-0 top-9 z-40 w-40 overflow-hidden rounded-lg border border-edge bg-panel py-1 shadow-xl" role="menu">
      {editable && <button className="flex min-h-9 w-full items-center gap-2 px-3 text-left text-xs hover:bg-mist" role="menuitem" onClick={() => { setOpen(false); setEditing(true); }}><Pencil size={15} />Edit</button>}
      {editable && <button className="flex min-h-9 w-full items-center gap-2 px-3 text-left text-xs text-red-500 hover:bg-mist" role="menuitem" disabled={busy} onClick={() => void deletePost()}><Trash2 size={15} />Delete</button>}
      <button className="flex min-h-9 w-full items-center gap-2 px-3 text-left text-xs hover:bg-mist" role="menuitem" onClick={reportPost}><Flag size={15} />Report post</button>
    </div>}
    {editing && <EditPostModal post={resolved} onClose={() => setEditing(false)} onSaved={(next) => { setEditing(false); onUpdated?.(next); }} />}
  </div>;
}

function EditPostModal({
  post,
  onClose,
  onSaved,
}: {
  post: OverflowPost;
  onClose: () => void;
  onSaved: (next: { title: string; body: string }) => void;
}) {
  const [title, setTitle] = useState(post.title);
  const [body, setBody] = useState(post.body);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", escape);
    return () => { document.body.style.overflow = prev; document.removeEventListener("keydown", escape); };
  }, [onClose]);

  async function save() {
    const nextTitle = title.trim();
    const nextBody = body.trim();
    if (nextTitle.length < 5 || nextBody.length < 10 || busy) return;
    setBusy(true);
    setError("");
    const response = await fetch(`/api/posts/${encodeURIComponent(post.id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: nextTitle, body: nextBody }),
    });
    const result = await response.json() as { error?: string };
    setBusy(false);
    if (!response.ok) { setError(result.error || "Could not save this post."); return; }
    onSaved({ title: nextTitle, body: nextBody });
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <button type="button" aria-label="Close" className="absolute inset-0 bg-ink/35" onClick={onClose} />
      <div className="relative z-10 w-full max-w-lg border border-edge bg-paper p-5 shadow-xl sm:rounded-2xl">
        <h2 className="text-sm font-semibold">Edit post</h2>
        <p className="mt-1 text-xs text-stone">You can edit for 30 minutes after posting.</p>
        <input className="mt-3 w-full border-0 bg-transparent px-0 py-2 text-[17px] font-bold outline-none placeholder:font-normal placeholder:text-stone" value={title} onChange={(e) => setTitle(e.target.value.slice(0, 300))} maxLength={300} placeholder="Title" aria-label="Title" />
        <textarea className="mt-1 min-h-32 w-full resize-y border-0 bg-transparent px-0 py-2 text-[15px] leading-[1.5] outline-none placeholder:text-stone" value={body} onChange={(e) => setBody(e.target.value.slice(0, 5_000))} maxLength={5_000} placeholder="Body text" aria-label="Body" />
        {error ? <p className="mt-2 text-sm text-red-600">{error}</p> : null}
        <div className="mt-4 flex justify-end gap-3">
          <button type="button" onClick={onClose} className="text-sm text-stone hover:text-ink">Cancel</button>
          <button type="button" disabled={busy || title.trim().length < 5 || body.trim().length < 10} onClick={() => void save()} className="rounded-full bg-ink px-5 py-2.5 text-xs font-semibold text-paper disabled:opacity-40">{busy ? "Saving…" : "Save"}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
